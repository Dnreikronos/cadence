use crate::{
    database::{Database, Session},
    error::AppError,
    keys::vault,
    solana::{reveal_risk, token_wrap::Addresses},
};
use serde::Serialize;
use tokio_postgres::Row;
use zeroize::Zeroize;

pub struct AuditStore {
    database: Database,
}

#[derive(Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize)]
pub struct Counterparty {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Serialize)]
pub struct Payment {
    pub payment_id: String,
    pub run_id: Option<String>,
    pub counterparty: Counterparty,
    pub amount: String,
    pub status: &'static str,
    pub transparent: bool,
    pub paid_at: String,
    pub signature: String,
}
impl Drop for Payment {
    /// Clear the response model's plaintext amount when it is released.
    fn drop(&mut self) {
        self.amount.zeroize();
    }
}

#[derive(Serialize)]
pub struct Grant {
    pub id: String,
    pub company_id: String,
    pub auditor_id: String,
    pub granted_at: String,
}
const GRANT_COLUMNS: &str = "id::text, company_id::text, user_id::text AS auditor_id, \
    to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS granted_at";

/// Preserve the fixed scope-denial code and hide other database error details.
fn database_error(error: tokio_postgres::Error) -> AppError {
    if error.code().is_some_and(|code| code.code() == "CD404") {
        AppError::AuditNotFound
    } else {
        AppError::AuditUnavailable
    }
}

impl AuditStore {
    /// Require the dedicated audit role; privileged or unrelated roles are rejected.
    pub fn new(url: &str) -> Result<Self, AppError> {
        Ok(Self {
            database: Database::new(url, "cadence_audit_service")?,
        })
    }

    /// Set RLS identity from a verified Supabase user, never from request parameters.
    async fn session(&self, user: &str) -> Result<Session, AppError> {
        let session = self
            .database
            .connect()
            .await
            .map_err(|_| AppError::AuditUnavailable)?;
        session
            .query_one(
                "SELECT set_config('request.jwt.claim.sub', $1, false)",
                &[&user],
            )
            .await
            .map_err(database_error)?;
        Ok(session)
    }

    /// Commit one audit row before reading this page's sender keys from Vault.
    /// The caller must supply a verified user and a validated limit of 1 to 100.
    /// SQL checks the company grant at permit creation and again before key access.
    pub async fn payments(
        &self,
        user: &str,
        company: &str,
        limit: i32,
        cursor: Option<&str>,
    ) -> Result<Page<Payment>, AppError> {
        let session = self.session(user).await?;
        let permit = super::log::company_read_permit(&session, company, limit, cursor)
            .await
            .map_err(database_error)?;
        let mut rows = session
            .query(
                "SELECT * FROM cadence_private.read_company_payments($1, $2)",
                &[&company, &permit],
            )
            .await
            .map_err(database_error)?;
        let next_cursor = if rows.len() > limit as usize {
            rows.pop();
            Some(
                rows.last()
                    .ok_or(AppError::AuditUnavailable)?
                    .get::<_, String>("payment_id"),
            )
        } else {
            None
        };
        drop(session);
        let items = tokio::task::spawn_blocking(move || {
            rows.into_iter().map(payment).collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(|_| AppError::AuditUnavailable)??;
        Ok(Page { items, next_cursor })
    }

    /// Resolve the company from the verified user's current admin membership.
    async fn admin(&self, user: &str) -> Result<(Session, String), AppError> {
        let session = self.session(user).await?;
        let row = session.query_opt("SELECT company_id::text FROM cadence_rls.current_membership() WHERE role = 'admin'", &[])
            .await.map_err(database_error)?.ok_or(AppError::ForbiddenRole)?;
        Ok((session, row.get(0)))
    }

    /// List the admin's company grants after the optional grant UUID cursor.
    /// The caller must validate the limit to 1 through 100; this reads no keys.
    pub async fn grants(
        &self,
        user: &str,
        limit: i32,
        cursor: Option<&str>,
    ) -> Result<Page<Grant>, AppError> {
        let (session, company) = self.admin(user).await?;
        let mut rows = session.query(&format!("SELECT {GRANT_COLUMNS} FROM public.auditor_grants WHERE company_id=$1::text::uuid AND ($2::text IS NULL OR id>$2::text::uuid) ORDER BY id LIMIT $3::integer"), &[&company, &cursor, &(limit + 1)])
            .await.map_err(database_error)?;
        let next_cursor = if rows.len() > limit as usize {
            rows.pop();
            Some(
                rows.last()
                    .ok_or(AppError::AuditUnavailable)?
                    .get::<_, String>("id"),
            )
        } else {
            None
        };
        Ok(Page {
            items: rows.into_iter().map(grant).collect(),
            next_cursor,
        })
    }

    /// Grant an existing auditor in the verified admin's company.
    /// Duplicate grants return a conflict; missing or foreign identities return 404.
    pub async fn create_grant(&self, user: &str, auditor: &str) -> Result<Grant, AppError> {
        let (session, company) = self.admin(user).await?;
        let row = session.query_opt(&format!("INSERT INTO public.auditor_grants (company_id, user_id) SELECT company_id, user_id FROM public.memberships WHERE company_id=$1::text::uuid AND user_id=$2::text::uuid AND role='auditor' ON CONFLICT DO NOTHING RETURNING {GRANT_COLUMNS}"), &[&company, &auditor])
            .await.map_err(database_error)?;
        if let Some(row) = row {
            return Ok(grant(row));
        }
        let exists = session.query_opt("SELECT id FROM public.auditor_grants WHERE company_id=$1::text::uuid AND user_id=$2::text::uuid", &[&company, &auditor]).await.map_err(database_error)?;
        Err(if exists.is_some() {
            AppError::Conflict("auditor_already_active")
        } else {
            AppError::AuditNotFound
        })
    }

    /// Delete an own-company grant without changing the auditor's membership.
    /// Missing and foreign grant IDs share the same scope-denial error.
    pub async fn revoke_grant(&self, user: &str, id: &str) -> Result<(), AppError> {
        let (session, company) = self.admin(user).await?;
        let count = session.execute("DELETE FROM public.auditor_grants WHERE company_id=$1::text::uuid AND id=$2::text::uuid", &[&company, &id]).await.map_err(database_error)?;
        if count == 1 {
            Ok(())
        } else {
            Err(AppError::AuditNotFound)
        }
    }
}

/// Convert the grant query's fixed projection into public response metadata.
fn grant(row: Row) -> Grant {
    Grant {
        id: row.get("id"),
        company_id: row.get("company_id"),
        auditor_id: row.get("auditor_id"),
        granted_at: row.get("granted_at"),
    }
}

/// Decode an audited finalized receipt with its bound sender key and wrapped mint.
/// Missing recipient metadata falls back to the destination address and a null ID.
fn payment(row: Row) -> Result<Payment, AppError> {
    let key = vault::key_from_row(&row).map_err(|_| AppError::AuditUnavailable)?;
    let sender = row
        .get::<_, &str>("sender")
        .parse()
        .map_err(|_| AppError::AuditUnavailable)?;
    let amount = reveal_risk::sent_amount(
        row.get("transaction"),
        &sender,
        &Addresses::for_usdc().wrapped_mint,
        &key,
    )
    .map_err(|_| AppError::AuditUnavailable)?;
    Ok(Payment {
        payment_id: row.get("payment_id"),
        run_id: row.get("run_id"),
        counterparty: Counterparty {
            id: row.get("person_id"),
            name: row
                .get::<_, Option<String>>("person_name")
                .unwrap_or_else(|| row.get("destination")),
        },
        amount: amount.to_string(),
        status: "confirmed",
        transparent: false,
        paid_at: row.get("paid_at"),
        signature: row.get("signature"),
    })
}
