use crate::error::AppError;
use axum::http::{header::AUTHORIZATION, HeaderMap};
use reqwest::{header::HeaderValue, Url};
use serde::Deserialize;
use solana_address::Address;
use std::time::Duration;

pub struct SupabaseAuth {
    http: reqwest::Client,
    user_url: Url,
}

pub fn wallet_link_message(user: &str, wallet: &Address) -> Vec<u8> {
    format!("Cadence wallet association\nuser:{user}\nwallet:{wallet}").into_bytes()
}

impl SupabaseAuth {
    pub fn new(mut origin: Url, api_key: &str) -> Result<Self, AppError> {
        let loopback = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if origin.host_str().is_none()
            || (origin.scheme() != "https" && !(origin.scheme() == "http" && loopback))
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || api_key.trim().is_empty()
        {
            return Err(AppError::Config("invalid Supabase authentication origin"));
        }
        let mut key = HeaderValue::from_str(api_key)
            .map_err(|_| AppError::Config("invalid Supabase API key"))?;
        key.set_sensitive(true);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("apikey", key);
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AppError::TransferUnavailable("auth_unavailable"))?;
        origin.set_path("/auth/v1/user");
        Ok(Self {
            http,
            user_url: origin,
        })
    }

    pub async fn user(&self, headers: &HeaderMap) -> Result<String, AppError> {
        let token = headers
            .get(AUTHORIZATION)
            .and_then(|header| header.to_str().ok())
            .and_then(|header| header.strip_prefix("Bearer "))
            .filter(|token| !token.is_empty() && token.len() <= 8192)
            .ok_or(AppError::Unauthorized)?;
        let response = self
            .http
            .get(self.user_url.clone())
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| AppError::TransferUnavailable("auth_unavailable"))?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(AppError::Unauthorized);
        }
        #[derive(Deserialize)]
        struct User {
            id: String,
        }
        let user: User = response
            .error_for_status()
            .map_err(|_| AppError::TransferUnavailable("auth_unavailable"))?
            .json()
            .await
            .map_err(|_| AppError::TransferUnavailable("auth_unavailable"))?;
        let id = uuid::Uuid::parse_str(&user.id)
            .map_err(|_| AppError::TransferUnavailable("auth_unavailable"))?;
        if id.is_nil() {
            return Err(AppError::TransferUnavailable("auth_unavailable"));
        }
        Ok(id.to_string())
    }
}
