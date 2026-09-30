use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
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
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::RpcUnavailable | Self::StorageUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let code = match self {
            Self::Conflict(code) => code,
            Self::NotFound => "wrap_not_found",
            Self::StorageUnavailable => "wrap_storage_unavailable",
            Self::RpcUnavailable => "rpc_unavailable",
            _ => "internal_error",
        };
        (self.status(), Json(json!({ "error": code }))).into_response()
    }
}
