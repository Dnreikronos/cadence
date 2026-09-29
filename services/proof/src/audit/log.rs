use solana_address::Address;
use tokio_postgres::Client;

#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    #[error("audit actor is required")]
    MissingActor,
    #[error("audit reason is required")]
    MissingReason,
    #[error("audit target must be a Solana account public key")]
    InvalidTarget,
    #[error("audit record could not be persisted")]
    Unavailable,
}

/// Validated attribution, with no amount or arbitrary metadata fields.
pub struct AuditEntry<'a> {
    actor: &'a str,
    reason: &'a str,
    target_account: &'a str,
}

impl<'a> AuditEntry<'a> {
    /// Identity must come from authenticated context, not a request's actor field.
    /// Reasons must describe the operation without including amounts or secrets.
    pub fn new(
        actor: &'a str,
        reason: &'a str,
        target_account: &'a str,
    ) -> Result<Self, AuditError> {
        if actor.trim().is_empty() {
            return Err(AuditError::MissingActor);
        }
        if reason.trim().is_empty() {
            return Err(AuditError::MissingReason);
        }
        target_account
            .parse::<Address>()
            .map_err(|_| AuditError::InvalidTarget)?;
        Ok(Self {
            actor,
            reason,
            target_account,
        })
    }
}

/// Append on an autocommit service_role connection before accessing a secret.
/// The caller must abort key access on error and must not surround this call with
/// a transaction that can later roll back. Connection setup owns TLS and timeouts.
pub async fn append(client: &Client, entry: &AuditEntry<'_>) -> Result<(), AuditError> {
    client
        .execute(
            "INSERT INTO public.decryption_audit_log (actor, reason, target_account) VALUES ($1, $2, $3)",
            &[&entry.actor, &entry.reason, &entry.target_account],
        )
        .await
        .map_err(|_| AuditError::Unavailable)?;
    Ok(())
}
