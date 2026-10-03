use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("authentication required")]
    Unauthorized,
    #[error("wallet access denied")]
    Forbidden,
    #[error("transfer request not found")]
    TransferNotFound,
    #[error("{0}")]
    TransferUnavailable(&'static str),
    #[error("transfer rate limit exceeded")]
    TransferRateLimited,
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
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::TransferNotFound => StatusCode::NOT_FOUND,
            Self::TransferUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::TransferRateLimited => StatusCode::TOO_MANY_REQUESTS,
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
        if matches!(self, Self::RateLimited | Self::TransferRateLimited) {
            let code = if matches!(self, Self::TransferRateLimited) {
                "transfer_rate_limited"
            } else {
                "wrap_rate_limited"
            };
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "60")],
                Json(json!({"error": code})),
            )
                .into_response();
        }
        let code = match self {
            Self::Unauthorized => "authentication_required",
            Self::Forbidden => "wallet_access_denied",
            Self::TransferNotFound => "transfer_not_found",
            Self::TransferUnavailable(code) => code,
            Self::BadRequest(code) | Self::Conflict(code) => code,
            Self::NotFound => "wrap_not_found",
            Self::StorageUnavailable => "wrap_storage_unavailable",
            Self::RpcUnavailable => "rpc_unavailable",
            _ => "internal_error",
        };
        (self.status(), Json(json!({ "error": code }))).into_response()
    }
}
