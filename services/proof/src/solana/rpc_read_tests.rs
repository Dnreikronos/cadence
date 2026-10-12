use super::{rpc_read, RpcClient};
use axum::{http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[tokio::test]
async fn write_and_unknown_methods_make_one_wire_attempt() {
    for method in ["sendTransaction", "requestAirdrop", "futureRpcMethod"] {
        let calls = Arc::new(AtomicUsize::new(0));
        let received = calls.clone();
        let app = Router::new().route(
            "/",
            post(move || {
                received.fetch_add(1, Ordering::SeqCst);
                async { (StatusCode::SERVICE_UNAVAILABLE, "private-provider-token") }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let rpc = RpcClient::new(url.parse().unwrap(), Duration::from_secs(2)).unwrap();
        assert!(rpc.call(method, json!(["private-payload"])).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}

#[tokio::test]
async fn malformed_provider_details_are_absent_from_diagnostics() {
    let app = Router::new().route("/", post(|| async {
        (StatusCode::CREATED, Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":42_000_000,"message":"private-provider-token","data":{"amount":"private-amount","key":"private-key"}}})))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}?api-key=private-provider-token",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let failure =
        match rpc_read::request(&reqwest::Client::new(), &url.parse().unwrap(), &Value::Null).await
        {
            Ok(_) => panic!("provider error must be rejected"),
            Err(failure) => failure,
        };
    let diagnostic = failure.diagnostic("getTransaction", 1, false);
    for secret in [
        "private-provider-token",
        "private-amount",
        "private-key",
        "42000000",
        "api-key",
        "http://",
    ] {
        assert!(!diagnostic.contains(secret));
    }
    assert!(diagnostic.contains("http_status=201"));
    assert!(diagnostic.contains("rpc_code=none"));
    server.abort();
}
