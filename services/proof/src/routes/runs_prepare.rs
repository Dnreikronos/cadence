use super::{
    runs::{self, RunResponse, RunState},
    transfer::proof_error,
};
use crate::{
    error::AppError,
    keys::vault,
    run_store::{Payment, Status},
    solana::{batch, confidential, token_wrap::Addresses, v1, wrap},
    wrap_store::request_id,
};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::HeaderMap,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use solana_address::Address;
use solana_zk_sdk::encryption::auth_encryption::AeKey;
use spl_token_2022_interface::{extension::StateWithExtensions, state::Account};
use std::collections::HashSet;
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RunRequest {
    company_wallet: String,
    sender: String,
    aes_key: String,
    wallet_signature: Option<String>,
    payments: Vec<Recipient>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipient {
    recipient: String,
    amount: String,
}
impl Drop for Recipient {
    fn drop(&mut self) {
        self.amount.zeroize();
    }
}
impl Drop for RunRequest {
    fn drop(&mut self) {
        self.aes_key.zeroize();
        self.wallet_signature.zeroize();
    }
}
struct Entry {
    position: i16,
    recipient: Address,
    amount: u64,
    attempt: i32,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.amount.zeroize();
    }
}
fn aes(encoded: &str) -> Result<Zeroizing<AeKey>, AppError> {
    let bytes = Zeroizing::new(
        STANDARD
            .decode(encoded)
            .map_err(|_| AppError::BadRequest("invalid_balance_key"))?,
    );
    Ok(Zeroizing::new(AeKey::try_from(bytes.as_slice()).map_err(
        |_| AppError::BadRequest("invalid_balance_key"),
    )?))
}
fn count(n: usize) -> Result<(), AppError> {
    if !(1..=100).contains(&n) {
        return Err(AppError::BadRequest("invalid_payments"));
    }
    Ok(())
}
pub(super) async fn prepare(
    State(state): State<RunState>,
    headers: HeaderMap,
    body: Result<Json<RunRequest>, JsonRejection>,
) -> Result<Json<RunResponse>, AppError> {
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    count(request.payments.len())?;
    let wallet = runs::address(&request.company_wallet)?;
    if !wallet.is_on_curve() {
        return Err(AppError::BadRequest("invalid_wallet"));
    }
    let sender = runs::address(&request.sender)?;
    let mut seen = HashSet::new();
    let entries = request
        .payments
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let recipient = runs::address(&p.recipient)?;
            if sender == recipient || !seen.insert(recipient) {
                return Err(AppError::BadRequest("invalid_payments"));
            }
            Ok(Entry {
                position: i as i16,
                recipient,
                amount: wrap::amount(&p.amount)?,
                attempt: 0,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let aes = aes(&request.aes_key)?;
    let (service, user) = state.authenticate(&headers).await?;
    if !state.limits.wallet(wallet) {
        return Err(AppError::TransferRateLimited);
    }
    service
        .store
        .authorize_wallet(&user, &wallet, request.wallet_signature.as_deref())
        .await?;
    let payments = build(&state, &user, wallet, sender, aes, entries).await?;
    let run = service
        .runs
        .prepare(&user, &wallet.to_string(), &sender.to_string(), &payments)
        .await?;
    Ok(Json(runs::response(run, true)))
}

async fn build(
    state: &RunState,
    user: &str,
    wallet: Address,
    sender: Address,
    aes: Zeroizing<AeKey>,
    entries: Vec<Entry>,
) -> Result<Vec<Payment>, AppError> {
    let service = state.service.as_ref().ok_or(AppError::RunUnavailable)?;
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    state.devnet().await?;
    let mint = Addresses::for_usdc().wrapped_mint;
    let (mint_account, source) =
        tokio::try_join!(state.rpc.account(&mint), state.rpc.account(&sender))?;
    let mint_account = mint_account.ok_or(AppError::Conflict("wrapped_mint_missing"))?;
    wrap::validate_mint(&mint_account)?;
    let source = source.ok_or(AppError::Conflict("sender_account_missing"))?;
    let account = StateWithExtensions::<Account>::unpack(&source.data)
        .map_err(|_| AppError::Conflict("invalid_sender_account"))?;
    if source.owner != spl_token_2022_interface::ID
        || source.executable
        || account.base.owner != wallet
        || account.base.mint != mint
    {
        return Err(AppError::Forbidden);
    }
    let mut payments = vec![];
    let mut account_errors = vec![];
    for p in &entries {
        let (account, error) = match state.rpc.account(&p.recipient).await {
            Ok(account) => (account, None),
            Err(error) => (None, Some(runs::error_code(&error))),
        };
        payments.push(batch::Payment {
            recipient: p.recipient,
            account,
            amount: p.amount,
        });
        account_errors.push(error);
    }
    let sizes = confidential::CONTEXT_SIZES;
    let (a, b, c) = tokio::try_join!(
        state.rpc.minimum_balance(sizes[0]),
        state.rpc.minimum_balance(sizes[1]),
        state.rpc.minimum_balance(sizes[2])
    )?;
    let client = service
        .keys
        .connect()
        .await
        .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    let key = vault::load(
        &client,
        &wallet,
        &sender,
        user,
        "generate confidential run proofs",
    )
    .await
    .map_err(|_| AppError::TransferUnavailable("key_storage_unavailable"))?;
    drop(client);
    let (blockhash, height) = state.rpc.blockhash_with_expiry().await?;
    let results = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        batch::build(
            &confidential::Transfer {
                mint,
                sender,
                recipient: sender,
                wallet,
                mint_account: &mint_account,
                sender_account: &source,
                recipient_account: &source,
                amount: 0,
                aes_key: &aes,
                blockhash,
                context_rent: [a, b, c],
            },
            &payments,
            &key,
        )
    })
    .await
    .map_err(|_| AppError::Transaction("proof worker failed"))?;
    let height = i64::try_from(height).map_err(|_| AppError::RpcUnavailable)?;
    entries
        .into_iter()
        .zip(results)
        .zip(account_errors)
        .map(|((entry, result), account_error)| {
            let mut p = Payment {
                position: entry.position,
                destination: entry.recipient.to_string(),
                attempt: entry.attempt,
                request_id: None,
                transaction: None,
                last_valid_block_height: None,
                status: Status::PreparationFailed,
                signature: None,
                slot: None,
                error: None,
            };
            match result {
                Ok(tx) => {
                    let bytes = v1::serialize(&tx)?;
                    p.request_id = Some(request_id(&bytes));
                    p.transaction = Some(STANDARD.encode(bytes));
                    p.last_valid_block_height = Some(height);
                    p.status = Status::Prepared;
                }
                Err(error) => {
                    p.error = Some(
                        account_error
                            .unwrap_or_else(|| runs::error_code(&proof_error(error)))
                            .into(),
                    );
                }
            }
            Ok(p)
        })
        .collect()
}
