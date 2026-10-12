use crate::{
    database::{Database, Session},
    error::AppError,
};
use serde::Serialize;

pub struct AccountStore {
    database: Database,
}
#[derive(Serialize)]
pub struct Mapping {
    pub wallet: String,
    pub token_account: String,
    pub ready: bool,
}
pub struct PreparedAccount {
    pub id: String,
    pub wallet: String,
    pub token_account: String,
    pub kind: String,
    pub transaction: String,
    pub last_valid_block_height: i64,
    pub expected_counter: Option<i64>,
    pub counter_match: Option<bool>,
    pub signature: Option<String>,
    pub slot: Option<i64>,
    pub status: String,
}
pub fn unavailable() -> AppError {
    AppError::TransferUnavailable("account_storage_unavailable")
}

impl AccountStore {
    pub fn new(url: &str) -> Result<Self, AppError> {
        Ok(Self {
            database: Database::new(url, "cadence_transfer_service")?,
        })
    }
    pub async fn session(&self) -> Result<Session, AppError> {
        self.database.connect().await.map_err(|_| unavailable())
    }
    pub async fn mapping(&self, user: &str) -> Result<Option<Mapping>, AppError> {
        Ok(self.session().await?.query_opt("SELECT wallet,token_account,ready FROM public.proof_accounts WHERE user_id=$1::text::uuid", &[&user]).await.map_err(|_| unavailable())?.map(|r| Mapping { wallet:r.get(0), token_account:r.get(1), ready:r.get(2) }))
    }
    pub async fn register(&self, user: &str, wallet: &str, account: &str) -> Result<(), AppError> {
        let client = self.session().await?;
        client.execute("INSERT INTO public.proof_accounts (user_id,wallet,token_account) VALUES ($1::text::uuid,$2,$3) ON CONFLICT DO NOTHING", &[&user,&wallet,&account]).await.map_err(|_| unavailable())?;
        let stored = self.mapping(user).await?.ok_or_else(unavailable)?;
        if stored.wallet != wallet || stored.token_account != account {
            return Err(AppError::Conflict("account_mapping_conflict"));
        }
        Ok(())
    }
    pub async fn ready(&self, user: &str, account: &str) -> Result<(), AppError> {
        let client = self.session().await?;
        client
            .batch_execute("BEGIN")
            .await
            .map_err(|_| unavailable())?;
        let count=client.execute("UPDATE public.proof_accounts SET ready=true WHERE user_id=$1::text::uuid AND token_account=$2", &[&user,&account]).await.map_err(|_| unavailable())?;
        if count != 1 {
            return Err(unavailable());
        }
        client.execute("UPDATE public.people SET status='active' WHERE user_id=$1::text::uuid AND status='pending'", &[&user]).await.map_err(|_| unavailable())?;
        client
            .batch_execute("COMMIT")
            .await
            .map_err(|_| unavailable())?;
        Ok(())
    }
    pub async fn pending(
        &self,
        user: &str,
        kind: &str,
    ) -> Result<Option<PreparedAccount>, AppError> {
        let id=self.session().await?.query_opt("SELECT id FROM public.account_requests WHERE user_id=$1::text::uuid AND kind=$2 AND status='prepared'", &[&user,&kind]).await.map_err(|_|unavailable())?;
        match id {
            Some(row) => self
                .get(user, &row.get::<_, String>(0), kind)
                .await
                .map(|record| (record.status == "prepared").then_some(record)),
            None => Ok(None),
        }
    }
    pub async fn prepare(
        &self,
        user: &str,
        record: &PreparedAccount,
    ) -> Result<PreparedAccount, AppError> {
        let client = self.session().await?;
        client
            .batch_execute("BEGIN")
            .await
            .map_err(|_| unavailable())?;
        client
            .query_one(
                "SELECT pg_advisory_xact_lock(hashtextextended('account-update:' || $1::text,0))",
                &[&user],
            )
            .await
            .map_err(|_| unavailable())?;
        let pending=client.query_opt("SELECT id FROM public.account_requests WHERE user_id=$1::text::uuid AND kind=$2 AND status='prepared'", &[&user,&record.kind]).await.map_err(|_|unavailable())?;
        if let Some(row) = pending {
            return self.get(user, &row.get::<_, String>(0), &record.kind).await;
        }
        client.execute("INSERT INTO public.account_requests (id,user_id,wallet,token_account,kind,transaction,last_valid_block_height,expected_counter) VALUES ($1,$2::text::uuid,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", &[&record.id,&user,&record.wallet,&record.token_account,&record.kind,&record.transaction,&record.last_valid_block_height,&record.expected_counter]).await.map_err(|_| unavailable())?;
        client
            .batch_execute("COMMIT")
            .await
            .map_err(|_| unavailable())?;
        let existing = self.get(user, &record.id, &record.kind).await?;
        if existing.wallet != record.wallet
            || existing.transaction != record.transaction
            || existing.token_account != record.token_account
            || existing.expected_counter != record.expected_counter
        {
            return Err(unavailable());
        }
        Ok(existing)
    }
    pub async fn get(&self, user: &str, id: &str, kind: &str) -> Result<PreparedAccount, AppError> {
        let r=self.session().await?.query_opt("SELECT * FROM public.account_requests WHERE user_id=$1::text::uuid AND id=$2 AND kind=$3", &[&user,&id,&kind]).await.map_err(|_| unavailable())?.ok_or(AppError::AccountNotFound)?;
        Ok(PreparedAccount {
            id: r.get("id"),
            wallet: r.get("wallet"),
            token_account: r.get("token_account"),
            kind: r.get("kind"),
            transaction: r.get("transaction"),
            last_valid_block_height: r.get("last_valid_block_height"),
            expected_counter: r.get("expected_counter"),
            counter_match: r.get("counter_match"),
            signature: r.get("signature"),
            slot: r.get("slot"),
            status: r.get("status"),
        })
    }
    pub async fn submitted(
        &self,
        user: &str,
        r: &PreparedAccount,
        signature: &str,
    ) -> Result<(), AppError> {
        crate::indexer::verify::submission(&r.id, &r.wallet, &r.transaction, signature)?;
        let client = self.session().await?;
        let count=client.execute("UPDATE public.account_requests SET submitted_signature=$3 WHERE user_id=$1::text::uuid AND id=$2 AND status='prepared' AND submitted_signature IS NULL", &[&user,&r.id,&signature]).await.map_err(|_| unavailable())?;
        if count == 1 {
            return Ok(());
        }
        let existing: Option<String>=client.query_one("SELECT coalesce(submitted_signature,signature) FROM public.account_requests WHERE user_id=$1::text::uuid AND id=$2", &[&user,&r.id]).await.map_err(|_| unavailable())?.get(0);
        if existing.as_deref() == Some(signature) {
            Ok(())
        } else {
            Err(AppError::Conflict("account_already_confirmed"))
        }
    }
    /// Keep the first finalized apply check, including when confirmations race.
    pub async fn counter_match(
        &self,
        user: &str,
        r: &PreparedAccount,
        signature: &str,
        matches: bool,
    ) -> Result<bool, AppError> {
        let client = self.session().await?;
        client.execute("UPDATE public.account_requests SET counter_match=$4 WHERE user_id=$1::text::uuid AND id=$2 AND signature=$3 AND status='finalized' AND kind='apply_pending' AND counter_match IS NULL", &[&user,&r.id,&signature,&matches]).await.map_err(|_|unavailable())?;
        client.query_opt("SELECT counter_match FROM public.account_requests WHERE user_id=$1::text::uuid AND id=$2 AND signature=$3 AND status='finalized' AND kind='apply_pending'", &[&user,&r.id,&signature]).await.map_err(|_|unavailable())?.and_then(|row|row.get::<_,Option<bool>>(0)).ok_or_else(unavailable)
    }
    pub async fn finish(
        &self,
        user: &str,
        r: &PreparedAccount,
        signature: &str,
        slot: i64,
        failed: bool,
    ) -> Result<(), AppError> {
        let status = if failed { "failed" } else { "finalized" };
        let count=self.session().await?.execute("UPDATE public.account_requests SET signature=$3,slot=$4,status=$5 WHERE user_id=$1::text::uuid AND id=$2 AND status='prepared' AND submitted_signature=$3", &[&user,&r.id,&signature,&slot,&status]).await.map_err(|_|unavailable())?;
        if count == 1 {
            return Ok(());
        }
        let stored = self.get(user, &r.id, &r.kind).await?;
        if stored.signature.as_deref() == Some(signature)
            && stored.slot == Some(slot)
            && stored.status == status
        {
            Ok(())
        } else {
            Err(AppError::Conflict("account_already_confirmed"))
        }
    }
}
