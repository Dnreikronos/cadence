#[path = "support/rpc_reads.rs"]
#[allow(dead_code)]
mod support;
use axum::http::StatusCode;
use cadence_proof::error::AppError;
use serde_json::{json, Value};
use solana_address::Address;
use support::{Reply, Rpc};

#[tokio::test]
async fn finalized_receipt_read_recovers_throttling_with_identical_parameters() {
    let receipt = json!({"slot":42,"meta":{"err":null}});
    let rpc = Rpc::start(vec![
        Reply::http(StatusCode::TOO_MANY_REQUESTS),
        Reply::result(receipt.clone()),
    ])
    .await;
    assert_eq!(
        rpc.client
            .finalized_transaction("original-signature")
            .await
            .unwrap(),
        receipt
    );
    let calls = rpc.state.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0], calls[1]);
    assert_eq!(calls[0]["params"][0], "original-signature");
    assert_eq!(calls[0]["params"][1]["commitment"], "finalized");
    assert_eq!(calls[0]["params"][1]["maxSupportedTransactionVersion"], 1);
}

#[tokio::test]
async fn finalized_snapshot_recovers_node_lag_without_lowering_minimum_slot() {
    let rpc = Rpc::start(vec![
        Reply::error(-32016),
        Reply::result(json!({"context":{"slot":42},"value":null})),
    ])
    .await;
    let account = Address::new_from_array([7; 32]);
    let (slot, result) = rpc
        .client
        .finalized_account(&account, Some(42))
        .await
        .unwrap();
    assert_eq!(slot, 42);
    assert!(result.is_none());
    let calls = rpc.state.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0], calls[1]);
    assert_eq!(calls[0]["params"][1]["minContextSlot"], 42);
    assert_eq!(calls[0]["params"][1]["commitment"], "finalized");
}

#[tokio::test]
async fn null_finalized_history_is_not_polled_or_reclassified() {
    let rpc = Rpc::start(vec![Reply::result(Value::Null)]).await;
    assert!(rpc
        .client
        .finalized_transaction("original-signature")
        .await
        .unwrap()
        .is_null());
    assert_eq!(rpc.state.calls.lock().await.len(), 1);
}

#[tokio::test]
async fn invalid_requests_and_pruned_history_are_not_retried() {
    for code in [-32602, -32011, -32015] {
        let rpc = Rpc::start(vec![Reply::error(code)]).await;
        assert!(matches!(
            rpc.client.finalized_transaction("original-signature").await,
            Err(AppError::RpcUnavailable)
        ));
        assert_eq!(rpc.state.calls.lock().await.len(), 1);
    }
}
