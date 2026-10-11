#[path = "support/transfer.rs"]
#[allow(dead_code)]
mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::{fallback, v1};
use serde_json::{json, Value};
use solana_address::Address;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::Account,
};
use support::Harness;
use tower::ServiceExt;

async fn request(app: &Router, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let builder = if body.is_some() {
        Request::post(path)
    } else {
        Request::get(path)
    };
    let response = app
        .clone()
        .oneshot(
            builder
                .header("authorization", "Bearer test-user")
                .header("content-type", "application/json")
                .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    (status, value)
}
fn public_funding(h: &Harness, balance: u64) {
    let mut accounts = h.backend.accounts.lock().unwrap();
    let source = accounts
        .get_mut(&h.fixture.transfer().sender.to_string())
        .unwrap();
    let mut bytes = STANDARD
        .decode(source["data"][0].as_str().unwrap())
        .unwrap();
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut bytes).unwrap();
    state.base.amount = balance;
    state.pack_base();
    source["data"][0] = json!(STANDARD.encode(bytes));
    let destination = accounts
        .get_mut(&h.fixture.transfer().recipient.to_string())
        .unwrap();
    let mut bytes = STANDARD
        .decode(destination["data"][0].as_str().unwrap())
        .unwrap();
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut bytes).unwrap();
    state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .allow_non_confidential_credits = true.into();
    destination["data"][0] = json!(STANDARD.encode(bytes));
}
fn sign_and_record(h: &Harness, payment: &Value, failed: bool) -> Value {
    let mut tx: VersionedTransaction = wincode::deserialize(
        &STANDARD
            .decode(payment["transaction"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert!(tx
        .signatures
        .iter()
        .all(|s| *s == solana_signature::Signature::default()));
    tx.signatures[0] = h.fixture.wallet.sign_message(&tx.message.serialize());
    let signature = tx.signatures[0].to_string();
    h.backend.transactions.lock().unwrap().insert(signature.clone(),json!({"slot":42,"meta":{"err":if failed{json!({"InstructionError":[0,"InvalidInstructionData"]})}else{Value::Null}},"transaction":[STANDARD.encode(v1::serialize(&tx).unwrap()),"base64"]}));
    json!({"position":payment["position"],"request_id":payment["request_id"],"signature":signature})
}
fn run_body(h: &Harness, recipients: &[String], amount: &str) -> Value {
    let mut body = h.request();
    body.as_object_mut().unwrap().remove("recipient");
    body.as_object_mut().unwrap().remove("amount");
    body["payments"] = json!(recipients
        .iter()
        .map(|r| json!({"recipient":r,"amount":amount}))
        .collect::<Vec<_>>());
    body
}

#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for an empty disposable Supabase instance with vault.sql applied"]
async fn proof_outage_completes_public_payroll_and_preserves_retry_privacy() {
    let h = Harness::new().await;
    let app = h.app();
    let original = h.fixture.transfer().recipient.to_string();
    let (status, initial) = request(
        &app,
        "/runs",
        Some(run_body(&h, std::slice::from_ref(&original), "1000000")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{initial}");
    assert_eq!(initial["payments"][0]["transparent"], false);
    let confirm = format!("/runs/{}/confirm", initial["run_id"].as_str().unwrap());
    let failed = sign_and_record(&h, &initial["payments"][0], true);
    let (_, failed) = request(&app, &confirm, Some(json!({"payments":[failed]}))).await;
    assert_eq!(failed["payments"][0]["status"], "failed");
    assert_eq!(h.audit_count().await, 1);

    public_funding(&h, 10_000_000);
    let mut feature = vec![1];
    feature.extend_from_slice(&10_u64.to_le_bytes());
    h.backend.accounts.lock().unwrap().insert(fallback::DISABLE.to_string(),json!({"owner":"Feature111111111111111111111111111111111111","executable":false,"data":[STANDARD.encode(feature),"base64"]}));
    h.backend.calls.lock().unwrap().clear();
    let retry = format!("/runs/{}/retry", initial["run_id"].as_str().unwrap());
    let (status, rebuilt) = request(&app,&retry,Some(json!({"aes_key":h.request()["aes_key"],"payments":[{"position":0,"amount":"1000000"}]}))).await;
    assert_eq!(status, StatusCode::OK, "{rebuilt}");
    assert_eq!(rebuilt["payments"][0]["transparent"], true);
    assert_eq!(rebuilt["payments"][0]["attempt"], 1);
    assert_eq!(
        fallback::transfer(rebuilt["payments"][0]["transaction"].as_str().unwrap())
            .unwrap()
            .amount,
        1_000_000
    );
    assert_eq!(h.audit_count().await, 1);
    assert!(!h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "getMinimumBalanceForRentExemption"));
    let public = sign_and_record(&h, &rebuilt["payments"][0], false);
    let (status, completed) = request(&app, &confirm, Some(json!({"payments":[public]}))).await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["payments"][0]["transparent"], true);
    let history = h
        .admin
        .query_one("SELECT transparent FROM public.payment_attempts", &[])
        .await
        .unwrap();
    assert!(!history.get::<_, bool>(0));
    assert!(h
        .admin
        .batch_execute("UPDATE public.payments SET transparent=false")
        .await
        .is_err());

    // A fresh three-recipient payroll also survives a missing executable program.
    let recipients: Vec<_> = (20..23)
        .map(|i| Address::new_from_array([i; 32]).to_string())
        .collect();
    {
        let mut accounts = h.backend.accounts.lock().unwrap();
        accounts.remove(&solana_zk_elgamal_proof_interface::ID.to_string());
        let destination = accounts[&original].clone();
        for recipient in &recipients {
            accounts.insert(recipient.clone(), destination.clone());
        }
    }
    let (status, run) = request(&app, "/runs", Some(run_body(&h, &recipients, "2000000"))).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let payments = run["payments"].as_array().unwrap();
    assert_eq!(payments.len(), 3);
    for p in payments {
        assert_eq!(p["transparent"], true);
        assert_eq!(
            fallback::transfer(p["transaction"].as_str().unwrap())
                .unwrap()
                .amount,
            2_000_000
        );
    }
    let confirmations: Vec<_> = payments
        .iter()
        .map(|p| sign_and_record(&h, p, false))
        .collect();
    let path = format!("/runs/{}", run["run_id"].as_str().unwrap());
    let (status, complete) = request(
        &app,
        &format!("{path}/confirm"),
        Some(json!({"payments":confirmations})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{complete}");
    assert_eq!(complete["status"], "completed");
    let (_, read) = request(&app, &path, None).await;
    assert!(read["payments"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["status"] == "finalized"
            && p["transparent"] == true
            && p.get("transaction").is_none()));
    assert_eq!(h.audit_count().await, 1);

    let (status, standalone) = request(&app, "/transfer", Some(h.request())).await;
    assert_eq!(status, StatusCode::OK, "{standalone}");
    assert_eq!(standalone["transparent"], true);
    let mut signed = sign_and_record(&h, &standalone, false);
    signed.as_object_mut().unwrap().remove("position");
    let (status, receipt) = request(&app, "/transfer/confirm", Some(signed)).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["transparent"], true);
    assert!(h
        .admin
        .batch_execute("UPDATE public.transfer_requests SET transparent=false")
        .await
        .is_err());

    public_funding(&h, 1);
    let (status, error) = request(&app, "/transfer", Some(h.request())).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"], "insufficient_public_balance");
    let (status, insufficient) =
        request(&app, "/runs", Some(run_body(&h, &recipients, "2000001"))).await;
    assert_eq!(status, StatusCode::OK, "{insufficient}");
    assert!(insufficient["payments"]
        .as_array()
        .unwrap()
        .iter()
        .all(
            |p| p["status"] == "preparation_failed" && p["error"] == "insufficient_public_balance"
        ));
    h.backend.accounts.lock().unwrap().insert(
        fallback::DISABLE.to_string(),
        json!({"owner":"malformed-sensitive-value"}),
    );
    let (status, error) = request(&app, "/transfer", Some(h.request())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error, json!({"error":"rpc_unavailable"}));
}
