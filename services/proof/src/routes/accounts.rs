use super::{
    transfer::Service,
    wrap_limits::{self, Limits},
};
use crate::{
    account_store::{Mapping, PreparedAccount},
    error::AppError,
    keys::{elgamal::ViewingKey, vault},
    solana::{accounts, client::RpcClient, token_wrap::Addresses, v1, wrap},
    wrap_store::request_id,
};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Query, State,
    },
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_address::Address;
use solana_signature::Signature;
use std::{str::FromStr, sync::Arc};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone)]
pub(super) struct AccountState {
    pub rpc: Arc<RpcClient>,
    pub service: Option<Arc<Service>>,
    pub limits: Arc<Limits>,
}
impl AccountState {
    pub async fn authenticate(
        &self,
        headers: &HeaderMap,
    ) -> Result<(Arc<Service>, String), AppError> {
        let service = self
            .service
            .clone()
            .ok_or(AppError::TransferUnavailable("accounts_unavailable"))?;
        let user = service.auth.user(headers).await?;
        let session = service.accounts.session().await?;
        let member = session
            .query_opt(
                "SELECT role::text FROM public.memberships WHERE user_id=$1::text::uuid",
                &[&user],
            )
            .await
            .map_err(|_| crate::account_store::unavailable())?;
        if !member.is_some_and(|r| matches!(r.get::<_, &str>(0), "admin" | "recipient")) {
            return Err(AppError::ForbiddenRole);
        }
        Ok((service, user))
    }
}
pub fn router(rpc: Arc<RpcClient>, service: Option<Arc<Service>>) -> Router {
    let limits = Arc::new(Limits::new());
    Router::new()
        .route("/accounts/discover", post(discover))
        .route("/keys/message", get(message))
        .route("/keys/enroll", post(enroll))
        .route("/accounts/configure", post(prepare_configure))
        .route("/accounts/configure/confirm", post(confirm_configure))
        .route("/accounts/apply-pending", post(prepare_apply))
        .route("/accounts/apply-pending/confirm", post(confirm_apply))
        .route("/me/status", get(status))
        .route("/company/accounts", get(company_account))
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
pub(super) fn address(value: &str) -> Result<Address, AppError> {
    Address::from_str(value).map_err(|_| AppError::BadRequest("invalid_account"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoverRequest {
    wallet: String,
    token_account: Option<String>,
    wallet_signature: Option<String>,
}
impl Drop for DiscoverRequest {
    fn drop(&mut self) {
        self.wallet_signature.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageQuery {
    wallet: String,
    token_account: String,
}
async fn owned_account(
    state: &AccountState,
    wallet: &Address,
    account: &Address,
) -> Result<Option<solana_account::Account>, AppError> {
    state.rpc.require_devnet().await?;
    let existing = state.rpc.account(account).await?;
    match &existing {
        Some(a)
            if a.owner == solana_system_interface::program::ID
                && a.data.is_empty()
                && !a.executable
                && *account == wrap::destination(wallet) => {}
        Some(a) => {
            accounts::validate(a, wallet)?;
        }
        None if *account == wrap::destination(wallet) => {}
        None => return Err(AppError::Conflict("token_account_missing")),
    }
    Ok(existing)
}
async fn discover(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<DiscoverRequest>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let wallet = address(&request.wallet)?;
    if !wallet.is_on_curve() {
        return Err(AppError::BadRequest("invalid_wallet"));
    }
    let (service, user) = state.authenticate(&headers).await?;
    service
        .store
        .authorize_wallet(&user, &wallet, request.wallet_signature.as_deref())
        .await?;
    let existing = service.accounts.mapping(&user).await?;
    let account = match request.token_account.as_deref() {
        Some(a) => address(a)?,
        None => match existing {
            Some(ref m) => address(&m.token_account)?,
            None => wrap::destination(&wallet),
        },
    };
    let _chain = owned_account(&state, &wallet, &account).await?;
    service
        .accounts
        .register(&user, &wallet.to_string(), &account.to_string())
        .await?;
    let client = service.keys.connect().await?;
    let metadata = vault::metadata(&client, &wallet, &account)
        .await
        .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    let (_, finalized) = state.rpc.finalized_account(&account, None).await?;
    let ready = metadata.is_some_and(|(public, balance)| {
        balance
            && finalized
                .as_ref()
                .is_some_and(|a| accounts::configured(a, &wallet, &public).is_ok())
    });
    if ready {
        service.accounts.ready(&user, &account.to_string()).await?;
    }
    Ok(Json(
        json!({"wallet":wallet.to_string(),"token_account":account.to_string(),"mint":Addresses::for_usdc().wrapped_mint.to_string(),"account_configured":ready,"key_enrolled":metadata.is_some_and(|(_,b)|b),"derivation_message":STANDARD.encode(ViewingKey::signing_message(&account))}),
    ))
}
async fn message(
    State(state): State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<MessageQuery>, QueryRejection>,
) -> Result<Json<Value>, AppError> {
    let Query(query) = query.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let (wallet, account) = (address(&query.wallet)?, address(&query.token_account)?);
    let (service, user) = state.authenticate(&headers).await?;
    service.store.authorize_wallet(&user, &wallet, None).await?;
    owned_account(&state, &wallet, &account).await?;
    Ok(Json(
        json!({"wallet":wallet.to_string(),"token_account":account.to_string(),"message":STANDARD.encode(ViewingKey::signing_message(&account)),"encoding":"base64"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollRequest {
    wallet: String,
    token_account: String,
    signature: String,
    wallet_signature: Option<String>,
}
impl Drop for EnrollRequest {
    fn drop(&mut self) {
        self.signature.zeroize();
        self.wallet_signature.zeroize();
    }
}
async fn enroll(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<EnrollRequest>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let (wallet, account) = (address(&request.wallet)?, address(&request.token_account)?);
    let (service, user) = state.authenticate(&headers).await?;
    service
        .store
        .authorize_wallet(&user, &wallet, request.wallet_signature.as_deref())
        .await?;
    if !state.limits.wallet(wallet) {
        return Err(AppError::TransferRateLimited);
    }
    let chain = owned_account(&state, &wallet, &account).await?;
    let signature = Zeroizing::new(<[u8; 64]>::from(
        Signature::from_str(&request.signature)
            .map_err(|_| AppError::BadRequest("invalid_signature"))?,
    ));
    let key = ViewingKey::derive(&wallet, &account, &Signature::from(*signature))
        .map_err(|_| AppError::BadRequest("invalid_signature"))?;
    if let Some(chain) = &chain {
        let state = accounts::validate(chain, &wallet)?;
        use spl_token_2022_interface::extension::{
            confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions,
        };
        if let Ok(config) = state.get_extension::<ConfidentialTransferAccount>() {
            if bytemuck::bytes_of(&config.elgamal_pubkey)
                .iter()
                .any(|b| *b != 0)
                && config.elgamal_pubkey != key.public_key().into()
            {
                return Err(AppError::Conflict("confidential_key_mismatch"));
            }
        }
    }
    service
        .accounts
        .register(&user, &wallet.to_string(), &account.to_string())
        .await?;
    let client = service.keys.connect().await?;
    vault::enroll_account(&client, &wallet, &account, &Signature::from(*signature))
        .await
        .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    let (_, finalized) = state.rpc.finalized_account(&account, None).await?;
    if finalized
        .as_ref()
        .is_some_and(|a| accounts::configured(a, &wallet, &key.public_key().to_bytes()).is_ok())
    {
        service.accounts.ready(&user, &account.to_string()).await?;
    }
    Ok(Json(json!({"status":"enrolled"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareRequest {
    wallet: String,
    wallet_signature: Option<String>,
}
impl Drop for PrepareRequest {
    fn drop(&mut self) {
        self.wallet_signature.zeroize();
    }
}
#[derive(Serialize)]
struct Prepared {
    request_id: String,
    transaction: String,
    transaction_version: u8,
    required_signers: Vec<String>,
    recent_blockhash: String,
    last_valid_block_height: u64,
    token_account: String,
}
fn prepared(record: PreparedAccount) -> Result<Json<Prepared>, AppError> {
    let bytes = STANDARD
        .decode(&record.transaction)
        .map_err(|_| crate::account_store::unavailable())?;
    let tx: solana_transaction::versioned::VersionedTransaction =
        wincode::deserialize(&bytes).map_err(|_| crate::account_store::unavailable())?;
    Ok(Json(Prepared {
        request_id: record.id,
        transaction: record.transaction,
        transaction_version: 1,
        required_signers: vec![record.wallet],
        recent_blockhash: tx.message.recent_blockhash().to_string(),
        last_valid_block_height: record.last_valid_block_height as u64,
        token_account: record.token_account,
    }))
}
async fn prepare_configure(
    state: State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<PrepareRequest>, JsonRejection>,
) -> Result<Json<Prepared>, AppError> {
    prepare(state.0, headers, body, "configure").await
}
async fn prepare_apply(
    state: State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<PrepareRequest>, JsonRejection>,
) -> Result<Json<Prepared>, AppError> {
    prepare(state.0, headers, body, "apply_pending").await
}
async fn prepare(
    state: AccountState,
    headers: HeaderMap,
    body: Result<Json<PrepareRequest>, JsonRejection>,
    kind: &str,
) -> Result<Json<Prepared>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let wallet = address(&request.wallet)?;
    let (service, user) = state.authenticate(&headers).await?;
    service
        .store
        .authorize_wallet(&user, &wallet, request.wallet_signature.as_deref())
        .await?;
    if !state.limits.wallet(wallet) {
        return Err(AppError::TransferRateLimited);
    }
    let mapping = service
        .accounts
        .mapping(&user)
        .await?
        .ok_or(AppError::Conflict("account_not_registered"))?;
    if mapping.wallet != request.wallet {
        return Err(AppError::Forbidden);
    }
    if let Some(record) = service.accounts.pending(&user, kind).await? {
        return prepared(record);
    }
    let account = address(&mapping.token_account)?;
    let existing = owned_account(&state, &wallet, &account).await?;
    let mint = state
        .rpc
        .account(&Addresses::for_usdc().wrapped_mint)
        .await?
        .ok_or(AppError::Conflict("wrapped_mint_missing"))?;
    wrap::validate_mint(&mint)?;
    let client = service.keys.connect().await?;
    let (key, aes) = vault::load_account(
        &client,
        &wallet,
        &account,
        &user,
        "prepare confidential account update",
    )
    .await
    .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    drop(client);
    let expected_counter = if kind == "apply_pending" {
        Some(u64::from(
            accounts::configured(
                existing
                    .as_ref()
                    .ok_or(AppError::Conflict("token_account_missing"))?,
                &wallet,
                &key.public_key().to_bytes(),
            )?
            .pending_balance_credit_counter,
        ))
    } else {
        None
    };
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let (blockhash, height) = state.rpc.blockhash_with_expiry().await?;
    let configure = kind == "configure";
    let tx = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if configure {
            accounts::configure(&wallet, &account, existing.as_ref(), &key, &aes, blockhash)
        } else {
            let config = accounts::configured(
                existing
                    .as_ref()
                    .ok_or(AppError::Conflict("token_account_missing"))?,
                &wallet,
                &key.public_key().to_bytes(),
            )?;
            accounts::apply(&wallet, &account, &config, &key, &aes, blockhash)
        }
    })
    .await
    .map_err(|_| AppError::Transaction("account worker"))??;
    let bytes = v1::serialize(&tx)?;
    let id = request_id(&bytes);
    let transaction = STANDARD.encode(bytes);
    let record = PreparedAccount {
        id: id.clone(),
        wallet: wallet.to_string(),
        token_account: account.to_string(),
        kind: kind.to_owned(),
        transaction: transaction.clone(),
        last_valid_block_height: i64::try_from(height).map_err(|_| AppError::RpcUnavailable)?,
        expected_counter: expected_counter
            .map(i64::try_from)
            .transpose()
            .map_err(|_| AppError::RpcUnavailable)?,
        signature: None,
        slot: None,
        status: "prepared".into(),
    };
    prepared(service.accounts.prepare(&user, &record).await?)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmRequest {
    request_id: String,
    signature: String,
}
async fn confirm_configure(
    state: State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<ConfirmRequest>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    confirm(state.0, headers, body, "configure").await
}
async fn confirm_apply(
    state: State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<ConfirmRequest>, JsonRejection>,
) -> Result<Json<Value>, AppError> {
    confirm(state.0, headers, body, "apply_pending").await
}
async fn confirm(
    state: AccountState,
    headers: HeaderMap,
    body: Result<Json<ConfirmRequest>, JsonRejection>,
    kind: &str,
) -> Result<Json<Value>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    if request.request_id.len() != 64
        || !request
            .request_id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(AppError::BadRequest("invalid_request_id"));
    }
    Signature::from_str(&request.signature)
        .map_err(|_| AppError::BadRequest("invalid_signature"))?;
    let (service, user) = state.authenticate(&headers).await?;
    let record = service
        .accounts
        .get(&user, &request.request_id, kind)
        .await?;
    if record.status == "failed" {
        return Err(AppError::Conflict("transaction_failed"));
    }
    let slot = if let Some(slot) = record.slot {
        if record.signature.as_deref() != Some(&request.signature) {
            return Err(AppError::Conflict("account_already_confirmed"));
        }
        if kind == "configure" {
            verified_config(&state, &service, &record, slot as u64).await?;
            service.accounts.ready(&user, &record.token_account).await?;
        }
        slot as u64
    } else {
        service
            .accounts
            .submitted(&user, &record, &request.signature)
            .await?;
        state.rpc.require_devnet().await?;
        let result = state.rpc.finalized_transaction(&request.signature).await?;
        if result.is_null() {
            return Err(AppError::Conflict("transaction_not_finalized"));
        }
        let (slot, failed) = crate::indexer::verify::outcome(
            &record.id,
            &record.wallet,
            &record.transaction,
            &request.signature,
            &result,
        )?;
        if failed {
            service
                .accounts
                .finish(
                    &user,
                    &record,
                    &request.signature,
                    i64::try_from(slot).map_err(|_| AppError::RpcUnavailable)?,
                    true,
                )
                .await?;
            return Err(AppError::Conflict("transaction_failed"));
        }
        let config = verified_config(&state, &service, &record, slot).await?;
        service
            .accounts
            .finish(
                &user,
                &record,
                &request.signature,
                i64::try_from(slot).map_err(|_| AppError::RpcUnavailable)?,
                false,
            )
            .await?;
        service.accounts.ready(&user, &record.token_account).await?;
        if let Some(expected) = record.expected_counter {
            if u64::from(config.expected_pending_balance_credit_counter) != expected as u64
                || u64::from(config.actual_pending_balance_credit_counter) != expected as u64
            {
                return Err(AppError::Conflict("credit_counter_mismatch"));
            }
        }
        slot
    };
    Ok(Json(
        json!({"request_id":record.id,"signature":request.signature,"slot":slot,"status":"finalized"}),
    ))
}
/// Verify readiness against finalized state even when the indexer saved the receipt first.
async fn verified_config(
    state: &AccountState,
    service: &Service,
    record: &PreparedAccount,
    slot: u64,
) -> Result<
    spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferAccount,
    AppError,
> {
    state.rpc.require_devnet().await?;
    let wallet = address(&record.wallet)?;
    let account = address(&record.token_account)?;
    let (_, chain) = state.rpc.finalized_account(&account, Some(slot)).await?;
    let chain = chain.ok_or(AppError::Conflict("token_account_missing"))?;
    let client = service.keys.connect().await?;
    let (public, _) = vault::metadata(&client, &wallet, &account)
        .await
        .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?
        .ok_or(AppError::Conflict("key_not_enrolled"))?;
    accounts::configured(&chain, &wallet, &public)
}
async fn company_account(
    State(state): State<AccountState>,
    headers: HeaderMap,
) -> Result<Json<Option<Mapping>>, AppError> {
    let (service, user) = state.authenticate(&headers).await?;
    service.runs.require_admin(&user).await?;
    Ok(Json(service.accounts.mapping(&user).await?))
}
async fn status(
    State(state): State<AccountState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let (service, user) = state.authenticate(&headers).await?;
    let Some(mapping) = service.accounts.mapping(&user).await? else {
        return Ok(Json(
            json!({"wallet_created":false,"wallet_linked":false,"key_enrolled":false,"account_configured":false,"activated":false,"pending_credit_counter":0,"pending_credits":false}),
        ));
    };
    let wallet = address(&mapping.wallet)?;
    let account = address(&mapping.token_account)?;
    service.store.authorize_wallet(&user, &wallet, None).await?;
    let client = service.keys.connect().await?;
    let metadata = vault::metadata(&client, &wallet, &account)
        .await
        .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    state.rpc.require_devnet().await?;
    let (_, chain) = state.rpc.finalized_account(&account, None).await?;
    let config = match (metadata, chain) {
        (Some((public, true)), Some(chain)) => accounts::configured(&chain, &wallet, &public).ok(),
        _ => None,
    };
    let pending_credit_counter = config
        .as_ref()
        .map(|c| u64::from(c.pending_balance_credit_counter))
        .unwrap_or(0);
    if config.is_some() && !mapping.ready {
        service
            .accounts
            .ready(&user, &mapping.token_account)
            .await?;
    }
    Ok(Json(
        json!({"wallet_created":true,"wallet_linked":true,"wallet":mapping.wallet,"token_account":mapping.token_account,"key_enrolled":metadata.is_some_and(|(_,b)|b),"account_configured":config.is_some(),"activated":config.is_some(),"pending_credit_counter":pending_credit_counter,"pending_credits":pending_credit_counter > 0}),
    ))
}
