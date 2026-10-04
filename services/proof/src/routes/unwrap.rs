use super::{
    transfer::Service,
    wrap_limits::{self, Limits},
};
use crate::{
    error::AppError,
    keys::{elgamal::ViewingKey, vault},
    solana::{
        client::RpcClient,
        reveal_risk::{self, Level, Received, RevealRisk},
        token_wrap::Addresses,
        unwrap, v1, wrap,
    },
    unwrap_store::{PreparedUnwrap, ReceivedPayment},
    wrap_store::request_id,
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    http::HeaderMap,
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use solana_address::Address;
use solana_signature::Signature;
use solana_zk_sdk::encryption::auth_encryption::AeKey;
use spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferAccount;
use std::{str::FromStr, sync::Arc};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone)]
struct UnwrapState {
    rpc: Arc<RpcClient>,
    service: Option<Arc<Service>>,
    limits: Arc<Limits>,
}

pub fn router(rpc: Arc<RpcClient>, service: Option<Arc<Service>>) -> Router {
    let limits = Arc::new(Limits::new());
    Router::new()
        .route("/unwrap", post(prepare))
        .route("/unwrap/check", post(check))
        .route("/unwrap/confirm", post(confirm))
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            wrap_limits::enforce_unwrap,
        ))
        .with_state(UnwrapState {
            rpc,
            service,
            limits,
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnwrapRequest {
    wallet: String,
    amount: String,
    aes_key: String,
    acknowledge_reveal_risk: bool,
    wallet_signature: Option<String>,
}
impl Drop for UnwrapRequest {
    fn drop(&mut self) {
        self.amount.zeroize();
        self.aes_key.zeroize();
        self.wallet_signature.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckRequest {
    wallet: String,
    amount: String,
    wallet_signature: Option<String>,
}
impl Drop for CheckRequest {
    fn drop(&mut self) {
        self.amount.zeroize();
        self.wallet_signature.zeroize();
    }
}

struct Context {
    wallet: Address,
    amount: Zeroizing<u64>,
    config: ConfidentialTransferAccount,
    key: ViewingKey,
    payments: Vec<ReceivedPayment>,
}

async fn context(
    state: &UnwrapState,
    headers: &HeaderMap,
    wallet: &str,
    amount: &str,
    signature: Option<&str>,
) -> Result<(Arc<Service>, String, Context), AppError> {
    let wallet = Address::from_str(wallet).map_err(|_| AppError::BadRequest("invalid_wallet"))?;
    if !wallet.is_on_curve() {
        return Err(AppError::BadRequest("invalid_wallet"));
    }
    let amount = Zeroizing::new(wrap::amount(amount)?);
    let service = state
        .service
        .clone()
        .ok_or(AppError::UnwrapUnavailable("unwrap_unavailable"))?;
    let user = service.auth.user(headers).await?;
    if !state.limits.wallet(wallet) {
        return Err(AppError::UnwrapRateLimited);
    }
    service
        .store
        .authorize_wallet(&user, &wallet, signature)
        .await
        .map_err(storage_error)?;
    state
        .rpc
        .require_devnet()
        .await
        .map_err(|error| match error {
            AppError::Conflict(_) => AppError::Conflict("unwrap_requires_devnet"),
            other => other,
        })?;
    let source = unwrap::source(&wallet);
    let mint_address = Addresses::for_usdc().wrapped_mint;
    let (mint, account) =
        tokio::try_join!(state.rpc.account(&mint_address), state.rpc.account(&source))?;
    wrap::validate_mint(&mint.ok_or(AppError::Conflict("wrapped_mint_missing"))?)?;
    let config = unwrap::validate_source(
        &account.ok_or(AppError::Conflict("sender_account_missing"))?,
        &wallet,
    )?;
    let payments = service.unwrap.received(&user, &wallet, &source).await?;
    let keys = service
        .keys
        .connect()
        .await
        .map_err(|_| AppError::UnwrapUnavailable("key_storage_unavailable"))?;
    let key = vault::load(
        &keys,
        &wallet,
        &source,
        &user,
        "check withdrawal reveal risk and generate withdrawal proofs",
    )
    .await
    .map_err(|_| AppError::UnwrapUnavailable("key_storage_unavailable"))?;
    if config.elgamal_pubkey != key.public_key().into() {
        return Err(AppError::Conflict("confidential_key_mismatch"));
    }
    Ok((
        service,
        user,
        Context {
            wallet,
            amount,
            config,
            key,
            payments,
        },
    ))
}

fn risk(context: &Context, tolerance: u16) -> Result<RevealRisk, AppError> {
    let received = context
        .payments
        .iter()
        .map(|payment| {
            Ok(Received {
                payment: payment.payment.clone(),
                amount: reveal_risk::received_amount(
                    &payment.transaction,
                    &unwrap::source(&context.wallet),
                    &Addresses::for_usdc().wrapped_mint,
                    &context.key,
                )
                .map_err(storage_error)?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(reveal_risk::check(*context.amount, &received, tolerance))
}

#[derive(Serialize)]
struct CheckResponse {
    requires_acknowledgement: bool,
    reveal_risk: RevealRisk,
}
async fn check(
    State(state): State<UnwrapState>,
    headers: HeaderMap,
    body: Result<Json<CheckRequest>, JsonRejection>,
) -> Result<Json<CheckResponse>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let (service, _, context) = context(
        &state,
        &headers,
        &request.wallet,
        &request.amount,
        request.wallet_signature.as_deref(),
    )
    .await?;
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::UnwrapRateLimited)?;
    let risk = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        risk(&context, service.reveal_tolerance_bps)
    })
    .await
    .map_err(|_| AppError::Transaction("risk worker failed"))??;
    Ok(Json(CheckResponse {
        requires_acknowledgement: risk.level != Level::None,
        reveal_risk: risk,
    }))
}

#[derive(Serialize)]
struct UnwrapResponse {
    request_id: String,
    transaction: String,
    transaction_version: u8,
    required_signers: Vec<String>,
    source: String,
    destination: String,
    mint: String,
    recent_blockhash: String,
    last_valid_block_height: u64,
    reveal_risk: RevealRisk,
}
async fn prepare(
    State(state): State<UnwrapState>,
    headers: HeaderMap,
    body: Result<Json<UnwrapRequest>, JsonRejection>,
) -> Result<Json<UnwrapResponse>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let bytes = Zeroizing::new(
        STANDARD
            .decode(&request.aes_key)
            .map_err(|_| AppError::BadRequest("invalid_balance_key"))?,
    );
    let aes = Zeroizing::new(
        AeKey::try_from(bytes.as_slice())
            .map_err(|_| AppError::BadRequest("invalid_balance_key"))?,
    );
    let (service, user, context) = context(
        &state,
        &headers,
        &request.wallet,
        &request.amount,
        request.wallet_signature.as_deref(),
    )
    .await?;
    let wallet = context.wallet;
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::UnwrapRateLimited)?;
    let (blockhash, last_valid_block_height) = state.rpc.blockhash_with_expiry().await?;
    let acknowledge = request.acknowledge_reveal_risk;
    let tolerance = service.reveal_tolerance_bps;
    let (transaction, reveal_risk) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let reveal_risk = risk(&context, tolerance)?;
        if reveal_risk.level != Level::None && !acknowledge {
            return Err(AppError::RevealRisk(reveal_risk));
        }
        let transaction = unwrap::build(
            &wallet,
            &context.config,
            *context.amount,
            &aes,
            &context.key,
            blockhash,
        )?;
        Ok((transaction, reveal_risk))
    })
    .await
    .map_err(|_| AppError::Transaction("withdrawal worker failed"))??;
    let bytes = v1::serialize(&transaction)?;
    let record = PreparedUnwrap {
        id: request_id(&bytes),
        wallet: wallet.to_string(),
        source: unwrap::source(&wallet).to_string(),
        destination: unwrap::destination(&wallet).to_string(),
        transaction: STANDARD.encode(bytes),
        last_valid_block_height,
        signature: None,
        slot: None,
    };
    service.unwrap.prepare(&user, &record).await?;
    Ok(Json(UnwrapResponse {
        request_id: record.id,
        transaction: record.transaction,
        transaction_version: 1,
        required_signers: vec![record.wallet],
        source: record.source,
        destination: record.destination,
        mint: Addresses::for_usdc().unwrapped_mint.to_string(),
        recent_blockhash: blockhash.to_string(),
        last_valid_block_height,
        reveal_risk,
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
    State(state): State<UnwrapState>,
    headers: HeaderMap,
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
    let service = state
        .service
        .ok_or(AppError::UnwrapUnavailable("unwrap_unavailable"))?;
    let user = service.auth.user(&headers).await?;
    let record = service.unwrap.get(&user, &request.request_id).await?;
    if record
        .signature
        .as_ref()
        .is_some_and(|s| s != &request.signature)
    {
        return Err(AppError::Conflict("unwrap_already_confirmed"));
    }
    let slot = if let Some(slot) = record.slot.filter(|_| record.signature.is_some()) {
        slot
    } else {
        state
            .rpc
            .require_devnet()
            .await
            .map_err(|error| match error {
                AppError::Conflict(_) => AppError::Conflict("unwrap_requires_devnet"),
                other => other,
            })?;
        let result = state.rpc.finalized_transaction(&request.signature).await?;
        let slot = super::wrap::verify_confirmation(
            &record.id,
            &record.wallet,
            &record.transaction,
            &signature,
            &result,
        )
        .map_err(storage_error)?;
        service
            .unwrap
            .confirm(&user, &record.id, &request.signature, slot)
            .await?;
        slot
    };
    Ok(Json(ConfirmResponse {
        request_id: record.id,
        signature: request.signature,
        slot,
        status: "finalized",
    }))
}
fn storage_error(error: AppError) -> AppError {
    match error {
        AppError::StorageUnavailable
        | AppError::TransferUnavailable("transfer_storage_unavailable") => {
            AppError::UnwrapUnavailable("unwrap_storage_unavailable")
        }
        AppError::TransferUnavailable(code) => AppError::UnwrapUnavailable(code),
        other => other,
    }
}
