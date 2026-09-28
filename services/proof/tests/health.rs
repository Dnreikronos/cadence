mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    response::IntoResponse,
};
use cadence_proof::{error::AppError, router, solana::client::RpcClient, AppState};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use support::MockRpc;
use tower::ServiceExt;

async fn health(client: Arc<RpcClient>) -> (StatusCode, Value) {
    let app = router(AppState {
        rpc: client,
        build_sha: "a".repeat(40),
    });
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn healthy_rpc_reports_build_and_reachability() {
    let rpc = MockRpc::start(json!({"jsonrpc":"2.0","id":1,"result":"ok"})).await;
    let (status, body) = health(rpc.client.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"status":"ok","build_sha":"a".repeat(40),"rpc_reachable":true})
    );
    assert_eq!(
        rpc.calls.lock().unwrap()[0],
        json!({"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]})
    );
}

#[tokio::test]
async fn unhealthy_and_malformed_rpc_responses_are_unavailable() {
    for response in [
        json!({"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"secret-provider-token"}}),
        json!({"jsonrpc":"2.0","id":1,"result":"behind"}),
        json!({"jsonrpc":"2.0","id":1,"result":null}),
        json!({"jsonrpc":"2.0","id":2,"result":"ok"}),
        json!({"result":"ok"}),
        json!({"jsonrpc":"2.0","id":1}),
    ] {
        let rpc = MockRpc::start(response).await;
        let (status, body) = health(rpc.client.clone()).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            json!({"status":"unavailable","build_sha":"a".repeat(40),"rpc_reachable":false})
        );
    }
}

#[tokio::test]
async fn timeout_http_failure_and_invalid_json_do_not_leak_provider_details() {
    for mode in ["timeout", "http", "json"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/?api-key=secret-provider-token",
            listener.local_addr().unwrap()
        )
        .parse()
        .unwrap();
        let app = axum::Router::new().route(
            "/",
            axum::routing::post(move || async move {
                if mode == "timeout" {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                let status = if mode == "http" {
                    StatusCode::TOO_MANY_REQUESTS
                } else {
                    StatusCode::OK
                };
                (status, "secret-provider-token")
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Arc::new(RpcClient::new(url, Duration::from_millis(50)).unwrap());
        let (status, body) = health(client).await;
        task.abort();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!body.to_string().contains("secret-provider-token"));
    }
}

#[tokio::test]
async fn transaction_and_block_reads_always_allow_v1() {
    let rpc = MockRpc::start(json!({"jsonrpc":"2.0","id":1,"result":null})).await;
    assert!(rpc.client.transaction("signature").await.unwrap().is_null());
    assert!(rpc.client.block(123).await.unwrap().is_null());
    let calls = rpc.calls.lock().unwrap();
    assert_eq!(calls[0]["method"], "getTransaction");
    assert_eq!(calls[1]["method"], "getBlock");
    for call in calls.iter() {
        assert_eq!(call["params"][1]["maxSupportedTransactionVersion"], 1);
        assert_eq!(call["params"][1]["commitment"], "confirmed");
    }
}

#[tokio::test]
async fn shared_error_mapping_hides_internal_details() {
    for (error, expected) in [
        (AppError::RpcUnavailable, StatusCode::SERVICE_UNAVAILABLE),
        (
            AppError::Config("secret-provider-token"),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    ] {
        let response = error.into_response();
        assert_eq!(response.status(), expected);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("secret-provider-token"));
    }
}
