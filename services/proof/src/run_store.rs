use crate::{database::Database, error::AppError};
use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, Row};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Prepared,
    Finalized,
    Failed,
    Expired,
    PreparationFailed,
}
impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Finalized => "finalized",
            Self::Failed => "failed",
            Self::Expired => "expired",
            Self::PreparationFailed => "preparation_failed",
        }
    }
}

pub struct Payment {
    pub position: i16,
    pub destination: String,
    pub attempt: i32,
    pub request_id: Option<String>,
    pub transaction: Option<String>,
    pub last_valid_block_height: Option<i64>,
    pub status: Status,
    pub signature: Option<String>,
    pub slot: Option<i64>,
    pub error: Option<String>,
}
pub struct Run {
    pub id: String,
    pub company_wallet: String,
    pub sender: String,
    pub payments: Vec<Payment>,
}
pub struct RunStore {
    database: Database,
}
pub fn unavailable() -> AppError {
    AppError::RunUnavailable
}

impl RunStore {
    pub fn new(url: &str) -> Result<Self, AppError> {
        Ok(Self {
            database: Database::new(url, "cadence_transfer_service")?,
        })
    }
    pub async fn get(&self, user: &str, id: &str) -> Result<Run, AppError> {
        let client = self.database.connect().await.map_err(|_| unavailable())?;
        read(&client, user, id).await
    }
    pub async fn prepare(
        &self,
        user: &str,
        wallet: &str,
        sender: &str,
        payments: &[Payment],
    ) -> Result<Run, AppError> {
        let client = self.database.connect().await.map_err(|_| unavailable())?;
        client
            .batch_execute("BEGIN")
            .await
            .map_err(|_| unavailable())?;
        let id: String = client.query_one(
            "INSERT INTO public.runs (user_id, company_wallet, sender) VALUES ($1::text::uuid, $2, $3) RETURNING id::text",
            &[&user, &wallet, &sender],
        ).await.map_err(|_| unavailable())?.get(0);
        for p in payments {
            client.execute(
                "INSERT INTO public.payments (run_id, position, destination, request_id, transaction, last_valid_block_height, status, error) \
                 VALUES ($1::text::uuid,$2,$3,$4,$5,$6,$7,$8)",
                &[&id, &p.position, &p.destination, &p.request_id, &p.transaction, &p.last_valid_block_height, &p.status.name(), &p.error],
            ).await.map_err(|_| unavailable())?;
        }
        client
            .batch_execute("COMMIT")
            .await
            .map_err(|_| unavailable())?;
        read(&client, user, &id).await
    }
    pub async fn retry(&self, user: &str, id: &str, payments: &[Payment]) -> Result<Run, AppError> {
        let client = self.database.connect().await.map_err(|_| unavailable())?;
        client
            .batch_execute("BEGIN")
            .await
            .map_err(|_| unavailable())?;
        let locked = client.query("SELECT p.position FROM public.payments p JOIN public.runs r ON r.id=p.run_id \
            WHERE r.id=$1::text::uuid AND r.user_id=$2::text::uuid ORDER BY p.position FOR UPDATE OF p", &[&id, &user])
            .await.map_err(|_| unavailable())?;
        if locked.is_empty() {
            return Err(AppError::RunNotFound);
        }
        for p in payments {
            let count = client.execute(
                "UPDATE public.payments SET attempt = attempt + 1, request_id = $4, transaction = $5, last_valid_block_height = $6, \
                 status = $7, error = $8, signature = NULL, slot = NULL WHERE run_id = $1::text::uuid AND position = $2 AND attempt = $3 \
                 AND status IN ('failed','expired','preparation_failed')",
                &[&id, &p.position, &p.attempt, &p.request_id, &p.transaction, &p.last_valid_block_height, &p.status.name(), &p.error],
            ).await.map_err(|_| unavailable())?;
            if count != 1 {
                return Err(AppError::Conflict("payment_attempt_changed"));
            }
        }
        client
            .batch_execute("COMMIT")
            .await
            .map_err(|_| unavailable())?;
        read(&client, user, id).await
    }
    pub async fn finish(&self, user: &str, id: &str, payment: &Payment) -> Result<(), AppError> {
        let client = self.database.connect().await.map_err(|_| unavailable())?;
        let count = client.execute(
            "UPDATE public.payments p SET status=$5,signature=$6,slot=$7,error=$8 FROM public.runs r \
             WHERE p.run_id=r.id AND r.id=$1::text::uuid AND r.user_id=$2::text::uuid AND p.position=$3 AND p.attempt=$4 AND p.status='prepared'",
            &[&id, &user, &payment.position, &payment.attempt, &payment.status.name(), &payment.signature, &payment.slot, &payment.error],
        ).await.map_err(|_| unavailable())?;
        if count == 1 {
            return Ok(());
        }
        let stored = read(&client, user, id).await?;
        let existing = stored
            .payments
            .iter()
            .find(|p| p.position == payment.position)
            .ok_or(AppError::RunNotFound)?;
        if existing.attempt == payment.attempt
            && existing.status == payment.status
            && existing.signature == payment.signature
            && existing.slot == payment.slot
        {
            Ok(())
        } else {
            Err(AppError::Conflict("payment_attempt_changed"))
        }
    }
}

async fn read(client: &Client, user: &str, id: &str) -> Result<Run, AppError> {
    let row = client.query_opt(
        "SELECT company_wallet, sender FROM public.runs WHERE id=$1::text::uuid AND user_id=$2::text::uuid",
        &[&id, &user],
    ).await.map_err(|_| unavailable())?.ok_or(AppError::RunNotFound)?;
    let rows = client
        .query(
            "SELECT p.* FROM public.payments p JOIN public.runs r ON r.id=p.run_id \
         WHERE r.id=$1::text::uuid AND r.user_id=$2::text::uuid ORDER BY p.position",
            &[&id, &user],
        )
        .await
        .map_err(|_| unavailable())?;
    Ok(Run {
        id: id.to_owned(),
        company_wallet: row.get(0),
        sender: row.get(1),
        payments: rows.into_iter().map(payment).collect::<Result<_, _>>()?,
    })
}
fn payment(row: Row) -> Result<Payment, AppError> {
    let status: String = row.get("status");
    let status = match status.as_str() {
        "prepared" => Status::Prepared,
        "finalized" => Status::Finalized,
        "failed" => Status::Failed,
        "expired" => Status::Expired,
        "preparation_failed" => Status::PreparationFailed,
        _ => return Err(unavailable()),
    };
    Ok(Payment {
        position: row.get("position"),
        destination: row.get("destination"),
        attempt: row.get("attempt"),
        request_id: row.get("request_id"),
        transaction: row.get("transaction"),
        last_valid_block_height: row.get("last_valid_block_height"),
        status,
        signature: row.get("signature"),
        slot: row.get("slot"),
        error: row.get("error"),
    })
}
