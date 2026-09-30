use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("wrap rate limit exceeded")]
    RateLimited,
    #[error("{0}")]
    BadRequest(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("wrap request not found")]
    NotFound,
    #[error("wrap storage is unavailable")]
    StorageUnavailable,
    #[error("invalid configuration: {0}")]
    Config(&'static str),
    #[error("Solana RPC is unavailable")]
    RpcUnavailable,
    #[error("transaction assembly failed: {0}")]
    Transaction(&'static str),
    #[error("server I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::RpcUnavailable | Self::StorageUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        if matches!(self, Self::RateLimited) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "60")],
                Json(json!({"error": "wrap_rate_limited"})),
            )
                .into_response();
        }
        let code = match self {
            Self::BadRequest(code) | Self::Conflict(code) => code,
            Self::NotFound => "wrap_not_found",
            Self::StorageUnavailable => "wrap_storage_unavailable",
            Self::RpcUnavailable => "rpc_unavailable",
            _ => "internal_error",
        };
        (self.status(), Json(json!({ "error": code }))).into_response()
    }
}
