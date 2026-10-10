pub mod store;
mod subscription;
pub mod verify;

use crate::{error::AppError, solana::client::RpcClient};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};
use store::{Pending, Store};

pub struct Indexer {
    pub(super) rpc: Arc<RpcClient>,
    pub(super) store: Store,
    pub(super) websocket: reqwest::Url,
}
impl Indexer {
    pub fn new(
        rpc: Arc<RpcClient>,
        database: &str,
        websocket: reqwest::Url,
    ) -> Result<Self, AppError> {
        if !matches!(websocket.scheme(), "ws" | "wss") || websocket.host_str().is_none() {
            return Err(AppError::Config("PROOF_RPC_WS_URL must be a WS(S) URL"));
        }
        Ok(Self {
            rpc,
            store: Store::new(database)?,
            websocket,
        })
    }
    pub fn from_env(
        rpc: Arc<RpcClient>,
        rpc_url: &reqwest::Url,
        enabled: bool,
    ) -> Result<Option<Self>, AppError> {
        let database = std::env::var("PROOF_INDEXER_DATABASE_URL").ok();
        if !enabled && database.is_none() {
            return Ok(None);
        }
        let database = database.ok_or(AppError::Config(
            "payment storage requires PROOF_INDEXER_DATABASE_URL",
        ))?;
        let websocket = match std::env::var("PROOF_RPC_WS_URL").ok() {
            Some(url) => url
                .parse()
                .map_err(|_| AppError::Config("PROOF_RPC_WS_URL must be a WS(S) URL"))?,
            None => {
                let mut url = rpc_url.clone();
                url.set_scheme(if rpc_url.scheme() == "https" {
                    "wss"
                } else {
                    "ws"
                })
                .map_err(|_| AppError::Config("invalid indexer WebSocket URL"))?;
                url
            }
        };
        Self::new(rpc, &database, websocket).map(Some)
    }
    pub async fn backfill(&self) -> Result<(), AppError> {
        self.rpc.require_devnet().await?;
        let pending = self.store.pending().await?;
        let mut error = None;
        for p in pending.iter().filter(|p| p.signature.is_some()) {
            if let Err(e) = self.reconcile(p).await {
                error = Some(e);
            }
        }
        let cursors = self.store.cursors().await?;
        let wallets: HashSet<_> = pending
            .iter()
            .filter(|p| p.signature.is_none())
            .map(|p| p.wallet.as_str())
            .collect();
        for wallet in wallets {
            if let Err(e) = self
                .discover(wallet, cursors.get(wallet).map(String::as_str))
                .await
            {
                error = Some(e);
            }
        }
        error.map_or(Ok(()), Err)
    }
    async fn discover(&self, wallet: &str, until: Option<&str>) -> Result<(), AppError> {
        let mut before: Option<String> = None;
        let mut head = None;
        let mut seen = HashSet::new();
        loop {
            let mut config = json!({"commitment":"finalized","limit":1000});
            if let Some(before) = &before {
                config["before"] = json!(before);
            }
            if let Some(until) = until {
                config["until"] = json!(until);
            }
            let result = self
                .rpc
                .call("getSignaturesForAddress", json!([wallet, config]))
                .await?;
            let entries = result.as_array().ok_or(AppError::RpcUnavailable)?;
            if entries.is_empty() {
                break;
            }
            for entry in entries {
                let signature = entry["signature"]
                    .as_str()
                    .ok_or(AppError::RpcUnavailable)?;
                if !seen.insert(signature.to_owned()) {
                    return Err(AppError::RpcUnavailable);
                }
                if head.is_none() {
                    head = Some(signature.to_owned());
                }
                let result = self.rpc.finalized_transaction(signature).await?;
                // An unavailable history entry must not advance the cursor past a payment.
                if result.is_null() {
                    return Err(AppError::Conflict("transaction_history_unavailable"));
                }
                match verify::discovered(&result) {
                    Ok((id, actual)) => {
                        if actual != signature {
                            return Err(AppError::RpcUnavailable);
                        }
                        for p in self.store.find(&id, wallet).await? {
                            self.record(&p, signature, &result).await?;
                        }
                    }
                    Err(AppError::Conflict("transaction_mismatch")) => {}
                    Err(error) => return Err(error),
                }
            }
            before = Some(
                entries.last().unwrap()["signature"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
            // Always request the next page; providers can return a short page.
        }
        if let Some(head) = head {
            self.store.cursor(wallet, &head).await?;
        }
        Ok(())
    }
    pub(super) async fn reconcile(&self, p: &Pending) -> Result<(), AppError> {
        let signature = p.signature.as_deref().ok_or(AppError::StorageUnavailable)?;
        let result = self.rpc.finalized_transaction(signature).await?;
        if result.is_null() {
            return Ok(());
        }
        self.record(p, signature, &result).await
    }
    async fn record(&self, p: &Pending, signature: &str, result: &Value) -> Result<(), AppError> {
        let (slot, failed) = verify::outcome(&p.id, &p.wallet, &p.transaction, signature, result)?;
        self.store.finish(p, signature, slot, failed).await
    }
    pub fn spawn(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                if self.backfill().await.is_ok() {
                    let _ = self.watch().await;
                }
                eprintln!("chain indexer disconnected or reconciliation failed; retrying");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        })
    }
}
