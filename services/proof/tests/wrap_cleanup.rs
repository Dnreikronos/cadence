use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use cadence_proof::{solana::client::RpcClient, wrap_store::WrapStore};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Default)]
struct Backend {
    wrong_cluster: AtomicBool,
    fail_storage: AtomicBool,
    cleanups: AtomicUsize,
}
async fn rpc(State(state): State<Arc<Backend>>, Json(body): Json<Value>) -> Json<Value> {
    let result = match body["method"].as_str().unwrap() {
        "getGenesisHash" => {
            if state.wrong_cluster.load(Ordering::SeqCst) {
                json!("mainnet")
            } else {
                json!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
            }
        }
        "getBlockHeight" => {
            assert_eq!(body["params"], json!([{"commitment":"finalized"}]));
            json!(1234)
        }
        _ => panic!("unexpected method"),
    };
    Json(json!({"jsonrpc":"2.0", "id":1, "result":result}))
}
async fn cleanup(
    State(state): State<Arc<Backend>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<u64>, StatusCode> {
    assert_eq!(headers["authorization"], "Bearer test-role");
    assert_eq!(body, json!({"finalized_height":1234}));
    state.cleanups.fetch_add(1, Ordering::SeqCst);
    if state.fail_storage.load(Ordering::SeqCst) {
        Err(StatusCode::SERVICE_UNAVAILABLE)
    } else {
        Ok(Json(7))
    }
}
#[tokio::test]
async fn cleanup_uses_finalized_devnet_height_and_reports_failures() {
    let state = Arc::new(Backend::default());
    let app = Router::new()
        .route("/", post(rpc))
        .route("/rest/v1/rpc/cleanup_wrap_requests", post(cleanup))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let rpc = RpcClient::new(url.parse().unwrap(), Duration::from_secs(2)).unwrap();
    let store = WrapStore::new(url.parse().unwrap(), "test-public", "test-role").unwrap();
    assert_eq!(store.cleanup_expired(&rpc).await.unwrap(), 7);
    state.wrong_cluster.store(true, Ordering::SeqCst);
    assert!(store.cleanup_expired(&rpc).await.is_err());
    assert_eq!(state.cleanups.load(Ordering::SeqCst), 1);
    state.wrong_cluster.store(false, Ordering::SeqCst);
    state.fail_storage.store(true, Ordering::SeqCst);
    assert!(store.cleanup_expired(&rpc).await.is_err());
    task.abort();
}
