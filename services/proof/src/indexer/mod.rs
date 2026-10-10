mod history;
pub mod store;
mod subscription;
pub mod verify;

use crate::{error::AppError, solana::client::RpcClient};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
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
        self.recover(true).await
    }
    pub(super) async fn active_pending(&self) -> Result<Vec<Pending>, AppError> {
        let height = self.rpc.finalized_block_height().await?;
        self.store
            .pending_from(height.saturating_sub(history::FINALITY_GRACE))
            .await
    }
    async fn recover(&self, full: bool) -> Result<(), AppError> {
        self.rpc.require_devnet().await?;
        let pending = if full {
            self.store.pending().await?
        } else {
            self.active_pending().await?
        };
        let mut error = None;
        for p in pending.iter().filter(|p| p.signature.is_some()) {
            if let Err(e) = self.reconcile(p).await {
                error = Some(e);
            }
        }
        let mut wallets: HashMap<&str, Vec<&Pending>> = HashMap::new();
        for p in pending.iter().filter(|p| p.signature.is_none()) {
            wallets.entry(&p.wallet).or_default().push(p);
        }
        for (wallet, requests) in wallets {
            if let Err(e) = self.discover(wallet, &requests, full).await {
                error = Some(e);
            }
        }
        error.map_or(Ok(()), Err)
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
            let (hints, mut notifications) = tokio::sync::mpsc::channel(64);
            let recovery = async {
                let mut active = tokio::time::interval(Duration::from_secs(30));
                let mut full = tokio::time::interval_at(
                    tokio::time::Instant::now() + Duration::from_secs(300),
                    Duration::from_secs(300),
                );
                active.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                full.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    let result = tokio::select! {
                        _ = full.tick() => self.backfill().await,
                        _ = active.tick() => self.recover(false).await,
                    };
                    if result.is_err() {
                        eprintln!(
                            "chain indexer reconciliation failed; retaining unresolved requests"
                        );
                    }
                }
            };
            let subscriptions = async {
                loop {
                    let _ = self.watch(&hints).await;
                    eprintln!("chain indexer disconnected; retrying subscriptions");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            };
            let receipts = async {
                while let Some(p) = notifications.recv().await {
                    if self.reconcile(&p).await.is_err() {
                        eprintln!(
                            "chain indexer notification reconciliation failed; retaining request"
                        );
                    }
                }
            };
            tokio::join!(recovery, subscriptions, receipts);
        })
    }
}
