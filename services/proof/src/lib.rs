pub mod audit {
    pub mod log;
}
pub mod auth;
pub mod config;
pub mod cors;
pub mod database;
pub mod error;
pub mod run_store;
pub mod transfer_store;
pub mod unwrap_store;
pub mod wrap_store;
pub mod keys {
    pub mod elgamal;
    pub mod vault;
}
pub mod routes {
    pub mod health;
    pub mod runs;
    mod runs_confirm;
    mod runs_prepare;
    pub mod transfer;
    pub mod wrap;
    mod wrap_limits;
}
pub mod solana {
    pub mod batch;
    pub mod client;
    pub mod confidential;
    pub mod reveal_risk;
    pub mod token_client;
    pub mod token_wrap;
    pub mod unwrap;
    pub mod v0;
    pub mod v1;
    pub mod wrap;
}

use axum::{routing::get, Router};
use solana::client::RpcClient;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub rpc: Arc<RpcClient>,
    pub build_sha: String,
}

pub fn router(state: AppState) -> Router {
    router_with_wrap(state, None)
}

pub fn router_with_wrap(state: AppState, store: Option<Arc<wrap_store::WrapStore>>) -> Router {
    router_with_payments(state, store, None)
}

pub fn router_with_payments(
    state: AppState,
    store: Option<Arc<wrap_store::WrapStore>>,
    transfer: Option<Arc<routes::transfer::Service>>,
) -> Router {
    let wrap = routes::wrap::router(state.rpc.clone(), store);
    let runs = routes::runs::router(state.rpc.clone(), transfer.clone());
    let transfer = routes::transfer::router(state.rpc.clone(), transfer);
    Router::new()
        .route("/health", get(routes::health::health))
        .with_state(state)
        .merge(wrap)
        .merge(transfer)
        .merge(runs)
}
