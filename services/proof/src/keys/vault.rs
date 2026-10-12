//! Supabase Vault storage; no external KMS credentials are used.
//! Callers own authentication, account authorization, TLS, and connection timeouts.
//! Use an autocommit cadence_key_service connection and never manually roll back reads.
use super::elgamal::{DerivationError, ViewingKey};
use crate::audit::log::{key_read_permit, AuditEntry, AuditError};
use base64::{engine::general_purpose::STANDARD, Engine};
use solana_address::Address;
use solana_signature::Signature;
use solana_zk_sdk::encryption::{
    auth_encryption::AeKey, derivation::derive_confidential_keys_from_signature,
};
use tokio_postgres::Client;
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error(transparent)]
    Derivation(#[from] DerivationError),
    #[error(transparent)]
    Audit(#[from] AuditError),
    #[error("viewing key storage is unavailable")]
    Unavailable,
    #[error("viewing key storage requires disabled parameter logging")]
    UnsafeLogging,
    #[error("stored viewing key is invalid")]
    InvalidKey,
}

// Check before transmitting a plaintext key, including on pooled/SET ROLE connections.
pub(crate) async fn check_logging(client: &Client) -> Result<(), KeyStoreError> {
    let row = client
        .query_one(
            "SELECT (current_setting('log_parameter_max_length') = '0' OR (\
             current_setting('log_statement') IN ('none', 'ddl') \
             AND current_setting('log_min_duration_statement') = '-1' \
             AND current_setting('log_min_duration_sample') = '-1' \
             AND current_setting('log_duration') = 'off')) \
             AND current_setting('log_parameter_max_length_on_error') = '0' \
             AND coalesce(current_setting('pgaudit.log_parameter', true), 'off') = 'off'",
            &[],
        )
        .await
        .map_err(|_| KeyStoreError::Unavailable)?;
    if !row.get::<_, bool>(0) {
        return Err(KeyStoreError::UnsafeLogging);
    }
    Ok(())
}

/// Register once; duplicate accounts fail without replacing an existing key.
/// Verify wallet/account authorization before calling. Never log the signature.
pub async fn enroll(
    client: &Client,
    wallet: &Address,
    account: &Address,
    signature: &Signature,
) -> Result<[u8; 32], KeyStoreError> {
    check_logging(client).await?;
    let key = ViewingKey::derive(wallet, account, signature)?;
    let public = key.public_key().to_bytes();
    let encoded = Zeroizing::new(STANDARD.encode(key.secret_bytes()));
    client
        .query_one(
            "SELECT cadence_private.store_viewing_key($1, $2, $3, $4)",
            &[
                &wallet.to_string(),
                &account.to_string(),
                &&public[..],
                &encoded.as_str(),
            ],
        )
        .await
        .map_err(|_| KeyStoreError::Unavailable)?;
    Ok(public)
}

pub async fn metadata(
    client: &Client,
    wallet: &Address,
    account: &Address,
) -> Result<Option<([u8; 32], bool)>, KeyStoreError> {
    client
        .query_opt(
            "SELECT * FROM cadence_private.account_key_metadata($1,$2)",
            &[&wallet.to_string(), &account.to_string()],
        )
        .await
        .map_err(|_| KeyStoreError::Unavailable)?
        .map(|row| {
            let public: Vec<u8> = row.get(0);
            Ok((
                public.try_into().map_err(|_| KeyStoreError::InvalidKey)?,
                row.get(1),
            ))
        })
        .transpose()
}

/// Stores both derived keys as Vault ciphertext in one database statement.
pub async fn enroll_account(
    client: &Client,
    wallet: &Address,
    account: &Address,
    signature: &Signature,
) -> Result<[u8; 32], KeyStoreError> {
    check_logging(client).await?;
    let key = ViewingKey::derive(wallet, account, signature)?;
    let (_, aes) = derive_confidential_keys_from_signature(signature)
        .map_err(|_| KeyStoreError::InvalidKey)?;
    let aes = Zeroizing::new(aes);
    let public = key.public_key().to_bytes();
    let secret = Zeroizing::new(STANDARD.encode(key.secret_bytes()));
    let bytes = Zeroizing::new(<[u8; 16]>::from(&*aes));
    let balance = Zeroizing::new(STANDARD.encode(*bytes));
    client
        .query_one(
            "SELECT cadence_private.store_account_keys($1,$2,$3,$4,$5)",
            &[
                &wallet.to_string(),
                &account.to_string(),
                &&public[..],
                &secret.as_str(),
                &balance.as_str(),
            ],
        )
        .await
        .map_err(|_| KeyStoreError::Unavailable)?;
    Ok(public)
}

pub async fn load_account(
    client: &Client,
    wallet: &Address,
    account: &Address,
    actor: &str,
    reason: &str,
) -> Result<(ViewingKey, Zeroizing<AeKey>), KeyStoreError> {
    let account = account.to_string();
    let entry = AuditEntry::new(actor, reason, &account)?;
    let permit = key_read_permit(client, &entry).await?;
    let row = client
        .query_one(
            "SELECT * FROM cadence_private.read_account_keys($1,$2,$3)",
            &[&wallet.to_string(), &account, &permit],
        )
        .await
        .map_err(|_| KeyStoreError::Unavailable)?;
    let bytes = Zeroizing::new(row.get::<_, Vec<u8>>("balance_key"));
    let aes =
        Zeroizing::new(AeKey::try_from(bytes.as_slice()).map_err(|_| KeyStoreError::InvalidKey)?);
    Ok((key_from_row(&row)?, aes))
}

/// Each attempt persists attribution before Vault can decrypt. No decrypted cache.
/// Actor/reason come from trusted authenticated context, never arbitrary request fields.
pub async fn load(
    client: &Client,
    wallet: &Address,
    account: &Address,
    actor: &str,
    reason: &str,
) -> Result<ViewingKey, KeyStoreError> {
    let account = account.to_string();
    let entry = AuditEntry::new(actor, reason, &account)?;
    let permit = key_read_permit(client, &entry).await?;
    let row = client
        .query_one(
            "SELECT public_key, secret FROM cadence_private.read_viewing_key($1, $2, $3)",
            &[&wallet.to_string(), &account, &permit],
        )
        .await
        .map_err(|_| KeyStoreError::Unavailable)?;
    key_from_row(&row)
}

/// Only call on rows returned by a committed, audited Vault accessor.
pub(crate) fn key_from_row(row: &tokio_postgres::Row) -> Result<ViewingKey, KeyStoreError> {
    let secret = Zeroizing::new(
        row.try_get::<_, Vec<u8>>("secret")
            .map_err(|_| KeyStoreError::InvalidKey)?,
    );
    let key = ViewingKey::from_secret_bytes(&secret).map_err(|_| KeyStoreError::InvalidKey)?;
    if key.public_key().to_bytes().as_slice()
        != row
            .try_get::<_, &[u8]>("public_key")
            .map_err(|_| KeyStoreError::InvalidKey)?
    {
        return Err(KeyStoreError::InvalidKey);
    }
    Ok(key)
}
