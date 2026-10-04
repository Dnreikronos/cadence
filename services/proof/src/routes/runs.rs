use super::{
    runs_confirm, runs_prepare,
    transfer::Service,
    wrap_limits::{self, Limits},
};
use crate::{
    error::AppError,
    run_store::{Run, Status},
    solana::{client::RpcClient, token_wrap::Addresses},
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use solana_address::Address;
use std::{collections::HashSet, str::FromStr, sync::Arc};

#[derive(Clone)]
pub(super) struct RunState {
    pub rpc: Arc<RpcClient>,
    pub service: Option<Arc<Service>>,
    pub limits: Arc<Limits>,
}
impl RunState {
    pub async fn authenticate(
        &self,
        headers: &HeaderMap,
    ) -> Result<(Arc<Service>, String), AppError> {
        let service = self.service.clone().ok_or(AppError::RunUnavailable)?;
        let user = service.auth.user(headers).await?;
        Ok((service, user))
    }
    pub async fn devnet(&self) -> Result<(), AppError> {
        self.rpc
            .require_devnet()
            .await
            .map_err(|error| match error {
                AppError::Conflict(_) => AppError::Conflict("runs_requires_devnet"),
                other => other,
            })
    }
}
pub fn router(rpc: Arc<RpcClient>, service: Option<Arc<Service>>) -> Router {
    let limits = Arc::new(Limits::new());
    Router::new()
        .route("/runs", post(runs_prepare::prepare))
        .route("/runs/{id}", get(status))
        .route("/runs/{id}/confirm", post(runs_confirm::confirm))
        .route("/runs/{id}/retry", post(runs_prepare::retry))
        .layer(DefaultBodyLimit::max(32768))
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            wrap_limits::enforce_transfer,
        ))
        .with_state(RunState {
            rpc,
            service,
            limits,
        })
}
async fn status(
    State(state): State<RunState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RunResponse>, AppError> {
    valid_id(&id)?;
    let (service, user) = state.authenticate(&headers).await?;
    let run = service.runs.get(&user, &id).await?;
    Ok(Json(response(run, false)))
}
pub(super) fn valid_id(id: &str) -> Result<(), AppError> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
    {
        return Err(AppError::BadRequest("invalid_run_id"));
    }
    Ok(())
}
pub(super) fn address(value: &str) -> Result<Address, AppError> {
    Address::from_str(value).map_err(|_| AppError::BadRequest("invalid_account"))
}
#[derive(Serialize)]
pub(super) struct ItemError {
    pub position: i16,
    pub error: &'static str,
}
#[derive(Serialize)]
pub(super) struct RunResponse {
    pub run_id: String,
    company_wallet: String,
    sender: String,
    mint: String,
    status: &'static str,
    transaction_version: u8,
    required_signers: Vec<String>,
    payments: Vec<PaymentResponse>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<ItemError>,
}
#[derive(Serialize)]
struct PaymentResponse {
    position: i16,
    destination: String,
    attempt: i32,
    request_id: Option<String>,
    status: Status,
    signature: Option<String>,
    slot: Option<i64>,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transaction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_valid_block_height: Option<i64>,
}
pub(super) fn response(run: Run, transactions: bool) -> RunResponse {
    let failed = run.payments.iter().any(|p| {
        matches!(
            p.status,
            Status::Failed | Status::Expired | Status::PreparationFailed
        )
    });
    let finalized = run
        .payments
        .iter()
        .filter(|p| p.status == Status::Finalized)
        .count();
    let status = if finalized == run.payments.len() {
        "completed"
    } else if failed {
        "partial_failure"
    } else {
        "prepared"
    };
    RunResponse {
        run_id: run.id,
        required_signers: vec![run.company_wallet.clone()],
        company_wallet: run.company_wallet,
        sender: run.sender,
        mint: Addresses::for_usdc().wrapped_mint.to_string(),
        status,
        transaction_version: 1,
        payments: run
            .payments
            .into_iter()
            .map(|p| PaymentResponse {
                position: p.position,
                destination: p.destination,
                attempt: p.attempt,
                request_id: p.request_id,
                status: p.status,
                signature: p.signature,
                slot: p.slot,
                error: p.error,
                transaction: if transactions && p.status == Status::Prepared {
                    p.transaction
                } else {
                    None
                },
                last_valid_block_height: if transactions && p.status == Status::Prepared {
                    p.last_valid_block_height
                } else {
                    None
                },
            })
            .collect(),
        errors: vec![],
    }
}
pub(super) fn retry_response(
    run: Run,
    rebuilt: &HashSet<i16>,
    errors: Vec<ItemError>,
) -> RunResponse {
    let mut response = response(run, true);
    for p in &mut response.payments {
        if !rebuilt.contains(&p.position) {
            p.transaction = None;
            p.last_valid_block_height = None;
        }
    }
    response.errors = errors;
    response
}
pub(super) fn error_code(error: &AppError) -> &'static str {
    match error {
        AppError::BadRequest(code)
        | AppError::Conflict(code)
        | AppError::TransferUnavailable(code) => code,
        AppError::RpcUnavailable => "rpc_unavailable",
        AppError::RunUnavailable => "run_storage_unavailable",
        AppError::Forbidden => "wallet_access_denied",
        _ => "internal_error",
    }
}
