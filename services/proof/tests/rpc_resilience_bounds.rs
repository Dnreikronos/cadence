#[path = "support/rpc_reads.rs"]
#[allow(dead_code)]
mod support;
use axum::http::StatusCode;
use cadence_proof::error::AppError;
use serde_json::{json, Value};
use std::time::Duration;
use support::{Reply, Rpc};
use tokio::time::{timeout, Instant};

#[tokio::test]
async fn transient_http_and_unhealthy_node_reads_recover() {
    for status in [408, 429, 500, 502, 503, 504] {
        let rpc = Rpc::start(vec![
            Reply::http(StatusCode::from_u16(status).unwrap()),
            Reply::result(json!("ok")),
        ])
        .await;
        rpc.client.health().await.unwrap();
        assert_eq!(rpc.state.calls.lock().await.len(), 2);
    }
    let rpc = Rpc::start(vec![Reply::error(-32005), Reply::result(json!("ok"))]).await;
    rpc.client.health().await.unwrap();
    assert_eq!(rpc.state.calls.lock().await.len(), 2);
}

#[tokio::test]
async fn exhaustion_leaves_original_receipt_unresolved_after_three_identical_reads() {
    let rpc = Rpc::start(vec![
        Reply::error(-32016),
        Reply::error(-32016),
        Reply::error(-32016),
        Reply::result(json!({"slot":42})),
    ])
    .await;
    assert!(matches!(
        rpc.client.finalized_transaction("original-signature").await,
        Err(AppError::RpcUnavailable)
    ));
    let calls = rpc.state.calls.lock().await;
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|call| call == &calls[0]));
}

#[tokio::test]
async fn malformed_responses_and_permanent_http_fail_without_retry() {
    for reply in [
        Reply::raw("private-provider-token; invalid JSON"),
        Reply::json(
            json!({"jsonrpc":"2.0","id":2,"error":{"code":-32016,"message":"private-provider-token"}}),
        ),
        Reply::json(
            json!({"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-32005,"message":"private-provider-token"}}),
        ),
        Reply::json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32005}})),
        Reply::json(json!({"jsonrpc":"2.0","id":1})),
        Reply::http(StatusCode::FORBIDDEN),
    ] {
        let rpc = Rpc::start(vec![reply, Reply::result(Value::Null)]).await;
        assert!(matches!(
            rpc.client.finalized_transaction("original-signature").await,
            Err(AppError::RpcUnavailable)
        ));
        assert_eq!(rpc.state.calls.lock().await.len(), 1);
    }
}

#[tokio::test]
async fn retry_after_is_honored_without_exceeding_the_call_budget() {
    let rpc = Rpc::start(vec![
        Reply::http(StatusCode::TOO_MANY_REQUESTS).retry_after("1"),
        Reply::result(json!("ok")),
    ])
    .await;
    let start = Instant::now();
    rpc.client.health().await.unwrap();
    assert!(start.elapsed() >= Duration::from_millis(950));
    assert_eq!(rpc.state.calls.lock().await.len(), 2);
    for header in [
        "60",
        "18446744073709551615",
        "tomorrow",
        "Wed, 21 Oct 2099 07:28:00 GMT",
    ] {
        let rpc = Rpc::start(vec![
            Reply::http(StatusCode::TOO_MANY_REQUESTS).retry_after(header),
            Reply::result(json!("ok")),
        ])
        .await;
        assert!(rpc.client.health().await.is_err());
        assert_eq!(rpc.state.calls.lock().await.len(), 1);
    }
}

#[tokio::test]
async fn response_and_body_delays_share_one_deadline_with_backoff() {
    for reply in [
        Reply::result(json!({"slot":42})).delay(Duration::from_millis(400)),
        Reply::result(json!({"slot":42})).body_delay(Duration::from_millis(400)),
    ] {
        let rpc = Rpc::with_timeout(
            vec![
                Reply::http(StatusCode::SERVICE_UNAVAILABLE).delay(Duration::from_millis(150)),
                reply,
            ],
            Duration::from_millis(500),
        )
        .await;
        let start = Instant::now();
        assert!(matches!(
            rpc.client.finalized_transaction("original-signature").await,
            Err(AppError::RpcUnavailable)
        ));
        assert_eq!(rpc.state.calls.lock().await.len(), 2);
        assert!(start.elapsed() < Duration::from_millis(750));
    }
}

#[tokio::test]
async fn cancelled_call_cannot_leave_background_retries() {
    let rpc = Rpc::start(vec![
        Reply::http(StatusCode::SERVICE_UNAVAILABLE),
        Reply::result(Value::Null),
    ])
    .await;
    let client = rpc.client.clone();
    let task =
        tokio::spawn(async move { client.finalized_transaction("original-signature").await });
    timeout(Duration::from_secs(1), rpc.state.arrived.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(
        timeout(Duration::from_millis(600), rpc.state.arrived.notified())
            .await
            .is_err()
    );
    assert_eq!(rpc.state.calls.lock().await.len(), 1);
}

#[tokio::test]
async fn recovered_transport_does_not_bypass_cluster_guard() {
    let rpc = Rpc::start(vec![Reply::error(-32005), Reply::result(json!("mainnet"))]).await;
    assert!(matches!(
        rpc.client.require_devnet().await,
        Err(AppError::Conflict("wrap_requires_devnet"))
    ));
    assert_eq!(rpc.state.calls.lock().await.len(), 2);
}
