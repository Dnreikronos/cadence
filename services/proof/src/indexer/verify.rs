use crate::{error::AppError, wrap_store::request_id};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use solana_address::Address;
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use std::str::FromStr;

pub fn submission(
    id: &str,
    wallet: &str,
    transaction: &str,
    value: &str,
) -> Result<Signature, AppError> {
    let signature =
        Signature::from_str(value).map_err(|_| AppError::BadRequest("invalid_signature"))?;
    let tx = decode(transaction).map_err(|_| AppError::StorageUnavailable)?;
    let bytes = STANDARD
        .decode(transaction)
        .map_err(|_| AppError::StorageUnavailable)?;
    let wallet = Address::from_str(wallet).map_err(|_| AppError::StorageUnavailable)?;
    if request_id(&bytes) != id {
        return Err(AppError::StorageUnavailable);
    }
    if signature == Signature::default()
        || tx.signatures.len() != 1
        || tx.message.header().num_required_signatures != 1
        || tx.message.static_account_keys().first() != Some(&wallet)
        || !signature.verify(wallet.as_ref(), &tx.message.serialize())
    {
        return Err(AppError::Conflict("transaction_mismatch"));
    }
    Ok(signature)
}

pub fn outcome(
    id: &str,
    wallet: &str,
    transaction: &str,
    value: &str,
    result: &Value,
) -> Result<(u64, bool), AppError> {
    let signature = submission(id, wallet, transaction, value)?;
    let failed = match result.get("meta").and_then(|meta| meta.get("err")) {
        Some(Value::Null) => false,
        Some(_) => true,
        None => return Err(AppError::RpcUnavailable),
    };
    let mut receipt = result.clone();
    receipt["meta"]["err"] = Value::Null;
    let slot =
        crate::routes::wrap::verify_confirmation(id, wallet, transaction, &signature, &receipt)?;
    Ok((slot, failed))
}

pub fn discovered(result: &Value) -> Result<(String, String), AppError> {
    if result["transaction"][1] != "base64" {
        return Err(AppError::RpcUnavailable);
    }
    let encoded = result["transaction"][0]
        .as_str()
        .ok_or(AppError::RpcUnavailable)?;
    let mut tx = decode(encoded)?;
    if tx.signatures.len() != 1 {
        // Multi-signer transactions cannot be a prepared Cadence payment.
        return Err(AppError::Conflict("transaction_mismatch"));
    }
    let signature = tx.signatures[0].to_string();
    tx.signatures[0] = Signature::default();
    let bytes = crate::solana::v1::serialize(&tx)?;
    Ok((request_id(&bytes), signature))
}

fn decode(encoded: &str) -> Result<VersionedTransaction, AppError> {
    if encoded.len() > 5464 {
        return Err(AppError::RpcUnavailable);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| AppError::RpcUnavailable)?;
    if bytes.len() > 4096 {
        return Err(AppError::RpcUnavailable);
    }
    wincode::deserialize(&bytes).map_err(|_| AppError::RpcUnavailable)
}
