use crate::{database::Database, error::AppError, solana::reveal_risk::Match};
use solana_address::Address;
use tokio_postgres::Row;

pub struct UnwrapStore {
    database: Database,
}

pub struct PreparedUnwrap {
    pub id: String,
    pub wallet: String,
    pub source: String,
    pub destination: String,
    pub transaction: String,
    pub last_valid_block_height: u64,
    pub signature: Option<String>,
    pub slot: Option<u64>,
}
pub struct ReceivedPayment {
    pub payment: Match,
    pub transaction: String,
}
fn unavailable() -> AppError {
    AppError::UnwrapUnavailable("unwrap_storage_unavailable")
}

impl UnwrapStore {
    pub fn new(url: &str) -> Result<Self, AppError> {
        Ok(Self {
            database: Database::new(url, "cadence_transfer_service")?,
        })
    }

    pub async fn received(
        &self,
        user: &str,
        wallet: &Address,
        account: &Address,
    ) -> Result<Vec<ReceivedPayment>, AppError> {
        let rows = self.database.connect().await.map_err(|_| unavailable())?.query(
            "SELECT payment_id::text, to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS paid_at, transaction \
             FROM (SELECT payment_id, coalesce(paid_at, created_at) AS paid_at, transaction FROM public.transfer_requests \
                   WHERE destination = $1 AND signature IS NOT NULL \
                   UNION ALL SELECT p.payment_id, coalesce(p.paid_at, r.created_at), p.transaction FROM public.payments p \
                   JOIN public.runs r ON r.id = p.run_id WHERE p.destination = $1 AND p.status = 'finalized') received \
             WHERE EXISTS (SELECT 1 FROM public.proof_wallets WHERE wallet = $2 AND user_id = $3::text::uuid) \
             ORDER BY payment_id LIMIT 1001",
            &[&account.to_string(), &wallet.to_string(), &user],
        ).await.map_err(|_| unavailable())?;
        if rows.len() > 1000 {
            return Err(AppError::UnwrapUnavailable("reveal_history_unavailable"));
        }
        rows.into_iter()
            .map(|row| {
                Ok(ReceivedPayment {
                    payment: Match {
                        payment_id: row.try_get("payment_id").map_err(|_| unavailable())?,
                        paid_at: row.try_get("paid_at").map_err(|_| unavailable())?,
                    },
                    transaction: row.try_get("transaction").map_err(|_| unavailable())?,
                })
            })
            .collect()
    }

    pub async fn prepare(&self, user: &str, record: &PreparedUnwrap) -> Result<(), AppError> {
        let height = i64::try_from(record.last_valid_block_height).map_err(|_| unavailable())?;
        self.database.connect().await.map_err(|_| unavailable())?.execute(
            "INSERT INTO public.unwrap_requests (id, user_id, wallet, source, destination, transaction, last_valid_block_height) \
             VALUES ($1, $2::text::uuid, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
            &[&record.id, &user, &record.wallet, &record.source, &record.destination, &record.transaction, &height],
        ).await.map_err(|_| unavailable())?;
        let stored = self.get(user, &record.id).await?;
        if stored.transaction != record.transaction
            || stored.wallet != record.wallet
            || stored.source != record.source
            || stored.destination != record.destination
            || stored.last_valid_block_height != record.last_valid_block_height
        {
            return Err(unavailable());
        }
        Ok(())
    }

    pub async fn get(&self, user: &str, id: &str) -> Result<PreparedUnwrap, AppError> {
        let row = self.database.connect().await.map_err(|_| unavailable())?.query_opt(
            "SELECT id, wallet, source, destination, transaction, last_valid_block_height, signature, slot \
             FROM public.unwrap_requests WHERE id = $1 AND user_id = $2::text::uuid", &[&id, &user],
        ).await.map_err(|_| unavailable())?.ok_or(AppError::UnwrapNotFound)?;
        record(row)
    }

    pub async fn confirm(
        &self,
        user: &str,
        id: &str,
        signature: &str,
        slot: u64,
    ) -> Result<(), AppError> {
        let value = i64::try_from(slot).map_err(|_| AppError::RpcUnavailable)?;
        let updated = self
            .database
            .connect()
            .await
            .map_err(|_| unavailable())?
            .execute(
                "UPDATE public.unwrap_requests SET signature = $3, slot = $4 \
             WHERE id = $1 AND user_id = $2::text::uuid AND signature IS NULL",
                &[&id, &user, &signature, &value],
            )
            .await
            .map_err(|_| unavailable())?;
        if updated == 1 {
            return Ok(());
        }
        let stored = self.get(user, id).await?;
        if stored.signature.as_deref() == Some(signature) && stored.slot == Some(slot) {
            Ok(())
        } else {
            Err(AppError::Conflict("unwrap_already_confirmed"))
        }
    }
}

fn record(row: Row) -> Result<PreparedUnwrap, AppError> {
    let height: i64 = row
        .try_get("last_valid_block_height")
        .map_err(|_| unavailable())?;
    let slot: Option<i64> = row.try_get("slot").map_err(|_| unavailable())?;
    Ok(PreparedUnwrap {
        id: row.try_get("id").map_err(|_| unavailable())?,
        wallet: row.try_get("wallet").map_err(|_| unavailable())?,
        source: row.try_get("source").map_err(|_| unavailable())?,
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
