use super::{
    accounts::AccountState,
    transfer::Service,
    wrap_limits::{self, Limits},
};
use crate::{audit::store::Payment, error::AppError, owner_reads, solana::client::RpcClient};
use axum::{
    extract::{rejection::QueryRejection, Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExportQuery {}
pub fn router(rpc: Arc<RpcClient>, service: Option<Arc<Service>>) -> Router {
    let limits = Arc::new(Limits::new());
    Router::new()
        .route("/company/export.csv", get(company))
        .route("/me/export.csv", get(recipient))
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            wrap_limits::enforce_transfer,
        ))
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
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
async fn company(
    state: State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<ExportQuery>, QueryRejection>,
) -> Result<Response, AppError> {
    export(state.0, headers, query, "company").await
}
async fn recipient(
    state: State<AccountState>,
    headers: HeaderMap,
    query: Result<Query<ExportQuery>, QueryRejection>,
) -> Result<Response, AppError> {
    export(state.0, headers, query, "me").await
}
async fn export(
    state: AccountState,
    headers: HeaderMap,
    query: Result<Query<ExportQuery>, QueryRejection>,
    scope: &str,
) -> Result<Response, AppError> {
    query.map_err(|_| AppError::BadRequest("invalid_request"))?;
    let (service, user) = state.authenticate(&headers).await?;
    let permit = service
        .proof_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::TransferRateLimited)?;
    let client = service.keys.connect().await?;
    let page = owner_reads::payments(&client, &user, scope, 10000, None, permit).await?;
    if page.next_cursor.is_some() {
        return Err(AppError::Conflict("export_too_large"));
    }
    csv_response(&page.items)
}
pub(super) fn csv_response(payments: &[Payment]) -> Result<Response, AppError> {
    let body = csv(payments)?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"cadence-payments.csv\"",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response())
}
fn cell(value: &str) -> String {
    let formula = value.starts_with(['\t', '\r', '\n'])
        || value.trim_start().starts_with(['=', '+', '-', '@']);
    let value = if formula {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}
fn csv(payments: &[Payment]) -> Result<String, AppError> {
    let mut output = String::from("date,counterparty,amount,status,signature\r\n");
    for p in payments {
        let amount = p
            .amount
            .parse::<u64>()
            .map_err(|_| AppError::TransferUnavailable("export_unavailable"))?;
        let amount = format!("{}.{:06}", amount / 1_000_000, amount % 1_000_000);
        output.push_str(
            &[
                &p.paid_at,
                &p.counterparty.name,
                &amount,
                p.status,
                &p.signature,
            ]
            .into_iter()
            .map(cell)
            .collect::<Vec<_>>()
            .join(","),
        );
        output.push_str("\r\n");
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neutralizes_formulas_before_rfc4180_quoting() {
        assert_eq!(cell("=1+1"), "'=1+1");
        assert_eq!(cell(" +1"), "' +1");
        assert_eq!(cell("\tname"), "'\tname");
        assert_eq!(cell("A,\"B\"\r\nC"), "\"A,\"\"B\"\"\r\nC\"");
    }
    #[test]
    fn amounts_use_integer_math_and_exactly_six_decimals() {
        let p = Payment {
            payment_id: "id".into(),
            run_id: None,
            counterparty: crate::audit::store::Counterparty {
                id: None,
                name: "=malicious,company".into(),
            },
            amount: "4200001".into(),
            status: "confirmed",
            transparent: false,
            paid_at: "2026-10-11".into(),
            signature: "signature".into(),
        };
        assert_eq!(csv(&[p]).unwrap(),"date,counterparty,amount,status,signature\r\n2026-10-11,\"'=malicious,company\",4.200001,confirmed,signature\r\n");
    }
}
