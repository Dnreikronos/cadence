//! Public wrap receipts only. This client must never be used to access Vault.
use crate::error::AppError;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    Client, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize)]
pub struct PreparedWrap {
    pub id: String,
    pub company_wallet: String,
    pub destination: String,
    pub transaction: String,
    pub last_valid_block_height: u64,
    pub signature: Option<String>,
    pub slot: Option<u64>,
}

pub fn request_id(transaction: &[u8]) -> String {
    format!("{:x}", Sha256::digest(transaction))
}

pub struct WrapStore {
    http: Client,
    table: Url,
}

impl WrapStore {
    pub fn from_env() -> Result<Option<Self>, AppError> {
        Self::parse(|name| std::env::var(name).ok())
    }

    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, AppError> {
        match (
            get("PROOF_SUPABASE_URL"),
            get("PROOF_SUPABASE_API_KEY"),
            get("PROOF_WRAP_SERVICE_JWT"),
        ) {
            (None, None, None) => Ok(None),
            (Some(url), Some(api_key), Some(jwt)) => {
                let url = url
                    .parse()
                    .map_err(|_| AppError::Config("invalid PROOF_SUPABASE_URL"))?;
                Self::new(url, &api_key, &jwt).map(Some)
            }
            _ => Err(AppError::Config(
                "all three proof wrap storage settings are required",
            )),
        }
    }

    pub fn new(mut url: Url, api_key: &str, service_jwt: &str) -> Result<Self, AppError> {
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || service_jwt.trim().is_empty()
            || api_key.trim().is_empty()
        {
            return Err(AppError::Config(
                "wrap storage requires an HTTPS origin (HTTP only on loopback) and separate API key / wrap-role JWT",
            ));
        }
        let mut headers = HeaderMap::new();
        let mut bearer = HeaderValue::from_str(&format!("Bearer {service_jwt}"))
            .map_err(|_| AppError::Config("invalid wrap service key"))?;
        bearer.set_sensitive(true);
        headers.insert(AUTHORIZATION, bearer);
        let mut apikey = HeaderValue::from_str(api_key)
            .map_err(|_| AppError::Config("invalid wrap service key"))?;
        apikey.set_sensitive(true);
        headers.insert("apikey", apikey);
        let http = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AppError::StorageUnavailable)?;
        url.set_path("/rest/v1/wrap_requests");
        Ok(Self { http, table: url })
    }

    pub async fn prepare(&self, record: &PreparedWrap) -> Result<(), AppError> {
        self.http
            .post(self.table.clone())
            .query(&[("on_conflict", "id")])
            .header("Prefer", "resolution=ignore-duplicates")
            .json(record)
            .send()
            .await
            .map_err(|_| AppError::StorageUnavailable)?
            .error_for_status()
            .map_err(|_| AppError::StorageUnavailable)?;
        Ok(())
    }

    pub async fn get(&self, id: &str) -> Result<PreparedWrap, AppError> {
        let rows: Vec<PreparedWrap> = self
            .http
            .get(self.table.clone())
            .query(&[("id", format!("eq.{id}")), ("limit", "1".into())])
            .send()
            .await
            .map_err(|_| AppError::StorageUnavailable)?
            .error_for_status()
            .map_err(|_| AppError::StorageUnavailable)?
            .json()
            .await
            .map_err(|_| AppError::StorageUnavailable)?;
        rows.into_iter().next().ok_or(AppError::NotFound)
    }

    pub async fn confirm(&self, id: &str, signature: &str, slot: u64) -> Result<(), AppError> {
        let rows: Vec<PreparedWrap> = self
            .http
            .patch(self.table.clone())
            .query(&[("id", format!("eq.{id}")), ("signature", "is.null".into())])
            .header("Prefer", "return=representation")
            .json(&json!({ "signature": signature, "slot": slot }))
            .send()
            .await
            .map_err(|_| AppError::StorageUnavailable)?
            .error_for_status()
            .map_err(|_| AppError::StorageUnavailable)?
            .json()
            .await
            .map_err(|_| AppError::StorageUnavailable)?;
        if rows.len() == 1 {
            return Ok(());
        }
        let existing = self.get(id).await?;
        if existing.signature.as_deref() == Some(signature) && existing.slot == Some(slot) {
            Ok(())
        } else {
            Err(AppError::Conflict("wrap_already_confirmed"))
        }
    }
}
