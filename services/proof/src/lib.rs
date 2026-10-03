pub mod audit {
    pub mod log;
}
pub mod config;
pub mod cors;
pub mod database;
pub mod error;
pub mod wrap_store;
pub mod keys {
    pub mod elgamal;
    pub mod vault;
}
pub mod routes {
    pub mod health;
    pub mod wrap;
    mod wrap_limits;
}
pub mod solana {
    pub mod client;
    pub mod confidential;
    pub mod token_client;
    pub mod token_wrap;
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
    let wrap = routes::wrap::router(state.rpc.clone(), store);
    Router::new()
        .route("/health", get(routes::health::health))
        .with_state(state)
        .merge(wrap)
}
