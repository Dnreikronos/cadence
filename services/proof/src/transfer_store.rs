use crate::{auth::wallet_link_message, database::Database, error::AppError};
use solana_address::Address;
use solana_signature::Signature;
use std::str::FromStr;

pub struct TransferStore {
    database: Database,
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
}
