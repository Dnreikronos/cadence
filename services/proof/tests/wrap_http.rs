#[path = "support/wrap.rs"]
mod support;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::v1;
use serde_json::{json, Value};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::sync::atomic::Ordering;
use support::Harness;
use tower::ServiceExt;

async fn post(app: &Router, path: &str, value: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 16384).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn signed(h: &Harness, prepared: &Value) -> (VersionedTransaction, Value) {
    let bytes = STANDARD
        .decode(prepared["transaction"].as_str().unwrap())
        .unwrap();
    let mut tx: VersionedTransaction = wincode::deserialize(&bytes).unwrap();
    assert_eq!(tx.signatures, vec![solana_signature::Signature::default()]);
    assert!(matches!(
        tx.message,
        solana_message::VersionedMessage::V0(_)
    ));
    assert!(bytes.len() <= 1232);
    tx.signatures[0] = h.wallet.sign_message(&tx.message.serialize());
    let request =
        json!({"request_id": prepared["request_id"], "signature": tx.signatures[0].to_string()});
    (tx, request)
}

fn chain(tx: &VersionedTransaction) -> Value {
    json!({"slot": 42, "meta": {"err": null}, "transaction": [STANDARD.encode(v1::serialize(tx).unwrap()), "base64"]})
}

#[tokio::test]
async fn fresh_wrap_roundtrip_and_idempotent_confirmation() {
    let h = Harness::new(false).await;
    let (status, prepared) = post(&h.app, "/wrap", h.request(true)).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["last_valid_block_height"], 500);
    assert_eq!(prepared["transaction_version"], 0);
    assert_eq!(
        prepared["required_signers"],
        json!([h.wallet.pubkey().to_string()])
    );
    let (tx, request) = signed(&h, &prepared);
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    for _ in 0..2 {
        let (status, body) = post(&h.app, "/wrap/confirm", request.clone()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "finalized");
    }
    let records = h.backend.records.lock().unwrap();
    let record = records.values().next().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(record.signature.as_deref(), request["signature"].as_str());
    assert_eq!(record.slot, Some(42));
    let calls = h.backend.calls.lock().unwrap();
    let reads: Vec<_> = calls
        .iter()
        .filter(|call| call["method"] == "getTransaction")
        .collect();
    assert_eq!(reads.len(), 1);
    assert_eq!(
        reads[0]["params"][1],
        json!({"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1})
    );
    assert!(!calls.iter().any(|call| call["method"] == "sendTransaction"));
}

#[tokio::test]
async fn existing_account_needs_no_setup_and_prepare_retry_preserves_confirmation() {
    let h = Harness::new(true).await;
    let (status, prepared) = post(&h.app, "/wrap", h.request(false)).await;
    assert_eq!(status, StatusCode::OK);
    let (tx, confirmation) = signed(&h, &prepared);
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    assert_eq!(
        post(&h.app, "/wrap/confirm", confirmation).await.0,
        StatusCode::OK
    );
    assert_eq!(
        post(&h.app, "/wrap", h.request(false)).await.0,
        StatusCode::OK
    );
    assert!(h
        .backend
        .records
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .signature
        .is_some());
}

#[tokio::test]
async fn failed_missing_malformed_and_unrelated_transactions_never_confirm() {
    let h = Harness::new(true).await;
    let (_, prepared) = post(&h.app, "/wrap", h.request(false)).await;
    let (tx, request) = signed(&h, &prepared);
    let mut failed = chain(&tx);
    failed["meta"]["err"] = json!({"InstructionError": [0, "InvalidArgument"]});
    let mut malformed = chain(&tx);
    malformed["meta"] = Value::Null;
    let mut unrelated = tx.clone();
    unrelated
        .message
        .set_recent_blockhash(solana_hash::Hash::new_from_array([7; 32]));
    unrelated.signatures[0] = h.wallet.sign_message(&unrelated.message.serialize());
    let mut invalid_signature = tx.clone();
    invalid_signature.signatures[0] =
        solana_keypair::Keypair::new().sign_message(&tx.message.serialize());
    for value in [
        Value::Null,
        failed,
        malformed,
        chain(&unrelated),
        chain(&invalid_signature),
    ] {
        *h.backend.transaction.lock().unwrap() = value;
        assert_ne!(
            post(&h.app, "/wrap/confirm", request.clone()).await.0,
            StatusCode::OK
        );
        assert!(h
            .backend
            .records
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .signature
            .is_none());
    }
    // Matching the supplied signature still cannot bypass wallet verification.
    *h.backend.transaction.lock().unwrap() = chain(&unrelated);
    let different_message = json!({"request_id": prepared["request_id"], "signature": unrelated.signatures[0].to_string()});
    assert_eq!(
        post(&h.app, "/wrap/confirm", different_message).await.1["error"],
        "transaction_mismatch"
    );
    *h.backend.transaction.lock().unwrap() = chain(&invalid_signature);
    let forged = json!({"request_id": prepared["request_id"], "signature": invalid_signature.signatures[0].to_string()});
    assert_eq!(
        post(&h.app, "/wrap/confirm", forged).await.1["error"],
        "transaction_mismatch"
    );
}

#[tokio::test]
async fn invalid_requests_wrong_cluster_and_storage_failure_fail_closed() {
    let h = Harness::new(false).await;
    let (_, body) = post(&h.app, "/wrap", h.request(false)).await;
    assert_eq!(body["error"], "confidential_setup_required");
    for request in [
        json!({"company_wallet": "bad", "amount": "sensitive-value"}),
        json!({"company_wallet": h.wallet.pubkey().to_string(), "amount": 10}),
        json!({"company_wallet": h.wallet.pubkey().to_string(), "amount": "0"}),
    ] {
        let (status, body) = post(&h.app, "/wrap", request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body.to_string().contains("sensitive-value"));
    }
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    assert_eq!(
        post(&h.app, "/wrap", h.request(true)).await.1["error"],
        "wrap_requires_devnet"
    );
    h.backend.wrong_cluster.store(false, Ordering::SeqCst);
    h.backend.fail_storage.store(true, Ordering::SeqCst);
    assert_eq!(
        post(&h.app, "/wrap", h.request(true)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(h.backend.records.lock().unwrap().is_empty());
}

#[tokio::test]
async fn missing_requests_insufficient_funds_and_confirmation_storage_failure() {
    let h = Harness::new(true).await;
    let missing = json!({"request_id": "b".repeat(64), "signature": h.wallet.sign_message(b"missing").to_string()});
    assert_eq!(
        post(&h.app, "/wrap/confirm", missing).await.0,
        StatusCode::NOT_FOUND
    );
    let mut too_much = h.request(false);
    too_much["amount"] = json!("20000001");
    assert_eq!(
        post(&h.app, "/wrap", too_much).await.1["error"],
        "insufficient_usdc"
    );
    let (_, prepared) = post(&h.app, "/wrap", h.request(false)).await;
    let (tx, request) = signed(&h, &prepared);
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    h.backend.fail_storage.store(true, Ordering::SeqCst);
    assert_eq!(
        post(&h.app, "/wrap/confirm", request.clone()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(h
        .backend
        .records
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .signature
        .is_none());
    h.backend.fail_storage.store(false, Ordering::SeqCst);
    assert_eq!(
        post(&h.app, "/wrap/confirm", request.clone()).await.0,
        StatusCode::OK
    );
    // Finalized receipts survive RPC pruning and outages.
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    *h.backend.transaction.lock().unwrap() = Value::Null;
    assert_eq!(
        post(&h.app, "/wrap/confirm", request).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn previously_prepared_v1_requests_remain_confirmable() {
    use cadence_proof::{
        solana::wrap,
        wrap_store::{request_id, PreparedWrap},
    };
    let h = Harness::new(false).await;
    let setup: wrap::Setup = serde_json::from_value(h.request(true)["setup"].clone()).unwrap();
    let instructions =
        wrap::instructions(&h.wallet.pubkey(), 1_000_000, None, Some(&setup)).unwrap();
    let mut tx = v1::compile_unsigned(
        &instructions,
        &h.wallet.pubkey(),
        solana_hash::Hash::new_from_array([8; 32]),
    )
    .unwrap();
    let bytes = v1::serialize(&tx).unwrap();
    let id = request_id(&bytes);
    let record = PreparedWrap {
        id: id.clone(),
        company_wallet: h.wallet.pubkey().to_string(),
        destination: wrap::destination(&h.wallet.pubkey()).to_string(),
        transaction: STANDARD.encode(bytes),
        last_valid_block_height: 500,
        signature: None,
        slot: None,
    };
    h.backend.records.lock().unwrap().insert(id.clone(), record);
    tx.signatures[0] = h.wallet.sign_message(&tx.message.serialize());
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    let request = json!({"request_id": id, "signature": tx.signatures[0].to_string()});
    assert_eq!(
        post(&h.app, "/wrap/confirm", request).await.0,
        StatusCode::OK
    );
}
