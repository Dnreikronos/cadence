use crate::{auth::wallet_link_message, database::Database, error::AppError};
use solana_address::Address;
use solana_signature::Signature;
use std::str::FromStr;
use tokio_postgres::Row;

pub struct TransferStore {
    database: Database,
}

pub struct PreparedTransfer {
    pub id: String,
    pub company_wallet: String,
    pub sender: String,
    pub destination: String,
    pub transaction: String,
    pub last_valid_block_height: u64,
    pub signature: Option<String>,
    pub slot: Option<u64>,
}

fn unavailable() -> AppError {
    AppError::TransferUnavailable("transfer_storage_unavailable")
}

impl TransferStore {
    pub fn new(url: &str) -> Result<Self, AppError> {
        Ok(Self {
            database: Database::new(url, "cadence_transfer_service")?,
        })
    }

    pub async fn authorize_wallet(
        &self,
        user: &str,
        wallet: &Address,
        proof: Option<&str>,
    ) -> Result<(), AppError> {
        let client = self.database.connect().await?;
        let address = wallet.to_string();
        let owner = client
            .query_opt(
                "SELECT user_id::text FROM public.proof_wallets WHERE wallet = $1",
                &[&address],
            )
            .await
            .map_err(|_| unavailable())?;
        if let Some(owner) = owner {
            return if owner.get::<_, String>(0) == user {
                Ok(())
            } else {
                Err(AppError::Forbidden)
            };
        }
        let proof = proof.ok_or(AppError::Conflict("wallet_link_required"))?;
        let signature = Signature::from_str(proof).map_err(|_| AppError::Forbidden)?;
        if !signature.verify(wallet.as_ref(), &wallet_link_message(user, wallet)) {
            return Err(AppError::Forbidden);
        }
        client
            .execute(
                "INSERT INTO public.proof_wallets (wallet, user_id) VALUES ($1, $2::text::uuid) \
                 ON CONFLICT (wallet) DO NOTHING",
                &[&address, &user],
            )
            .await
            .map_err(|_| unavailable())?;
        let owner: String = client
            .query_one(
                "SELECT user_id::text FROM public.proof_wallets WHERE wallet = $1",
                &[&address],
            )
            .await
            .map_err(|_| unavailable())?
            .get(0);
        if owner != user {
            return Err(AppError::Forbidden);
        }
        Ok(())
    }

    pub async fn prepare(&self, user: &str, record: &PreparedTransfer) -> Result<(), AppError> {
        let height = i64::try_from(record.last_valid_block_height).map_err(|_| unavailable())?;
        self.database.connect().await?
            .execute(
                "INSERT INTO public.transfer_requests \
                 (id, user_id, company_wallet, sender, destination, transaction, last_valid_block_height) \
                 VALUES ($1, $2::text::uuid, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
                &[&record.id, &user, &record.company_wallet, &record.sender,
                  &record.destination, &record.transaction, &height],
            )
            .await
            .map_err(|_| unavailable())?;
        let stored = self.get(user, &record.id).await?;
        if stored.transaction != record.transaction
            || stored.company_wallet != record.company_wallet
            || stored.sender != record.sender
            || stored.destination != record.destination
            || stored.last_valid_block_height != record.last_valid_block_height
        {
            return Err(unavailable());
        }
        Ok(())
    }

    pub async fn get(&self, user: &str, id: &str) -> Result<PreparedTransfer, AppError> {
        let row = self
            .database
            .connect()
            .await?
            .query_opt(
                "SELECT id, company_wallet, sender, destination, transaction, \
                 last_valid_block_height, signature, slot, status FROM public.transfer_requests \
                 WHERE id = $1 AND user_id = $2::text::uuid",
                &[&id, &user],
            )
            .await
            .map_err(|_| unavailable())?
            .ok_or(AppError::TransferNotFound)?;
        if row.get::<_, &str>("status") == "failed" {
            return Err(AppError::Conflict("transaction_failed"));
        }
        record(row)
    }

    pub async fn submitted(
        &self,
        user: &str,
        record: &PreparedTransfer,
        signature: &str,
    ) -> Result<(), AppError> {
        crate::indexer::verify::submission(
            &record.id,
            &record.company_wallet,
            &record.transaction,
            signature,
        )?;
        let client = self.database.connect().await?;
        let count = client.execute("UPDATE public.transfer_requests SET submitted_signature=$3 WHERE id=$1 AND user_id=$2::text::uuid AND status='prepared' AND submitted_signature IS NULL", &[&record.id, &user, &signature])
            .await.map_err(|_| unavailable())?;
        if count == 1 {
            return Ok(());
        }
        let row = client.query_opt("SELECT coalesce(submitted_signature,signature) FROM public.transfer_requests WHERE id=$1 AND user_id=$2::text::uuid", &[&record.id, &user]).await.map_err(|_| unavailable())?;
        if row.is_some_and(|r| r.get::<_, Option<String>>(0).as_deref() == Some(signature)) {
            Ok(())
        } else {
            Err(AppError::Conflict("transfer_already_confirmed"))
        }
    }

    pub async fn confirm(
        &self,
        user: &str,
        id: &str,
        signature: &str,
        slot: u64,
    ) -> Result<(), AppError> {
        let slot_value = i64::try_from(slot).map_err(|_| AppError::RpcUnavailable)?;
        let updated = self
            .database
            .connect()
            .await?
            .execute(
                "UPDATE public.transfer_requests SET signature = $3, slot = $4 \
                 WHERE id = $1 AND user_id = $2::text::uuid AND signature IS NULL",
                &[&id, &user, &signature, &slot_value],
            )
            .await
            .map_err(|_| unavailable())?;
        if updated == 1 {
            return Ok(());
        }
        let existing = self.get(user, id).await?;
        if existing.signature.as_deref() == Some(signature) && existing.slot == Some(slot) {
            Ok(())
        } else {
            Err(AppError::Conflict("transfer_already_confirmed"))
        }
    }
}

fn record(row: Row) -> Result<PreparedTransfer, AppError> {
    let height: i64 = row
        .try_get("last_valid_block_height")
        .map_err(|_| unavailable())?;
    let slot: Option<i64> = row.try_get("slot").map_err(|_| unavailable())?;
    Ok(PreparedTransfer {
        id: row.try_get("id").map_err(|_| unavailable())?,
        company_wallet: row.try_get("company_wallet").map_err(|_| unavailable())?,
        sender: row.try_get("sender").map_err(|_| unavailable())?,
        destination: row.try_get("destination").map_err(|_| unavailable())?,
        transaction: row.try_get("transaction").map_err(|_| unavailable())?,
        last_valid_block_height: u64::try_from(height).map_err(|_| unavailable())?,
        signature: row.try_get("signature").map_err(|_| unavailable())?,
        slot: slot
            .map(u64::try_from)
            .transpose()
            .map_err(|_| unavailable())?,
    })
}
