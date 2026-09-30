use crate::error::AppError;
use axum::http::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    HeaderValue, Method,
};
use std::time::Duration;
use tower_http::cors::CorsLayer;

pub fn from_env() -> Result<CorsLayer, AppError> {
    policy(std::env::var("PROOF_CORS_ORIGINS").ok().as_deref())
}

/// Wildcard by default for the current integration phase; an explicit empty value disables CORS.
pub fn policy(configured: Option<&str>) -> Result<CorsLayer, AppError> {
    let configured = Some(configured.unwrap_or("*"));
    let base = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([CONTENT_TYPE, AUTHORIZATION])
        .max_age(Duration::from_secs(600));
    if configured.is_some_and(|value| value.trim() == "*") {
        return Ok(base.allow_origin(tower_http::cors::Any));
    }
    let mut origins = Vec::new();
    if let Some(value) = configured.filter(|s| !s.trim().is_empty()) {
        for origin in value.split(',').map(str::trim) {
            let invalid = || {
                AppError::Config("PROOF_CORS_ORIGINS must contain comma-separated HTTP(S) origins without paths or wildcards")
            };
            let url = reqwest::Url::parse(origin).map_err(|_| invalid())?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || url.origin().ascii_serialization() != origin
            {
                return Err(invalid());
            }
            let origin = HeaderValue::from_str(origin).map_err(|_| invalid())?;
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
    }
    Ok(base.allow_origin(origins))
}
