use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
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
            Self::RpcUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let code = match self {
            Self::RpcUnavailable => "rpc_unavailable",
            _ => "internal_error",
        };
        (self.status(), Json(json!({ "error": code }))).into_response()
    }
}
