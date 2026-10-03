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
