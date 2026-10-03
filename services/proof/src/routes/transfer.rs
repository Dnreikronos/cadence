use super::wrap_limits::{self, Limits};
use crate::{
    auth::SupabaseAuth,
    database::Database,
    error::AppError,
    keys::vault,
    solana::{client::RpcClient, confidential, token_wrap::Addresses, v1, wrap},
    transfer_store::{PreparedTransfer, TransferStore},
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
use spl_token_2022_interface::{extension::StateWithExtensions, state::Account};
use std::{str::FromStr, sync::Arc};
use tokio::sync::Semaphore;
use zeroize::{Zeroize, Zeroizing};

pub struct Service {
    auth: SupabaseAuth,
    store: TransferStore,
    keys: Database,
    pub(super) proof_slots: Arc<Semaphore>,
}

impl Service {
    pub fn new(auth: SupabaseAuth, receipts_url: &str, keys_url: &str) -> Result<Self, AppError> {
        Ok(Self {
            auth,
            store: TransferStore::new(receipts_url)?,
            keys: Database::new(keys_url, "cadence_key_service")?,
            proof_slots: Arc::new(Semaphore::new(4)),
        })
    }

    pub fn from_env() -> Result<Option<Self>, AppError> {
        Self::parse(|name| std::env::var(name).ok())
    }

    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, AppError> {
        match (
            get("PROOF_TRANSFER_DATABASE_URL"),
            get("PROOF_KEY_DATABASE_URL"),
        ) {
            (None, None) => Ok(None),
            (Some(receipts), Some(keys)) => {
                let origin = get("PROOF_SUPABASE_URL")
                    .and_then(|value| value.parse().ok())
                    .ok_or(AppError::Config("transfer requires PROOF_SUPABASE_URL"))?;
                let api_key = get("PROOF_SUPABASE_API_KEY")
                    .ok_or(AppError::Config("transfer requires PROOF_SUPABASE_API_KEY"))?;
                Self::new(SupabaseAuth::new(origin, &api_key)?, &receipts, &keys).map(Some)
            }
            _ => Err(AppError::Config(
                "both proof transfer database settings are required",
            )),
        }
    }
}

#[derive(Clone)]
struct TransferState {
    rpc: Arc<RpcClient>,
    service: Option<Arc<Service>>,
    limits: Arc<Limits>,
    proof_slots: Arc<Semaphore>,
}

pub fn router(rpc: Arc<RpcClient>, service: Option<Arc<Service>>) -> Router {
    let limits = Arc::new(Limits::new());
    let proof_slots = service
        .as_ref()
        .map(|s| s.proof_slots.clone())
        .unwrap_or_else(|| Arc::new(Semaphore::new(4)));
    Router::new()
        .route("/transfer", post(prepare))
        .route("/transfer/confirm", post(confirm))
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            wrap_limits::enforce_transfer,
        ))
        .with_state(TransferState {
            rpc,
            service,
            limits,
            proof_slots,
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferRequest {
    company_wallet: String,
    sender: String,
    recipient: String,
    amount: String,
    aes_key: String,
    wallet_signature: Option<String>,
}
impl Drop for TransferRequest {
    fn drop(&mut self) {
        self.amount.zeroize();
        self.aes_key.zeroize();
        self.wallet_signature.zeroize();
    }
}

#[derive(Serialize)]
struct TransferResponse {
    request_id: String,
    transaction: String,
    transaction_version: u8,
    required_signers: Vec<String>,
    sender: String,
    destination: String,
    mint: String,
    recent_blockhash: String,
    last_valid_block_height: u64,
}

async fn prepare(
    State(state): State<TransferState>,
    headers: HeaderMap,
    body: Result<Json<TransferRequest>, JsonRejection>,
) -> Result<Json<TransferResponse>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let wallet = address(&request.company_wallet)?;
    if !wallet.is_on_curve() {
        return Err(AppError::BadRequest("invalid_wallet"));
    }
    let sender = address(&request.sender)?;
    let recipient = address(&request.recipient)?;
    let amount = wrap::amount(&request.amount)?;
    if amount > confidential::MAX_TRANSFER_AMOUNT || sender == recipient {
        return Err(AppError::BadRequest("invalid_transfer"));
    }
    let aes_bytes = Zeroizing::new(
        STANDARD
            .decode(&request.aes_key)
            .map_err(|_| AppError::BadRequest("invalid_balance_key"))?,
    );
    let aes = Zeroizing::new(
        AeKey::try_from(aes_bytes.as_slice())
            .map_err(|_| AppError::BadRequest("invalid_balance_key"))?,
    );
    let service = state
        .service
        .ok_or(AppError::TransferUnavailable("transfer_unavailable"))?;
    let user = service.auth.user(&headers).await?;
    if !state.limits.wallet(wallet) {
        return Err(AppError::TransferRateLimited);
    }
    service
        .store
        .authorize_wallet(&user, &wallet, request.wallet_signature.as_deref())
        .await?;
    state.rpc.require_devnet().await.map_err(cluster_error)?;
    let mint = Addresses::for_usdc().wrapped_mint;
    let (mint_account, sender_account, recipient_account) = tokio::try_join!(
        state.rpc.account(&mint),
        state.rpc.account(&sender),
        state.rpc.account(&recipient)
    )?;
    let mint_account = mint_account.ok_or(AppError::Conflict("wrapped_mint_missing"))?;
    wrap::validate_mint(&mint_account)?;
    let sender_account = sender_account.ok_or(AppError::Conflict("sender_account_missing"))?;
    let recipient_account =
        recipient_account.ok_or(AppError::Conflict("recipient_account_missing"))?;
    let source = StateWithExtensions::<Account>::unpack(&sender_account.data)
        .map_err(|_| AppError::Conflict("invalid_sender_account"))?;
    if sender_account.owner != spl_token_2022_interface::ID
        || sender_account.executable
        || source.base.owner != wallet
        || source.base.mint != mint
    {
        return Err(AppError::Forbidden);
    }
    let permit = state
        .proof_slots
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let sizes = confidential::CONTEXT_SIZES;
    let (a, b, c) = tokio::try_join!(
        state.rpc.minimum_balance(sizes[0]),
        state.rpc.minimum_balance(sizes[1]),
        state.rpc.minimum_balance(sizes[2])
    )?;
    let key_client = service
        .keys
        .connect()
        .await
        .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    let key = vault::load(
        &key_client,
        &wallet,
        &sender,
        &user,
        "generate confidential transfer proofs",
    )
    .await
    .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    drop(key_client);
    let (blockhash, last_valid_block_height) = state.rpc.blockhash_with_expiry().await?;
    let transaction = tokio::task::spawn_blocking(move || {
        // Keep this permit until CPU work ends, including after an HTTP timeout.
        let _permit = permit;
        confidential::build(
            &confidential::Transfer {
                mint,
                sender,
                recipient,
                wallet,
                mint_account: &mint_account,
                sender_account: &sender_account,
                recipient_account: &recipient_account,
                amount,
                aes_key: &aes,
                blockhash,
                context_rent: [a, b, c],
            },
            &key,
        )
    })
    .await
    .map_err(|_| AppError::Transaction("proof worker failed"))?
    .map_err(proof_error)?;
    let bytes = v1::serialize(&transaction)?;
    let record = PreparedTransfer {
        id: request_id(&bytes),
        company_wallet: wallet.to_string(),
        sender: sender.to_string(),
        destination: recipient.to_string(),
        transaction: STANDARD.encode(bytes),
        last_valid_block_height,
        signature: None,
        slot: None,
    };
    service.store.prepare(&user, &record).await?;
    Ok(Json(TransferResponse {
        request_id: record.id,
        transaction: record.transaction,
        transaction_version: 1,
        required_signers: vec![wallet.to_string()],
        sender: record.sender,
        destination: record.destination,
        mint: mint.to_string(),
        recent_blockhash: blockhash.to_string(),
        last_valid_block_height,
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
    State(state): State<TransferState>,
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
        .ok_or(AppError::TransferUnavailable("transfer_unavailable"))?;
    let user = service.auth.user(&headers).await?;
    let record = service.store.get(&user, &request.request_id).await?;
    if record
        .signature
        .as_ref()
        .is_some_and(|s| s != &request.signature)
    {
        return Err(AppError::Conflict("transfer_already_confirmed"));
    }
    let slot = if let Some(slot) = record.slot.filter(|_| record.signature.is_some()) {
        slot
    } else {
        state.rpc.require_devnet().await.map_err(cluster_error)?;
        let result = state.rpc.finalized_transaction(&request.signature).await?;
        let slot = super::wrap::verify_confirmation(
            &record.id,
            &record.company_wallet,
            &record.transaction,
            &signature,
            &result,
        )
        .map_err(|error| match error {
            AppError::StorageUnavailable => {
                AppError::TransferUnavailable("transfer_storage_unavailable")
            }
            other => other,
        })?;
        service
            .store
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

fn address(value: &str) -> Result<Address, AppError> {
    Address::from_str(value).map_err(|_| AppError::BadRequest("invalid_account"))
}
fn cluster_error(error: AppError) -> AppError {
    match error {
        AppError::Conflict(_) => AppError::Conflict("transfer_requires_devnet"),
        other => other,
    }
}
fn proof_error(error: confidential::TransferError) -> AppError {
    match error {
        confidential::TransferError::Invalid(_) => AppError::Conflict("invalid_confidential_state"),
        confidential::TransferError::ProofGeneration => {
            AppError::Conflict("proof_generation_failed")
        }
        confidential::TransferError::KeyStore(_) => {
            AppError::TransferUnavailable("key_storage_unavailable")
        }
        confidential::TransferError::Transaction(_) => {
            AppError::Transaction("transfer assembly failed")
        }
    }
}
