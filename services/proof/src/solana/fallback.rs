//! Proof-program availability and ordinary transfers from the public token balance.
use super::{batch, client::RpcClient, v1};
use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_hash::Hash;
use solana_message::VersionedMessage;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions,
        StateWithExtensions, StateWithExtensionsMut,
    },
    instruction::{transfer_checked, TokenInstruction},
    state::{Account, AccountState},
};

// Agave feature-set IDs. The re-enable gate supersedes the disable gate.
pub const DISABLE: Address = Address::from_str_const("zkdoVwnSFnSLtGJG7irJPEYUpmb4i7sGMGcnN6T9rnC");
pub const REENABLE: Address =
    Address::from_str_const("zkexuyPRdyTVbZqEAREueqL2xvvoBhRgth9xGSc1tMN");
const FEATURE_OWNER: &str = "Feature111111111111111111111111111111111111";

/// A single confirmed bank snapshot avoids mixing feature states across slots.
pub async fn available(rpc: &RpcClient) -> Result<bool, AppError> {
    let result = rpc
        .call(
            "getMultipleAccounts",
            json!([[solana_zk_elgamal_proof_interface::ID.to_string(), DISABLE.to_string(), REENABLE.to_string()],
                {"encoding":"base64", "commitment":"confirmed"}]),
        )
        .await?;
    let slot = result["context"]["slot"]
        .as_u64()
        .ok_or(AppError::RpcUnavailable)?;
    let accounts = result["value"].as_array().ok_or(AppError::RpcUnavailable)?;
    if accounts.len() != 3 {
        return Err(AppError::RpcUnavailable);
    }
    let executable = if accounts[0].is_null() {
        false
    } else {
        accounts[0]["executable"]
            .as_bool()
            .ok_or(AppError::RpcUnavailable)?
    };
    let disabled = active(&accounts[1], slot)?;
    let reenabled = active(&accounts[2], slot)?;
    Ok(executable && (!disabled || reenabled))
}

fn active(account: &Value, slot: u64) -> Result<bool, AppError> {
    if account.is_null() {
        return Ok(false);
    }
    if account["owner"] != FEATURE_OWNER
        || account["executable"] != false
        || account["data"][1] != "base64"
    {
        return Err(AppError::RpcUnavailable);
    }
    let bytes = STANDARD
        .decode(
            account["data"][0]
                .as_str()
                .ok_or(AppError::RpcUnavailable)?,
        )
        .map_err(|_| AppError::RpcUnavailable)?;
    // Feature accounts use bincode Option<u64>, padded to nine bytes.
    match bytes.as_slice() {
        [0, rest @ ..] if rest.len() <= 8 && rest.iter().all(|b| *b == 0) => Ok(false),
        [1, rest @ ..] if rest.len() == 8 => {
            let activated =
                u64::from_le_bytes(rest.try_into().map_err(|_| AppError::RpcUnavailable)?);
            Ok(activated <= slot)
        }
        _ => Err(AppError::RpcUnavailable),
    }
}

pub struct Transfer<'a> {
    pub mint: Address,
    pub sender: Address,
    pub recipient: Address,
    pub wallet: Address,
    pub sender_account: &'a RpcAccount,
    pub recipient_account: &'a RpcAccount,
    pub amount: u64,
    pub blockhash: Hash,
}

fn account<'a>(
    rpc: &'a RpcAccount,
    mint: &Address,
) -> Result<StateWithExtensions<'a, Account>, AppError> {
    let state = StateWithExtensions::<Account>::unpack(&rpc.data)
        .map_err(|_| AppError::Conflict("invalid_token_account"))?;
    if rpc.owner != spl_token_2022_interface::ID || rpc.executable || state.base.mint != *mint {
        return Err(AppError::Conflict("invalid_token_account"));
    }
    if state.base.state != AccountState::Initialized {
        return Err(AppError::Conflict("token_account_frozen"));
    }
    Ok(state)
}

pub fn build(t: &Transfer<'_>) -> Result<VersionedTransaction, AppError> {
    let source = account(t.sender_account, &t.mint)?;
    let destination = account(t.recipient_account, &t.mint)?;
    if source.base.owner != t.wallet {
        return Err(AppError::Forbidden);
    }
    if t.amount == 0 || t.sender == t.recipient {
        return Err(AppError::BadRequest("invalid_transfer"));
    }
    if source.base.amount < t.amount {
        return Err(AppError::Conflict("insufficient_public_balance"));
    }
    if destination
        .get_extension_types()
        .map_err(|_| AppError::Conflict("invalid_token_account"))?
        .contains(&spl_token_2022_interface::extension::ExtensionType::ConfidentialTransferAccount)
    {
        let config = destination
            .get_extension::<ConfidentialTransferAccount>()
            .map_err(|_| AppError::Conflict("invalid_token_account"))?;
        if !bool::from(config.allow_non_confidential_credits) {
            return Err(AppError::Conflict("non_confidential_credits_disabled"));
        }
    }
    let ix = transfer_checked(
        &spl_token_2022_interface::ID,
        &t.sender,
        &t.mint,
        &t.recipient,
        &t.wallet,
        &[],
        t.amount,
        6,
    )
    .map_err(|_| AppError::Transaction("cannot build public transfer"))?;
    v1::compile_unsigned(&[ix], &t.wallet, t.blockhash)
}

/// Only successful preparations spend the remaining public balance.
pub fn build_batch(
    t: &Transfer<'_>,
    payments: &[batch::Payment],
) -> Vec<Result<VersionedTransaction, AppError>> {
    let mut sender = t.sender_account.clone();
    payments
        .iter()
        .map(|p| {
            let recipient = p
                .account
                .as_ref()
                .ok_or(AppError::Conflict("recipient_account_missing"))?;
            let tx = build(&Transfer {
                sender_account: &sender,
                recipient_account: recipient,
                recipient: p.recipient,
                amount: p.amount,
                ..*t
            })?;
            let mut state = StateWithExtensionsMut::<Account>::unpack(&mut sender.data)
                .map_err(|_| AppError::Conflict("invalid_token_account"))?;
            state.base.amount -= p.amount;
            state.pack_base();
            Ok(tx)
        })
        .collect()
}

pub struct PublicTransfer {
    pub sender: Address,
    pub mint: Address,
    pub destination: Address,
    pub amount: u64,
}

/// Recognize exactly the ordinary checked transfer emitted by this module.
pub fn transfer(encoded: &str) -> Option<PublicTransfer> {
    let bytes = STANDARD.decode(encoded).ok()?;
    let tx: VersionedTransaction = wincode::deserialize(&bytes).ok()?;
    let VersionedMessage::V1(message) = tx.message else {
        return None;
    };
    if message.instructions.len() != 1 {
        return None;
    }
    let ix = &message.instructions[0];
    if *message.account_keys.get(ix.program_id_index as usize)? != spl_token_2022_interface::ID
        || ix.accounts.len() != 4
    {
        return None;
    }
    let TokenInstruction::TransferChecked {
        amount,
        decimals: 6,
    } = TokenInstruction::unpack(&ix.data).ok()?
    else {
        return None;
    };
    Some(PublicTransfer {
        sender: *message.account_keys.get(ix.accounts[0] as usize)?,
        mint: *message.account_keys.get(ix.accounts[1] as usize)?,
        destination: *message.account_keys.get(ix.accounts[2] as usize)?,
        amount,
    })
}
