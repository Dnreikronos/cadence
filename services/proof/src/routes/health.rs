use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    build_sha: String,
    rpc_reachable: bool,
}

pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    let (code, status, rpc_reachable) = match state.rpc.health().await {
        Ok(()) => (StatusCode::OK, "ok", true),
        Err(error) => (error.status(), "unavailable", false),
    };
    (
        code,
        Json(Health {
            status,
            build_sha: state.build_sha,
            rpc_reachable,
        }),
    )
}
