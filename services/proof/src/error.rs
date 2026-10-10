use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("audit scope not found")]
    AuditNotFound,
    #[error("audit service is unavailable")]
    AuditUnavailable,
    #[error("company administrator required")]
    ForbiddenRole,
    #[error("unwrap request not found")]
    UnwrapNotFound,
    #[error("{0}")]
    UnwrapUnavailable(&'static str),
    #[error("unwrap rate limit exceeded")]
    UnwrapRateLimited,
    #[error("reveal risk requires acknowledgement")]
    RevealRisk(crate::solana::reveal_risk::RevealRisk),
    #[error("run not found")]
    RunNotFound,
    #[error("run storage is unavailable")]
    RunUnavailable,
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
            Self::AuditNotFound => StatusCode::NOT_FOUND,
            Self::AuditUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::ForbiddenRole => StatusCode::FORBIDDEN,
            Self::UnwrapNotFound => StatusCode::NOT_FOUND,
            Self::UnwrapUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::UnwrapRateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::RevealRisk(_) => StatusCode::CONFLICT,
            Self::RunNotFound => StatusCode::NOT_FOUND,
            Self::RunUnavailable => StatusCode::SERVICE_UNAVAILABLE,
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
        if let Self::RevealRisk(risk) = self {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": "reveal_risk_not_acknowledged", "reveal_risk": risk})),
            )
                .into_response();
        }
        if matches!(self, Self::UnwrapRateLimited) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "60")],
                Json(json!({"error": "unwrap_rate_limited"})),
            )
                .into_response();
        }
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
            Self::AuditNotFound => "audit_not_found",
            Self::AuditUnavailable => "audit_unavailable",
            Self::ForbiddenRole => "forbidden_role",
            Self::UnwrapNotFound => "unwrap_not_found",
            Self::UnwrapUnavailable(code) => code,
            Self::RunNotFound => "run_not_found",
            Self::RunUnavailable => "run_storage_unavailable",
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
