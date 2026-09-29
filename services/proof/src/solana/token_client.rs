//! Read-only adapter for the patched spl-token-client instruction builders.
use super::client::RpcClient;
use async_trait::async_trait;
use solana_account::Account;
use solana_address::Address;
use solana_hash::Hash;
use solana_signature::Signature;
use solana_signer::{Signer, SignerError};
use solana_transaction_legacy::Transaction;
use spl_token_client::{
    client::{
        ProgramClient, ProgramClientResult, SendTransaction, SimulateTransaction, SimulationResult,
    },
    token::Token,
};
use std::sync::Arc;

pub struct NoSubmission;

impl SendTransaction for NoSubmission {
    type Output = ();
}
impl SimulateTransaction for NoSubmission {
    type SimulationOutput = Self;
}
impl SimulationResult for NoSubmission {
    fn get_compute_units_consumed(&self) -> ProgramClientResult<u64> {
        Err("legacy simulation is disabled; compile a v1 transaction first".into())
    }
}

struct PublicKeyOnly(Address);

impl Signer for PublicKeyOnly {
    fn try_pubkey(&self) -> Result<Address, SignerError> {
        Ok(self.0)
    }
    fn try_sign_message(&self, _: &[u8]) -> Result<Signature, SignerError> {
        Err(SignerError::Custom(
            "signing belongs to the browser wallet".into(),
        ))
    }
    fn is_interactive(&self) -> bool {
        false
    }
}

/// Contains no wallet key. Only the new instruction-returning helper should
/// be used; legacy sending and simulation fail closed.
pub fn token(rpc: Arc<RpcClient>, mint: Address, payer: Address) -> Token<NoSubmission> {
    Token::new(
        rpc,
        &spl_token_2022_interface::ID,
        &mint,
        Some(6),
        Arc::new(PublicKeyOnly(payer)),
    )
}

#[async_trait]
impl ProgramClient<NoSubmission> for RpcClient {
    async fn get_minimum_balance_for_rent_exemption(
        &self,
        space: usize,
    ) -> ProgramClientResult<u64> {
        Ok(self.minimum_balance(space).await?)
    }
    async fn get_latest_blockhash(&self) -> ProgramClientResult<Hash> {
        Ok(self.latest_blockhash().await?)
    }
    async fn get_account(&self, address: Address) -> ProgramClientResult<Option<Account>> {
        Ok(self.account(&address).await?)
    }
    async fn send_transaction(&self, _: &Transaction) -> ProgramClientResult<()> {
        Err("legacy submission is disabled; return unsigned v1 bytes to the browser".into())
    }
    async fn simulate_transaction(&self, _: &Transaction) -> ProgramClientResult<NoSubmission> {
        Err("legacy simulation is disabled; compile a v1 transaction first".into())
    }
}
