use crate::{
    audit::store::{Counterparty, Page, Payment},
    error::AppError,
    keys::vault,
    solana::{fallback, reveal_risk, token_wrap::Addresses},
};
use serde::Serialize;
use tokio_postgres::{Client, Row};
use zeroize::{Zeroize, Zeroizing};

pub fn database_error(error: tokio_postgres::Error) -> AppError {
    match error.code().map(|c| c.code()) {
        Some("CD403") => AppError::ForbiddenRole,
        Some("CD404") => AppError::PersonNotFound,
        Some("CD413") => AppError::Conflict("export_too_large"),
        _ => AppError::TransferUnavailable("read_storage_unavailable"),
    }
}
pub async fn identity(client: &Client, user: &str) -> Result<(), AppError> {
    client
        .query_one(
            "SELECT set_config('request.jwt.claim.sub',$1,false)",
            &[&user],
        )
        .await
        .map_err(database_error)?;
    Ok(())
}
pub async fn payments(
    client: &Client,
    user: &str,
    scope: &str,
    limit: i32,
    cursor: Option<&str>,
    worker_permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Page<Payment>, AppError> {
    identity(client, user).await?;
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read($1,$2,$3)",
            &[&scope, &limit, &cursor],
        )
        .await
        .map_err(database_error)?
        .get(0);
    let mut rows = client
        .query(
            "SELECT * FROM cadence_private.read_owner_payments($1,$2)",
            &[&permit, &scope],
        )
        .await
        .map_err(database_error)?;
    let next_cursor = if rows.len() > limit as usize {
        rows.pop();
        rows.last().map(|r| r.get::<_, String>("payment_id"))
    } else {
        None
    };
    if limit == 10000 && next_cursor.is_some() {
        return Err(AppError::Conflict("export_too_large"));
    }
    let incoming = scope == "me";
    let items = tokio::task::spawn_blocking(move || {
        let _permit = worker_permit;
        rows.into_iter()
            .map(|r| payment(r, incoming))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| AppError::TransferUnavailable("read_worker_unavailable"))??;
    Ok(Page { items, next_cursor })
}
fn payment(row: Row, incoming: bool) -> Result<Payment, AppError> {
    let invalid = || AppError::TransferUnavailable("payment_read_unavailable");
    let sender = row
        .get::<_, &str>("sender")
        .parse()
        .map_err(|_| invalid())?;
    let destination = row
        .get::<_, &str>("destination")
        .parse()
        .map_err(|_| invalid())?;
    let transaction = row.get::<_, &str>("transaction");
    let public = fallback::transfer(transaction);
    let transparent = public.is_some();
    let amount = if let Some(public) = public {
        if public.sender != sender
            || public.destination != destination
            || public.mint != Addresses::for_usdc().wrapped_mint
        {
            return Err(invalid());
        }
        Zeroizing::new(public.amount)
    } else {
        let key = vault::key_from_row(&row).map_err(|_| invalid())?;
        if incoming {
            reveal_risk::received_amount(
                transaction,
                &destination,
                &Addresses::for_usdc().wrapped_mint,
                &key,
            )?
        } else {
            reveal_risk::sent_amount(
                transaction,
                &sender,
                &Addresses::for_usdc().wrapped_mint,
                &key,
            )?
        }
    };
    Ok(Payment {
        payment_id: row.get("payment_id"),
        run_id: row.get("run_id"),
        counterparty: Counterparty {
            id: row.get("counterparty_id"),
            name: row.get("counterparty_name"),
        },
        amount: amount.to_string(),
        status: "confirmed",
        transparent,
        paid_at: row.get("paid_at"),
        signature: row.get("signature"),
    })
}
#[derive(Serialize)]
pub struct RosterAmount {
    pub person_id: String,
    pub token_account: Option<String>,
    pub amount: Option<String>,
}
impl Drop for RosterAmount {
    fn drop(&mut self) {
        self.amount.zeroize();
    }
}
pub async fn roster(
    client: &Client,
    user: &str,
    limit: i32,
    cursor: Option<&str>,
) -> Result<Page<RosterAmount>, AppError> {
    identity(client, user).await?;
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read('roster',$1,$2)",
            &[&limit, &cursor],
        )
        .await
        .map_err(database_error)?
        .get(0);
    let mut rows = client
        .query(
            "SELECT * FROM cadence_private.read_roster_amounts($1)",
            &[&permit],
        )
        .await
        .map_err(database_error)?;
    let next_cursor = if rows.len() > limit as usize {
        rows.pop();
        rows.last().map(|r| r.get::<_, String>("person_id"))
    } else {
        None
    };
    Ok(Page {
        items: rows
            .into_iter()
            .map(|r| RosterAmount {
                person_id: r.get("person_id"),
                token_account: r.get("token_account"),
                amount: r.get("amount"),
            })
            .collect(),
        next_cursor,
    })
}
pub async fn set_amount(
    client: &Client,
    user: &str,
    person: &str,
    amount: &str,
) -> Result<(), AppError> {
    identity(client, user).await?;
    vault::check_logging(client)
        .await
        .map_err(|_| AppError::TransferUnavailable("unsafe_database_logging"))?;
    client
        .query_one(
            "SELECT cadence_private.store_roster_amount($1,$2)",
            &[&person, &amount],
        )
        .await
        .map_err(database_error)?;
    Ok(())
}
