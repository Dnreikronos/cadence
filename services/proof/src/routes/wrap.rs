use super::wrap_limits::{self, Limits};
use crate::{
    error::AppError,
    solana::{
        client::RpcClient,
        token_wrap::{self, Addresses, TOKEN},
        v0, v1, wrap,
    },
    wrap_store::{request_id, PreparedWrap, WrapStore},
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use solana_address::Address;
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use std::{str::FromStr, sync::Arc};

#[derive(Clone)]
struct WrapState {
    rpc: Arc<RpcClient>,
    store: Option<Arc<WrapStore>>,
    limits: Arc<Limits>,
}

pub fn router(rpc: Arc<RpcClient>, store: Option<Arc<WrapStore>>) -> Router {
    let limits = Arc::new(Limits::new());
    Router::new()
        .route("/wrap", post(prepare))
        .route("/wrap/confirm", post(confirm))
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            wrap_limits::enforce,
        ))
        .with_state(WrapState { rpc, store, limits })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WrapRequest {
    company_wallet: String,
    amount: String,
    setup: Option<wrap::Setup>,
}

#[derive(Serialize)]
struct WrapResponse {
    request_id: String,
    transaction: String,
    transaction_version: u8,
    required_signers: Vec<String>,
    destination: String,
    mint: String,
    recent_blockhash: String,
    last_valid_block_height: u64,
    deposit_state: &'static str,
}

async fn prepare(
    State(state): State<WrapState>,
    body: Result<Json<WrapRequest>, JsonRejection>,
) -> Result<Json<WrapResponse>, AppError> {
    // Axum's default rejection can echo input values. Keep all errors fixed.
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let wallet = Address::from_str(&request.company_wallet)
        .map_err(|_| AppError::BadRequest("invalid_wallet"))?;
    if !wallet.is_on_curve() {
        return Err(AppError::BadRequest("invalid_wallet"));
    }
    if !state.limits.wallet(wallet) {
        return Err(AppError::RateLimited);
    }
    let amount = wrap::amount(&request.amount)?;
    let store = state.store.ok_or(AppError::StorageUnavailable)?;
    state.rpc.require_devnet().await?;
    let addresses = Addresses::for_usdc();
    let destination = wrap::destination(&wallet);
    let source = token_wrap::associated_token_address(&wallet, &addresses.unwrapped_mint, &TOKEN);
    let (mint, source_account, destination_account) = tokio::try_join!(
        state.rpc.account(&addresses.wrapped_mint),
        state.rpc.account(&source),
        state.rpc.account(&destination)
    )?;
    wrap::validate_mint(&mint.ok_or(AppError::Conflict("wrapped_mint_missing"))?)?;
    wrap::validate_source(
        &source_account.ok_or(AppError::Conflict("usdc_source_missing"))?,
        &wallet,
        amount,
    )?;
    let instructions = wrap::instructions(
        &wallet,
        amount,
        destination_account.as_ref(),
        request.setup.as_ref(),
    )?;
    let (blockhash, last_valid_block_height) = state.rpc.blockhash_with_expiry().await?;
    let tx = v0::compile_unsigned(&instructions, &wallet, blockhash)?;
    let bytes = v1::serialize(&tx)?;
    let record = PreparedWrap {
        id: request_id(&bytes),
        company_wallet: wallet.to_string(),
        destination: destination.to_string(),
        transaction: STANDARD.encode(bytes),
        last_valid_block_height,
        signature: None,
        slot: None,
    };
    store.prepare(&record).await?;
    Ok(Json(WrapResponse {
        request_id: record.id,
        transaction: record.transaction,
        transaction_version: 0,
        required_signers: vec![wallet.to_string()],
        destination: record.destination,
        mint: addresses.wrapped_mint.to_string(),
        recent_blockhash: blockhash.to_string(),
        last_valid_block_height,
        deposit_state: "pending_after_confirmation",
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmRequest {
    request_id: String,
    signature: String,
}

#[derive(Serialize)]
struct ConfirmResponse {
    request_id: String,
    signature: String,
    slot: u64,
    status: &'static str,
}

async fn confirm(
    State(state): State<WrapState>,
    body: Result<Json<ConfirmRequest>, JsonRejection>,
) -> Result<Json<ConfirmResponse>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    if request.request_id.len() != 64
        || !request
            .request_id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(AppError::BadRequest("invalid_request_id"));
    }
    let signature = Signature::from_str(&request.signature)
        .map_err(|_| AppError::BadRequest("invalid_signature"))?;
    if signature == Signature::default() {
        return Err(AppError::BadRequest("invalid_signature"));
    }
    let store = state.store.ok_or(AppError::StorageUnavailable)?;
    let record = store.get(&request.request_id).await?;
    if record
        .signature
        .as_ref()
        .is_some_and(|s| s != &request.signature)
    {
        return Err(AppError::Conflict("wrap_already_confirmed"));
    }
    if let Some(slot) = record.slot.filter(|_| record.signature.is_some()) {
        return Ok(Json(ConfirmResponse {
            request_id: record.id,
            signature: request.signature,
            slot,
            status: "finalized",
        }));
    }
    state.rpc.require_devnet().await?;
    let result = state.rpc.finalized_transaction(&request.signature).await?;
    let slot = verify_confirmation(&record, &signature, &result)?;
    store.confirm(&record.id, &request.signature, slot).await?;
    Ok(Json(ConfirmResponse {
        request_id: record.id,
        signature: request.signature,
        slot,
        status: "finalized",
    }))
}

fn verify_confirmation(
    record: &PreparedWrap,
    signature: &Signature,
    result: &Value,
) -> Result<u64, AppError> {
    if result.is_null() {
        return Err(AppError::Conflict("transaction_not_finalized"));
    }
    match result.get("meta").and_then(|meta| meta.get("err")) {
        Some(Value::Null) => (),
        Some(_) => return Err(AppError::Conflict("transaction_failed")),
        None => return Err(AppError::RpcUnavailable),
    }
    let slot = result["slot"].as_u64().ok_or(AppError::RpcUnavailable)?;
    let encoded = result["transaction"][0]
        .as_str()
        .ok_or(AppError::RpcUnavailable)?;
    if result["transaction"][1] != "base64" || encoded.len() > 5464 {
        return Err(AppError::RpcUnavailable);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| AppError::RpcUnavailable)?;
    if bytes.len() > 4096 {
        return Err(AppError::RpcUnavailable);
    }
    let actual: VersionedTransaction =
        wincode::deserialize(&bytes).map_err(|_| AppError::RpcUnavailable)?;
    let prepared_bytes = STANDARD
        .decode(&record.transaction)
        .map_err(|_| AppError::StorageUnavailable)?;
    if request_id(&prepared_bytes) != record.id {
        return Err(AppError::StorageUnavailable);
    }
    let prepared: VersionedTransaction =
        wincode::deserialize(&prepared_bytes).map_err(|_| AppError::StorageUnavailable)?;
    let wallet =
        Address::from_str(&record.company_wallet).map_err(|_| AppError::StorageUnavailable)?;
    if actual.message != prepared.message
        || actual.signatures.as_slice() != [*signature]
        || actual.message.static_account_keys().first() != Some(&wallet)
        || !signature.verify(wallet.as_ref(), &actual.message.serialize())
    {
        return Err(AppError::Conflict("transaction_mismatch"));
    }
    Ok(slot)
}
