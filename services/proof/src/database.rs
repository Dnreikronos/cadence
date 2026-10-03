use crate::error::AppError;
use std::{ops::Deref, time::Duration};
use tokio_postgres::{config::Host, Client, Config, NoTls};

pub struct Database {
    config: Config,
    role: &'static str,
    plaintext_loopback: bool,
}

pub struct Session {
    client: Client,
    driver: tokio::task::JoinHandle<()>,
}
impl Deref for Session {
    type Target = Client;
    fn deref(&self) -> &Client {
        &self.client
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Database {
    pub fn new(url: &str, role: &'static str) -> Result<Self, AppError> {
        let mut config: Config = url
            .parse()
            .map_err(|_| AppError::Config("invalid proof database configuration"))?;
        let loopback = matches!(config.get_hosts(), [Host::Tcp(host)]
            if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"));
        let plaintext_loopback =
            loopback && config.get_ssl_mode() == tokio_postgres::config::SslMode::Disable;
        if !matches!(config.get_hosts(), [Host::Tcp(host)] if !host.is_empty() && !host.contains('/'))
            || !config.get_hostaddrs().is_empty()
            || config.get_user() != Some(role)
            || config.get_password().is_none_or(|p| p.is_empty())
            || (!loopback && config.get_ssl_mode() == tokio_postgres::config::SslMode::Disable)
        {
            return Err(AppError::Config(
                "proof database requires a dedicated role and verified TLS outside loopback",
            ));
        }
        if !plaintext_loopback {
            config.ssl_mode(tokio_postgres::config::SslMode::Require);
        }
        config.connect_timeout(Duration::from_secs(5));
        Ok(Self {
            config,
            role,
            plaintext_loopback,
        })
    }

    pub async fn connect(&self) -> Result<Session, AppError> {
        let unavailable = || AppError::TransferUnavailable("transfer_storage_unavailable");
        let (client, driver) = if self.plaintext_loopback {
            let (client, connection) = self
                .config
                .connect(NoTls)
                .await
                .map_err(|_| unavailable())?;
            let driver = tokio::spawn(async move {
                let _ = connection.await;
            });
            (client, driver)
        } else {
            let roots =
                rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let tls = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let (client, connection) = self
                .config
                .connect(tokio_postgres_rustls::MakeRustlsConnect::new(tls))
                .await
                .map_err(|_| unavailable())?;
            let driver = tokio::spawn(async move {
                let _ = connection.await;
            });
            (client, driver)
        };
        let session = Session { client, driver };
        session
            .batch_execute("SET statement_timeout = '5s'; SET lock_timeout = '5s'")
            .await
            .map_err(|_| unavailable())?;
        let valid: bool = session
            .query_one("SELECT current_user::text = $1", &[&self.role])
            .await
            .map_err(|_| unavailable())?
            .get(0);
        if !valid {
            return Err(unavailable());
        }
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enforces_role_and_transport_without_echoing_credentials() {
        for url in [
            "postgres://postgres:secret@example.com/db",
            "postgres://cadence_key_service:secret@example.com/db?sslmode=disable",
            "host=/tmp user=cadence_key_service password=secret",
            "host=example.com hostaddr=127.0.0.1 user=cadence_key_service password=secret",
        ] {
            let error = Database::new(url, "cadence_key_service").err().unwrap();
            assert!(!error.to_string().contains("secret"));
        }
        assert!(Database::new(
            "postgres://cadence_key_service:secret@example.com/db",
            "cadence_key_service"
        )
        .is_ok());
        assert!(Database::new(
            "postgres://cadence_key_service:test@127.0.0.1/db?sslmode=disable",
            "cadence_key_service"
        )
        .is_ok());
    }
}
