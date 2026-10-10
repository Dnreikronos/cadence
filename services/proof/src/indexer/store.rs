use crate::{database::Database, error::AppError};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Run,
    Wrap,
    Transfer,
    Unwrap,
}
impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Wrap => "wrap",
            Self::Transfer => "transfer",
            Self::Unwrap => "unwrap",
        }
    }
    fn table(self) -> &'static str {
        match self {
            Self::Run => "payments",
            Self::Wrap => "wrap_requests",
            Self::Transfer => "transfer_requests",
            Self::Unwrap => "unwrap_requests",
        }
    }
}

#[derive(Clone)]
pub struct Pending {
    pub kind: Kind,
    pub id: String,
    pub wallet: String,
    pub transaction: String,
    pub signature: Option<String>,
    pub last_valid_block_height: u64,
}

#[derive(Default)]
pub(super) struct Cursor {
    pub head: Option<String>,
    pub before: Option<String>,
}

pub struct Store {
    database: Database,
}
impl Store {
    pub fn new(url: &str) -> Result<Self, AppError> {
        Ok(Self {
            database: Database::new(url, "cadence_indexer")?,
        })
    }
    pub async fn pending(&self) -> Result<Vec<Pending>, AppError> {
        self.read(None, None, None).await
    }
    pub(super) async fn pending_from(&self, minimum_expiry: u64) -> Result<Vec<Pending>, AppError> {
        let minimum_expiry = i64::try_from(minimum_expiry).map_err(|_| AppError::RpcUnavailable)?;
        self.read(None, None, Some(minimum_expiry)).await
    }
    async fn read(
        &self,
        id: Option<&str>,
        wallet: Option<&str>,
        minimum_expiry: Option<i64>,
    ) -> Result<Vec<Pending>, AppError> {
        let client = self.database.connect().await?;
        let rows = client.query(
            "SELECT * FROM (SELECT 'run' AS kind, p.request_id AS id, r.company_wallet AS wallet, p.transaction, p.submitted_signature, p.last_valid_block_height \
             FROM public.payments p JOIN public.runs r ON r.id=p.run_id WHERE p.status='prepared' \
             UNION ALL SELECT 'wrap',id,company_wallet,transaction,submitted_signature,last_valid_block_height FROM public.wrap_requests WHERE status='prepared' \
             UNION ALL SELECT 'transfer',id,company_wallet,transaction,submitted_signature,last_valid_block_height FROM public.transfer_requests WHERE status='prepared' \
             UNION ALL SELECT 'unwrap',id,wallet,transaction,submitted_signature,last_valid_block_height FROM public.unwrap_requests WHERE status='prepared') pending \
             WHERE ($1::text IS NULL OR id=$1) AND ($2::text IS NULL OR wallet=$2) AND ($3::bigint IS NULL OR last_valid_block_height >= $3)",
            &[&id, &wallet, &minimum_expiry],
        ).await.map_err(|_| AppError::StorageUnavailable)?;
        rows.into_iter()
            .map(|row| {
                Ok(Pending {
                    kind: match row.get::<_, &str>("kind") {
                        "run" => Kind::Run,
                        "wrap" => Kind::Wrap,
                        "transfer" => Kind::Transfer,
                        "unwrap" => Kind::Unwrap,
                        _ => return Err(AppError::StorageUnavailable),
                    },
                    id: row
                        .try_get("id")
                        .map_err(|_| AppError::StorageUnavailable)?,
                    wallet: row
                        .try_get("wallet")
                        .map_err(|_| AppError::StorageUnavailable)?,
                    transaction: row
                        .try_get("transaction")
                        .map_err(|_| AppError::StorageUnavailable)?,
                    signature: row
                        .try_get("submitted_signature")
                        .map_err(|_| AppError::StorageUnavailable)?,
                    last_valid_block_height: u64::try_from(
                        row.get::<_, i64>("last_valid_block_height"),
                    )
                    .map_err(|_| AppError::StorageUnavailable)?,
                })
            })
            .collect()
    }
    pub async fn finish(
        &self,
        p: &Pending,
        signature: &str,
        slot: u64,
        failed: bool,
    ) -> Result<(), AppError> {
        let client = self.database.connect().await?;
        let slot = i64::try_from(slot).map_err(|_| AppError::RpcUnavailable)?;
        let status = if failed { "failed" } else { "finalized" };
        let sql = match p.kind {
            Kind::Run => "UPDATE public.payments SET status=$2,signature=$3,slot=$4,error=CASE WHEN $2='failed' THEN 'transaction_failed' ELSE NULL END \
                          WHERE request_id=$1 AND status='prepared' AND (submitted_signature IS NULL OR submitted_signature=$3)".into(),
            kind => format!("UPDATE public.{} SET status=$2,signature=$3,slot=$4 WHERE id=$1 AND status='prepared' AND (submitted_signature IS NULL OR submitted_signature=$3)", kind.table()),
        };
        let count = client
            .execute(&sql, &[&p.id, &status, &signature, &slot])
            .await
            .map_err(|_| AppError::StorageUnavailable)?;
        if count == 1 {
            return Ok(());
        }
        // An HTTP confirmation or another replica may already have recorded it.
        let column = if p.kind == Kind::Run {
            "request_id"
        } else {
            "id"
        };
        let existing = client
            .query_opt(
                &format!(
                    "SELECT status,signature,slot FROM public.{} WHERE {}=$1",
                    p.kind.table(),
                    column
                ),
                &[&p.id],
            )
            .await
            .map_err(|_| AppError::StorageUnavailable)?;
        if existing.is_some_and(|row| {
            row.get::<_, String>(0) == status
                && row.get::<_, Option<String>>(1).as_deref() == Some(signature)
                && row.get::<_, Option<i64>>(2) == Some(slot)
        }) {
            Ok(())
        } else {
            Err(AppError::Conflict("payment_attempt_changed"))
        }
    }
    pub async fn cursors(&self) -> Result<HashMap<String, String>, AppError> {
        Ok(self
            .database
            .connect()
            .await?
            .query(
                "SELECT wallet,signature FROM public.indexer_cursors WHERE signature IS NOT NULL",
                &[],
            )
            .await
            .map_err(|_| AppError::StorageUnavailable)?
            .into_iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect())
    }
    pub async fn cursor(&self, wallet: &str, signature: &str) -> Result<(), AppError> {
        self.database.connect().await?.execute("INSERT INTO public.indexer_cursors (wallet,signature) VALUES ($1,$2) ON CONFLICT (wallet) DO UPDATE SET signature=EXCLUDED.signature,scan_head=NULL,scan_before=NULL", &[&wallet, &signature])
            .await.map_err(|_| AppError::StorageUnavailable)?;
        Ok(())
    }
    pub(super) async fn scan(&self, wallet: &str) -> Result<Cursor, AppError> {
        let row = self
            .database
            .connect()
            .await?
            .query_opt(
                "SELECT scan_head,scan_before FROM public.indexer_cursors WHERE wallet=$1",
                &[&wallet],
            )
            .await
            .map_err(|_| AppError::StorageUnavailable)?;
        Ok(row
            .map(|row| Cursor {
                head: row.get(0),
                before: row.get(1),
            })
            .unwrap_or_default())
    }
    pub(super) async fn checkpoint(
        &self,
        wallet: &str,
        head: &str,
        before: &str,
    ) -> Result<(), AppError> {
        self.database.connect().await?.execute("INSERT INTO public.indexer_cursors (wallet,scan_head,scan_before) VALUES ($1,$2,$3) ON CONFLICT (wallet) DO UPDATE SET scan_head=EXCLUDED.scan_head,scan_before=EXCLUDED.scan_before", &[&wallet, &head, &before])
            .await.map_err(|_| AppError::StorageUnavailable)?;
        Ok(())
    }
    pub async fn find(&self, id: &str, wallet: &str) -> Result<Vec<Pending>, AppError> {
        // Refresh after observing the chain: preparations may commit during discovery.
        self.read(Some(id), Some(wallet), None).await
    }
}
