pub mod audit {
    pub mod log;
    pub mod store;
}
pub mod auth;
pub mod config;
pub mod cors;
pub mod database;
pub mod error;
pub mod indexer;
pub mod run_store;
pub mod transfer_store;
pub mod unwrap_store;
pub mod wrap_store;
pub mod keys {
    pub mod elgamal;
    pub mod vault;
}
pub mod routes {
    pub mod audit;
    pub mod health;
    pub mod runs;
    mod runs_confirm;
    mod runs_prepare;
    pub mod transfer;
    pub mod unwrap;
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

/// Build health and payment routes with optional persistence services disabled.
pub fn router(state: AppState) -> Router {
    router_with_wrap(state, None)
}

/// Enable wrap persistence while leaving authenticated payment services disabled.
pub fn router_with_wrap(state: AppState, store: Option<Arc<wrap_store::WrapStore>>) -> Router {
    router_with_payments(state, store, None)
}

/// Build the payment API without enabling auditor access.
pub fn router_with_payments(
    state: AppState,
    store: Option<Arc<wrap_store::WrapStore>>,
    transfer: Option<Arc<routes::transfer::Service>>,
) -> Router {
    router_with_audit(state, store, transfer, None)
}

/// Compose health and payment routes with separately configured auditor access.
/// Passing `None` for an optional service retains its routes with unavailable errors.
pub fn router_with_audit(
    state: AppState,
    store: Option<Arc<wrap_store::WrapStore>>,
    transfer: Option<Arc<routes::transfer::Service>>,
    audit: Option<Arc<routes::audit::Service>>,
) -> Router {
    let wrap = routes::wrap::router(state.rpc.clone(), store);
    let runs = routes::runs::router(state.rpc.clone(), transfer.clone());
    let unwrap = routes::unwrap::router(state.rpc.clone(), transfer.clone());
    let transfer = routes::transfer::router(state.rpc.clone(), transfer);
    Router::new()
        .route("/health", get(routes::health::health))
        .with_state(state)
        .merge(wrap)
        .merge(transfer)
        .merge(runs)
        .merge(unwrap)
        .merge(routes::audit::router(audit))
}
