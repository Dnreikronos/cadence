use super::{
    runs::{self, ItemError, RunResponse, RunState},
    wrap::verify_confirmation,
};
use crate::{
    error::AppError,
    run_store::{Payment, Run, Status},
};
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::HeaderMap,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use std::{collections::HashSet, str::FromStr};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConfirmRequest {
    payments: Vec<Confirmation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    position: i16,
    request_id: String,
    signature: String,
}

pub(super) async fn confirm(
    State(state): State<RunState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<ConfirmRequest>, JsonRejection>,
) -> Result<Json<RunResponse>, AppError> {
    runs::valid_id(&id)?;
    let Json(request) = body.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let mut seen = HashSet::new();
    if request.payments.is_empty()
        || request.payments.len() > 100
        || request.payments.iter().any(|p| !seen.insert(p.position))
    {
        return Err(AppError::BadRequest("invalid_payments"));
    }
    let (service, user) = state.authenticate(&headers).await?;
    let mut run = service.runs.get(&user, &id).await?;
    let mut errors = vec![];
    for item in request.payments {
        let result = async {
            let p = run
                .payments
                .iter()
                .find(|p| p.position == item.position)
                .ok_or(AppError::BadRequest("invalid_payment"))?;
            if p.request_id.as_deref() != Some(&item.request_id) {
                return Err(AppError::Conflict("payment_attempt_changed"));
            }
            reconcile(&state, &user, &run, item.position, &item.signature, false).await
        }
        .await;
        if let Err(error) = result {
            errors.push(ItemError {
                position: item.position,
                error: runs::error_code(&error),
            });
        }
    }
    run = service.runs.get(&user, &id).await?;
    let mut response = runs::response(run, false);
    response.errors = errors;
    Ok(Json(response))
}

pub(super) fn signature(run: &Run, p: &Payment, value: &str) -> Result<Signature, AppError> {
    let signature =
        Signature::from_str(value).map_err(|_| AppError::BadRequest("invalid_signature"))?;
    let bytes = STANDARD
        .decode(
            p.transaction
                .as_deref()
                .ok_or(AppError::Conflict("payment_not_prepared"))?,
        )
        .map_err(|_| AppError::RunUnavailable)?;
    if crate::wrap_store::request_id(&bytes)
        != p.request_id.as_deref().ok_or(AppError::RunUnavailable)?
    {
        return Err(AppError::RunUnavailable);
    }
    let tx: VersionedTransaction =
        wincode::deserialize(&bytes).map_err(|_| AppError::RunUnavailable)?;
    let wallet = runs::address(&run.company_wallet).map_err(|_| AppError::RunUnavailable)?;
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

/// Persist verified finalized outcomes; expiry alone cannot resolve missing history.
pub(super) async fn reconcile(
    state: &RunState,
    user: &str,
    run: &Run,
    position: i16,
    value: &str,
    expire: bool,
) -> Result<(), AppError> {
    let p = run
        .payments
        .iter()
        .find(|p| p.position == position)
        .ok_or(AppError::BadRequest("invalid_payment"))?;
    let sig = signature(run, p, value)?;
    if p.status != Status::Prepared {
        return if p.signature.as_deref() == Some(value) {
            Ok(())
        } else {
            Err(AppError::Conflict("payment_already_resolved"))
        };
    }
    state
        .service
        .as_ref()
        .ok_or(AppError::RunUnavailable)?
        .runs
        .submitted(user, &run.id, p, value)
        .await?;
    state.devnet().await?;
    // Observe finalized expiry before classifying a missing history response.
    let expired = expire
        && state.rpc.finalized_block_height().await?
            > p.last_valid_block_height.ok_or(AppError::RunUnavailable)? as u64;
    let mut result = state.rpc.finalized_transaction(value).await?;
    let (status, slot, error) = if result.is_null() {
        // An executed payment can disappear from RPC history. Never replace it on absence alone.
        return Err(AppError::Conflict(if expired {
            "transaction_history_unavailable"
        } else {
            "transaction_not_finalized"
        }));
    } else {
        let failed = match result.get("meta").and_then(|m| m.get("err")) {
            Some(Value::Null) => false,
            Some(_) => true,
            None => return Err(AppError::RpcUnavailable),
        };
        // Both outcomes require the same message/signature verification before storage.
        result["meta"]["err"] = Value::Null;
        let slot = verify_confirmation(
            p.request_id.as_deref().ok_or(AppError::RunUnavailable)?,
            &run.company_wallet,
            p.transaction.as_deref().ok_or(AppError::RunUnavailable)?,
            &sig,
            &result,
        )?;
        let slot = i64::try_from(slot).map_err(|_| AppError::RpcUnavailable)?;
        if failed {
            (
                Status::Failed,
                Some(slot),
                Some("transaction_failed".into()),
            )
        } else {
            (Status::Finalized, Some(slot), None)
        }
    };
    let terminal = Payment {
        position: p.position,
        destination: p.destination.clone(),
        attempt: p.attempt,
        request_id: p.request_id.clone(),
        transaction: p.transaction.clone(),
        last_valid_block_height: p.last_valid_block_height,
        status,
        signature: Some(value.into()),
        slot,
        error,
    };
    state
        .service
        .as_ref()
        .ok_or(AppError::RunUnavailable)?
        .runs
        .finish(user, &run.id, &terminal)
        .await
}
