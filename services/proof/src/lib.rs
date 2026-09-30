pub mod audit {
    pub mod log;
}
pub mod config;
pub mod error;
pub mod keys {
    pub mod elgamal;
    pub mod vault;
}
pub mod routes {
    pub mod health;
}
pub mod solana {
    pub mod client;
    pub mod token_client;
    pub mod token_wrap;
    pub mod v1;
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
    Router::new()
        .route("/health", get(routes::health::health))
        .with_state(state)
}
