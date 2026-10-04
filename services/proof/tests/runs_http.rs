#[path = "support/transfer.rs"]
mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::{batch, v1};
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
use std::sync::atomic::Ordering;
use support::{fixture::BALANCE, Harness};
use tower::ServiceExt;

async fn request(
    app: &Router,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = if body.is_some() {
        Request::post(path)
    } else {
        Request::get(path)
    };
    let response = app
        .clone()
        .oneshot(
            builder
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    for secret in ["amount", "aes_key", "wallet_signature", "secret"] {
        assert!(value.get(secret).is_none());
    }
    (status, value)
}
fn sign(h: &Harness, p: &Value) -> VersionedTransaction {
    let mut tx: VersionedTransaction =
        wincode::deserialize(&STANDARD.decode(p["transaction"].as_str().unwrap()).unwrap())
            .unwrap();
    assert!(tx
        .signatures
        .iter()
        .all(|s| *s == solana_signature::Signature::default()));
    let solana_message::VersionedMessage::V1(message) = &tx.message else {
        panic!("expected v1")
    };
    let proof: solana_zk_elgamal_proof_interface::proof_data::BatchedGroupedCiphertext3HandlesValidityProofData =
        bytemuck::pod_read_unaligned(&message.instructions[3].data[1..]);
    let lo: solana_zk_sdk::encryption::elgamal::ElGamalCiphertext = proof
        .context
        .grouped_ciphertext_lo
        .try_extract_ciphertext(1)
        .unwrap()
        .try_into()
        .unwrap();
    let hi: solana_zk_sdk::encryption::elgamal::ElGamalCiphertext = proof
        .context
        .grouped_ciphertext_hi
        .try_extract_ciphertext(1)
        .unwrap()
        .try_into()
        .unwrap();
    assert!(
        lo.decrypt_u32(h.fixture.recipient_key.secret()).unwrap()
            + (hi.decrypt_u32(h.fixture.recipient_key.secret()).unwrap() << 16)
            == 1_000_000
    );
    tx.signatures[0] = h.fixture.wallet.sign_message(&tx.message.serialize());
    tx
}
fn chain(tx: &VersionedTransaction, failed: bool) -> Value {
    json!({"slot":42,"meta":{"err":if failed{json!({"InstructionError":[6,"sensitive-value"]})}else{Value::Null}},"transaction":[STANDARD.encode(v1::serialize(tx).unwrap()),"base64"]})
}
fn apply_sender(h: &Harness, tx: &VersionedTransaction) {
    let sender = h.fixture.transfer().sender.to_string();
    let mut accounts = h.backend.accounts.lock().unwrap();
    let encoded = accounts.get_mut(&sender).unwrap();
    let mut data = STANDARD
        .decode(encoded["data"][0].as_str().unwrap())
        .unwrap();
    let (elgamal, aes) = batch::resulting_balance(tx).unwrap();
    let mut account = StateWithExtensionsMut::<Account>::unpack(&mut data).unwrap();
    let c = account
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap();
    c.available_balance = elgamal;
    c.decryptable_available_balance = aes;
    encoded["data"][0] = json!(STANDARD.encode(data));
}

#[tokio::test]
async fn invalid_and_disabled_runs_have_sanitized_errors() {
    let rpc = std::sync::Arc::new(
        cadence_proof::solana::client::RpcClient::new(
            "http://127.0.0.1:1".parse().unwrap(),
            std::time::Duration::from_secs(1),
        )
        .unwrap(),
    );
    let app = cadence_proof::routes::runs::router(rpc, None);
    for path in [
        "/runs",
        "/runs/11111111-1111-4111-8111-111111111111/confirm",
        "/runs/11111111-1111-4111-8111-111111111111/retry",
    ] {
        let (status, body) = request(
            &app,
            path,
            "sensitive-value",
            Some(json!({"amount":"sensitive-value"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error":"invalid_request"}));
    }
    let (status, body) = request(
        &app,
        "/runs/11111111-1111-4111-8111-111111111111",
        "test-user",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "run_storage_unavailable");
    assert_eq!(
        request(&app, "/runs/bad-id", "test-user", None).await.0,
        StatusCode::BAD_REQUEST
    );
    for _ in 0..25 {
        request(&app, "/runs", "test-user", Some(json!({}))).await;
    }
    assert_eq!(
        request(&app, "/runs", "test-user", Some(json!({}))).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for an empty disposable Supabase instance with vault.sql applied"]
async fn three_recipient_run_recovers_partial_failure_without_repaying_successes() {
    let h = Harness::new().await;
    h.admin
        .batch_execute(include_str!(
            "../../../supabase/migrations/20261003000001_runs.sql"
        ))
        .await
        .unwrap();
    let recipients: Vec<_> = (20..23)
        .map(|i| Address::new_from_array([i; 32]).to_string())
        .collect();
    {
        let mut accounts = h.backend.accounts.lock().unwrap();
        let destination = accounts
            .get(&h.fixture.transfer().recipient.to_string())
            .unwrap()
            .clone();
        for address in &recipients {
            accounts.insert(address.clone(), destination.clone());
        }
    }
    let mut body = h.request();
    body.as_object_mut().unwrap().remove("recipient");
    body.as_object_mut().unwrap().remove("amount");
    body["payments"] = json!(recipients
        .iter()
        .map(|r| json!({"recipient":r,"amount":"1000000"}))
        .collect::<Vec<_>>());
    {
        let mut delays = h.backend.delayed_accounts.lock().unwrap();
        for (recipient, delay) in recipients.iter().zip([50, 1, 10]) {
            delays.insert(recipient.clone(), std::time::Duration::from_millis(delay));
        }
    }
    let app = h.app();
    assert_eq!(
        request(&app, "/runs", "expired", Some(body.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "/runs", "other-user", Some(body.clone()))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.audit_count().await, 0);
    let mut duplicate = body.clone();
    duplicate["payments"][1] = duplicate["payments"][0].clone();
    assert_eq!(
        request(&app, "/runs", "test-user", Some(duplicate)).await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, run) = request(&app, "/runs", "test-user", Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(run["payments"].as_array().unwrap().len(), 3);
    for (i, payment) in run["payments"].as_array().unwrap().iter().enumerate() {
        assert_eq!(payment["position"], i);
        assert_eq!(payment["destination"], recipients[i]);
    }
    assert!(h.backend.peak_account_reads.load(Ordering::SeqCst) > 1);
    assert_eq!(h.audit_count().await, 1);
    let id = run["run_id"].as_str().unwrap();
    let get = format!("/runs/{id}");
    let confirm = format!("{get}/confirm");
    let retry = format!("{get}/retry");
    assert_eq!(
        request(&app, &get, "other-user", None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &confirm, "other-user", Some(json!({"payments":[]})))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (_, read) = request(&app, &get, "test-user", None).await;
    assert!(read["payments"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p.get("transaction").is_none() && p.get("amount").is_none()));
    let txs: Vec<_> = run["payments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| sign(&h, p))
        .collect();
    assert!(txs.iter().all(|tx| v1::serialize(tx).unwrap().len() < 4096));
    {
        let mut transactions = h.backend.transactions.lock().unwrap();
        transactions.insert(txs[0].signatures[0].to_string(), chain(&txs[0], false));
        transactions.insert(txs[1].signatures[0].to_string(), chain(&txs[1], true));
    }
    let confirmations = json!({"payments":txs.iter().enumerate().map(|(i,tx)|json!({"position":i,"request_id":run["payments"][i]["request_id"],"signature":tx.signatures[0].to_string()})).collect::<Vec<_>>()});
    let mut forged = confirmations.clone();
    forged["payments"][0]["signature"] = json!(solana_keypair::Keypair::new()
        .sign_message(&txs[0].message.serialize())
        .to_string());
    let (_, mixed) = request(&app, &confirm, "test-user", Some(forged)).await;
    assert_eq!(mixed["payments"][0]["status"], "prepared");
    assert_eq!(mixed["payments"][1]["status"], "failed");
    assert_eq!(mixed["errors"][0]["error"], "transaction_mismatch");
    assert!(!mixed.to_string().contains("sensitive-value"));
    let (_, partial) = request(&app, &confirm, "test-user", Some(confirmations.clone())).await;
    assert_eq!(partial["payments"][0]["status"], "finalized");
    assert_eq!(partial["payments"][1]["status"], "failed");
    assert_eq!(partial["payments"][2]["status"], "prepared");
    apply_sender(&h, &txs[0]);
    let retry_body = json!({"aes_key":body["aes_key"],"payments":[{"position":1,"amount":"1000000"},{"position":2,"amount":"1000000","signature":txs[2].signatures[0].to_string()}]});
    assert_eq!(
        request(&app, &retry, "test-user", Some(retry_body.clone()))
            .await
            .1["error"],
        "transaction_not_finalized"
    );
    h.backend.finalized_height.store(501, Ordering::SeqCst);
    let (status, unresolved) = request(&app, &retry, "test-user", Some(retry_body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{unresolved}");
    assert_eq!(
        unresolved["errors"],
        json!([{"position":2,"error":"transaction_history_unavailable"}])
    );
    assert_eq!(unresolved["payments"][1]["status"], "prepared");
    assert_eq!(unresolved["payments"][1]["attempt"], 1);
    assert!(unresolved["payments"][2].get("transaction").is_none());
    let (_, unchanged) = request(&app, &get, "test-user", None).await;
    assert_eq!(unchanged["payments"][2]["status"], "prepared");
    assert_eq!(unchanged["payments"][2]["attempt"], 0);
    assert_eq!(
        unchanged["payments"][2]["request_id"],
        run["payments"][2]["request_id"]
    );
    assert_eq!(h.audit_count().await, 2);
    let recovered = sign(&h, &unresolved["payments"][1]);
    h.backend.transactions.lock().unwrap().insert(
        recovered.signatures[0].to_string(),
        chain(&recovered, false),
    );
    let (_, paid) = request(
        &app,
        &confirm,
        "test-user",
        Some(json!({"payments":[{"position":1,"request_id":unresolved["payments"][1]["request_id"],"signature":recovered.signatures[0].to_string()}]})),
    ).await;
    assert_eq!(paid["payments"][1]["status"], "finalized");
    apply_sender(&h, &recovered);
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(txs[2].signatures[0].to_string(), chain(&txs[2], true));
    let (status, reprepared) = request(&app, &retry, "test-user", Some(retry_body)).await;
    assert_eq!(status, StatusCode::OK, "{reprepared}");
    assert_eq!(reprepared["payments"][0]["status"], "finalized");
    assert!(reprepared["payments"][0].get("transaction").is_none());
    assert_eq!(reprepared["payments"][1]["status"], "finalized");
    assert!(reprepared["payments"][1].get("transaction").is_none());
    assert_eq!(h.audit_count().await, 3);
    let mut retry_confirm = vec![];
    let mut last = None;
    for i in 1..3 {
        let p = &reprepared["payments"][i];
        if p["status"] == "finalized" {
            continue;
        }
        assert_eq!(p["attempt"], 1);
        let tx = sign(&h, p);
        h.backend
            .transactions
            .lock()
            .unwrap()
            .insert(tx.signatures[0].to_string(), chain(&tx, false));
        retry_confirm.push(json!({"position":i,"request_id":p["request_id"],"signature":tx.signatures[0].to_string()}));
        last = Some(tx);
    }
    let finish = json!({"payments":retry_confirm});
    let (status, complete) = request(&app, &confirm, "test-user", Some(finish.clone())).await;
    assert_eq!(status, StatusCode::OK, "{complete}");
    assert_eq!(complete["status"], "completed");
    assert!(complete["payments"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["status"] == "finalized"));
    let history: i64 = h
        .admin
        .query_one("SELECT count(*) FROM public.payment_attempts", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(history, 2);
    h.backend.transactions.lock().unwrap().clear();
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    assert_eq!(
        request(&h.app(), &confirm, "test-user", Some(finish))
            .await
            .1["status"],
        "completed"
    );
    h.backend.wrong_cluster.store(false, Ordering::SeqCst);
    apply_sender(&h, last.as_ref().unwrap());

    // A missing recipient is isolated, including in the predicted sender state.
    h.backend.accounts.lock().unwrap().remove(&recipients[1]);
    let (_, skip) = request(&h.app(), "/runs", "test-user", Some(body.clone())).await;
    assert_eq!(skip["payments"][1]["status"], "preparation_failed");
    assert_eq!(skip["payments"][2]["status"], "prepared");
    let last = sign(&h, &skip["payments"][2]);
    let (_, aes) = batch::resulting_balance(&last).unwrap();
    let aes: solana_zk_sdk::encryption::auth_encryption::AeCiphertext = aes.try_into().unwrap();
    assert!(h.fixture.aes.decrypt(&aes) == Some(BALANCE - 5_000_000));

    // Expiry must reconcile an already-landed success rather than pay it twice.
    let id = skip["run_id"].as_str().unwrap();
    let tx = sign(&h, &skip["payments"][0]);
    let retry = json!({"aes_key":body["aes_key"],"payments":[{"position":0,"amount":"1000000","signature":tx.signatures[0].to_string()},{"position":2,"amount":"1000000","signature":last.signatures[0].to_string()}]});
    apply_sender(&h, &tx);
    let audit = h.audit_count().await;
    let (status, ambiguous) = request(
        &h.app(),
        &format!("/runs/{id}/retry"),
        "test-user",
        Some(retry.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ambiguous}");
    assert_eq!(
        ambiguous["errors"],
        json!([
            {"position":0,"error":"transaction_history_unavailable"},
            {"position":2,"error":"transaction_history_unavailable"},
        ])
    );
    assert!(ambiguous["payments"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p.get("transaction").is_none()));
    let (_, unchanged) = request(&h.app(), &format!("/runs/{id}"), "test-user", None).await;
    assert_eq!(unchanged["payments"][0]["status"], "prepared");
    assert_eq!(unchanged["payments"][0]["attempt"], 0);
    assert_eq!(
        unchanged["payments"][0]["request_id"],
        skip["payments"][0]["request_id"]
    );
    assert_eq!(h.audit_count().await, audit);
    {
        let mut transactions = h.backend.transactions.lock().unwrap();
        transactions.insert(tx.signatures[0].to_string(), chain(&tx, false));
        transactions.insert(last.signatures[0].to_string(), chain(&last, true));
    }
    let (_, resolved) = request(
        &h.app(),
        &format!("/runs/{id}/retry"),
        "test-user",
        Some(retry),
    )
    .await;
    assert_eq!(resolved["payments"][0]["status"], "finalized");
    assert!(resolved["payments"][0].get("transaction").is_none());
    assert_eq!(resolved["payments"][2]["attempt"], 1);
    h.backend
        .unavailable_accounts
        .lock()
        .unwrap()
        .insert(recipients[1].clone());
    let (_, isolated) = request(&h.app(), "/runs", "test-user", Some(body.clone())).await;
    assert_eq!(isolated["payments"][1]["status"], "preparation_failed");
    assert_eq!(isolated["payments"][1]["error"], "rpc_unavailable");
    assert_eq!(isolated["payments"][2]["status"], "prepared");
    assert!(!isolated.to_string().contains("sensitive-value"));
    assert!(h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c["method"] != "sendTransaction"));
    retry::expired_payments_do_not_block_other_positions(&h, &body).await;
}

#[path = "support/runs_retry.rs"]
mod retry;
