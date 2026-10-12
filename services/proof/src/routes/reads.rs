use super::{
    accounts::{address, AccountState},
    transfer::Service,
    wrap_limits::{self, Limits},
};
use crate::{
    audit::store::{Page, Payment},
    error::AppError,
    keys::vault,
    owner_reads::{self, RosterAmount},
    solana::{accounts, client::RpcClient},
};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Path, Query, State,
    },
    http::HeaderMap,
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use zeroize::Zeroize;

pub fn router(rpc: Arc<RpcClient>, service: Option<Arc<Service>>) -> Router {
    let limits = Arc::new(Limits::new());
    Router::new()
        .route("/me/balance", get(me_balance))
        .route("/company/balance", get(company_balance))
        .route("/me/payments", get(me_payments))
        .route("/company/payments", get(company_payments))
        .route("/company/people/accounts", get(people_accounts))
        .route("/company/people/amounts", get(roster))
        .route(
            "/company/people/{person}/amount",
            put(set_amount).post(set_amount),
        )
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            wrap_limits::enforce_transfer,
        ))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
        .with_state(AccountState {
            rpc,
            service,
            limits,
        })
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct Pagination {
    limit: Option<i32>,
    cursor: Option<String>,
}
impl Pagination {
    pub(super) fn validate(self) -> Result<(i32, Option<String>), AppError> {
        let limit = self.limit.unwrap_or(20);
        if !(1..=100).contains(&limit) {
            return Err(AppError::BadRequest("invalid_request"));
        }
        Ok((limit, self.cursor.as_deref().map(uuid).transpose()?))
    }
}
fn uuid(value: &str) -> Result<String, AppError> {
    uuid::Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil())
        .map(|id| id.to_string())
        .ok_or(AppError::BadRequest("invalid_request"))
}
#[derive(Serialize)]
struct Balance {
    available: String,
    pending: String,
    as_of_slot: u64,
}
impl Drop for Balance {
    fn drop(&mut self) {
        self.available.zeroize();
        self.pending.zeroize();
    }
}
async fn me_balance(
    state: State<AccountState>,
    headers: HeaderMap,
) -> Result<Json<Balance>, AppError> {
    balance(state.0, headers, false).await
}
async fn company_balance(
    state: State<AccountState>,
    headers: HeaderMap,
) -> Result<Json<Balance>, AppError> {
    balance(state.0, headers, true).await
}
async fn balance(
    state: AccountState,
    headers: HeaderMap,
    company: bool,
) -> Result<Json<Balance>, AppError> {
    let (service, user) = state.authenticate(&headers).await?;
    if company {
        service.runs.require_admin(&user).await?;
    } else {
        let session = service.accounts.session().await?;
        let role:bool=session.query_one("SELECT EXISTS (SELECT 1 FROM public.memberships WHERE user_id=$1::text::uuid AND role='recipient')", &[&user]).await.map_err(owner_reads::database_error)?.get(0);
        if !role {
            return Err(AppError::ForbiddenRole);
        }
    }
    let mapping = service
        .accounts
        .mapping(&user)
        .await?
        .ok_or(AppError::Conflict("account_not_registered"))?;
    let wallet = address(&mapping.wallet)?;
    let account = address(&mapping.token_account)?;
    service.store.authorize_wallet(&user, &wallet, None).await?;
    state.rpc.require_devnet().await?;
    let (slot, chain) = state.rpc.finalized_account(&account, None).await?;
    let chain = chain.ok_or(AppError::Conflict("token_account_missing"))?;
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let client = service.keys.connect().await?;
    let (key, aes) = vault::load_account(
        &client,
        &wallet,
        &account,
        &user,
        "read private account balance",
    )
    .await
    .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    drop(client);
    let (available, pending) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let config = accounts::configured(&chain, &wallet, &key.public_key().to_bytes())?;
        accounts::balances(&config, &key, &aes)
    })
    .await
    .map_err(|_| AppError::TransferUnavailable("read_worker_unavailable"))??;
    Ok(Json(Balance {
        available: available.to_string(),
        pending: pending.to_string(),
        as_of_slot: slot,
    }))
}
async fn me_payments(
    state: State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<Pagination>, QueryRejection>,
) -> Result<Json<Page<Payment>>, AppError> {
    payments(state.0, headers, query, "me").await
}
async fn company_payments(
    state: State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<Pagination>, QueryRejection>,
) -> Result<Json<Page<Payment>>, AppError> {
    payments(state.0, headers, query, "company").await
}
async fn payments(
    state: AccountState,
    headers: HeaderMap,
    query: Result<Query<Pagination>, QueryRejection>,
    scope: &str,
) -> Result<Json<Page<Payment>>, AppError> {
    let (limit, cursor) = query
        .map_err(|_| AppError::BadRequest("invalid_request"))?
        .0
        .validate()?;
    let (service, user) = state.authenticate(&headers).await?;
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let client = service.keys.connect().await?;
    Ok(Json(
        owner_reads::payments(&client, &user, scope, limit, cursor.as_deref(), permit).await?,
    ))
}
async fn roster(
    State(state): State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<Pagination>, QueryRejection>,
) -> Result<Json<Page<RosterAmount>>, AppError> {
    let (limit, cursor) = query
        .map_err(|_| AppError::BadRequest("invalid_request"))?
        .0
        .validate()?;
    let (service, user) = state.authenticate(&headers).await?;
    service.runs.require_admin(&user).await?;
    let _permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let client = service.keys.connect().await?;
    Ok(Json(
        owner_reads::roster(&client, &user, limit, cursor.as_deref()).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AmountRequest {
    amount: String,
}
impl Drop for AmountRequest {
    fn drop(&mut self) {
        self.amount.zeroize();
    }
}
async fn set_amount(
    State(state): State<AccountState>,
    headers: HeaderMap,
    Path(person): Path<String>,
    body: Result<Json<AmountRequest>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    let person = uuid(&person)?;
    let Json(body) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    crate::solana::wrap::amount(&body.amount)?;
    let (service, user) = state.authenticate(&headers).await?;
    service.runs.require_admin(&user).await?;
    let _permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let client = service.keys.connect().await?;
    owner_reads::set_amount(&client, &user, &person, &body.amount).await?;
    Ok(Json(json!({"status":"saved"})))
}
async fn people_accounts(
    State(state): State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<Pagination>, QueryRejection>,
) -> Result<Json<Value>, AppError> {
    let (limit, cursor) = query
        .map_err(|_| AppError::BadRequest("invalid_request"))?
        .0
        .validate()?;
    let (service, user) = state.authenticate(&headers).await?;
    let company = service.runs.require_admin(&user).await?;
    let client = service.accounts.session().await?;
    let mut rows=client.query("SELECT p.id::text,CASE WHEN a.ready THEN a.token_account END AS token_account FROM public.people p LEFT JOIN public.proof_accounts a ON a.user_id=p.user_id WHERE p.company_id=$1::text::uuid AND p.status<>'removed' AND ($2::text IS NULL OR p.id>$2::text::uuid) ORDER BY p.id LIMIT $3::integer", &[&company,&cursor,&(limit+1)]).await.map_err(owner_reads::database_error)?;
    let next = if rows.len() > limit as usize {
        rows.pop();
        rows.last().map(|r| r.get::<_, String>(0))
    } else {
        None
    };
    let items=rows.into_iter().map(|r|json!({"person_id":r.get::<_,String>(0),"token_account":r.get::<_,Option<String>>(1)})).collect::<Vec<_>>();
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
