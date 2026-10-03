#[path = "support/transfer.rs"]
mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{solana::v1, transfer_store::TransferStore};
use serde_json::{json, Value};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::sync::atomic::Ordering;
use support::{
    fixture::{AMOUNT, BALANCE},
    Harness, OTHER, USER,
};
use tower::ServiceExt;

async fn post(app: &Router, path: &str, token: &str, value: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 16384).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    if status != StatusCode::OK {
        assert!(!value.to_string().contains(&AMOUNT.to_string()));
        assert!(!value.to_string().contains(&BALANCE.to_string()));
        assert!(!value.to_string().contains("sensitive-value"));
    }
    (status, value)
}
fn chain(tx: &VersionedTransaction) -> Value {
    json!({"slot": 42, "meta": {"err": null}, "transaction": [STANDARD.encode(v1::serialize(tx).unwrap()), "base64"]})
}

#[tokio::test]
async fn malformed_and_unconfigured_requests_have_fixed_json_errors() {
    use cadence_proof::{routes::transfer, solana::client::RpcClient};
    let rpc = std::sync::Arc::new(
        RpcClient::new(
            "http://127.0.0.1:1".parse().unwrap(),
            std::time::Duration::from_secs(1),
        )
        .unwrap(),
    );
    let app = transfer::router(rpc, None);
    for path in ["/transfer", "/transfer/confirm"] {
        let (status, body) = post(
            &app,
            path,
            "sensitive-value",
            json!({"amount": "sensitive-value"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "invalid_request");
    }
    let fixture = support::fixture::Fixture::new();
    let t = fixture.transfer();
    let request = json!({"company_wallet": t.wallet.to_string(), "sender": t.sender.to_string(), "recipient": t.recipient.to_string(), "amount": "1", "aes_key": STANDARD.encode([0;16])});
    let (status, body) = post(&app, "/transfer", "sensitive-value", request).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "transfer_unavailable");
    for _ in 3..30 {
        post(&app, "/transfer", "invalid", json!({})).await;
    }
    let response = app
        .oneshot(Request::post("/transfer").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["retry-after"], "60");
}

#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for an empty disposable Supabase instance with vault.sql applied"]
async fn authenticated_transfer_roundtrip_preserves_privacy_and_database_boundaries() {
    let h = Harness::new().await;
    let app = h.app();
    assert_eq!(
        post(&app, "/transfer", "expired", h.request()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut request = h.request();
    request.as_object_mut().unwrap().remove("wallet_signature");
    assert_eq!(
        post(&app, "/transfer", "test-user", request).await.1["error"],
        "wallet_link_required"
    );
    let mut forged = h.request();
    forged["wallet_signature"] = json!(h.fixture.wallet.sign_message(b"unrelated").to_string());
    assert_eq!(
        post(&app, "/transfer", "test-user", forged).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(&app, "/transfer", "other-user", h.request()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.audit_count().await, 0);
    assert!(h.backend.calls.lock().unwrap().is_empty());

    let (status, prepared) = post(&app, "/transfer", "test-user", h.request()).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["transaction_version"], 1);
    assert_eq!(prepared["last_valid_block_height"], 500);
    assert_eq!(
        prepared["required_signers"],
        json!([h.fixture.wallet.pubkey().to_string()])
    );
    for field in ["amount", "aes_key", "wallet_signature", "actor", "user_id"] {
        assert!(prepared.get(field).is_none());
    }
    assert_eq!(h.audit_count().await, 1);
    let audit = h
        .admin
        .query_one("SELECT actor, reason FROM public.decryption_audit_log", &[])
        .await
        .unwrap();
    assert_eq!(audit.get::<_, String>(0), USER);
    assert_eq!(
        audit.get::<_, String>(1),
        "generate confidential transfer proofs"
    );
    let bytes = STANDARD
        .decode(prepared["transaction"].as_str().unwrap())
        .unwrap();
    assert!(bytes.len() > 1232 && bytes.len() < 4096);
    let mut tx: VersionedTransaction = wincode::deserialize(&bytes).unwrap();
    assert!(matches!(
        tx.message,
        solana_message::VersionedMessage::V1(_)
    ));
    assert_eq!(tx.signatures, vec![solana_signature::Signature::default()]);
    if let solana_message::VersionedMessage::V1(message) = &tx.message {
        assert_eq!(message.instructions.len(), 10);
        use solana_zk_sdk::{
            encryption::elgamal::ElGamalCiphertext, zk_elgamal_proof_program::VerifyZkProof,
        };
        let proof: solana_zk_elgamal_proof_interface::proof_data::BatchedGroupedCiphertext3HandlesValidityProofData = bytemuck::pod_read_unaligned(&message.instructions[3].data[1..]);
        proof.verify_proof().unwrap();
        let lo: ElGamalCiphertext = proof
            .context
            .grouped_ciphertext_lo
            .try_extract_ciphertext(1)
            .unwrap()
            .try_into()
            .unwrap();
        let hi: ElGamalCiphertext = proof
            .context
            .grouped_ciphertext_hi
            .try_extract_ciphertext(1)
            .unwrap()
            .try_into()
            .unwrap();
        assert!(
            lo.decrypt_u32(h.fixture.recipient_key.secret()).unwrap()
                + (hi.decrypt_u32(h.fixture.recipient_key.secret()).unwrap() << 16)
                == AMOUNT
        );
    }
    tx.signatures[0] = h.fixture.wallet.sign_message(&tx.message.serialize());
    let confirm =
        json!({"request_id": prepared["request_id"], "signature": tx.signatures[0].to_string()});
    let confirm_app = h.app();
    assert_eq!(
        post(
            &confirm_app,
            "/transfer/confirm",
            "other-user",
            confirm.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut failed = chain(&tx);
    failed["meta"]["err"] = json!({"InstructionError": [0, "sensitive-value"]});
    let mut malformed = chain(&tx);
    malformed["meta"] = Value::Null;
    for result in [Value::Null, failed, malformed] {
        *h.backend.transaction.lock().unwrap() = result;
        assert_ne!(
            post(
                &confirm_app,
                "/transfer/confirm",
                "test-user",
                confirm.clone()
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let mut unrelated = tx.clone();
    unrelated
        .message
        .set_recent_blockhash(solana_hash::Hash::new_from_array([7; 32]));
    unrelated.signatures[0] = h
        .fixture
        .wallet
        .sign_message(&unrelated.message.serialize());
    let mut forged = tx.clone();
    forged.signatures[0] = solana_keypair::Keypair::new().sign_message(&tx.message.serialize());
    for actual in [unrelated, forged] {
        *h.backend.transaction.lock().unwrap() = chain(&actual);
        let request = json!({"request_id": prepared["request_id"], "signature": actual.signatures[0].to_string()});
        assert_eq!(
            post(&confirm_app, "/transfer/confirm", "test-user", request)
                .await
                .1["error"],
            "transaction_mismatch"
        );
    }
    assert!(h
        .admin
        .query_one("SELECT signature FROM public.transfer_requests", &[])
        .await
        .unwrap()
        .get::<_, Option<String>>(0)
        .is_none());
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    h.admin.batch_execute("REVOKE UPDATE (signature, slot) ON public.transfer_requests FROM cadence_transfer_service").await.unwrap();
    assert_eq!(
        post(
            &confirm_app,
            "/transfer/confirm",
            "test-user",
            confirm.clone()
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    h.admin.batch_execute("GRANT UPDATE (signature, slot) ON public.transfer_requests TO cadence_transfer_service").await.unwrap();
    let (a, b) = tokio::join!(
        post(
            &confirm_app,
            "/transfer/confirm",
            "test-user",
            confirm.clone()
        ),
        post(
            &confirm_app,
            "/transfer/confirm",
            "test-user",
            confirm.clone()
        )
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1["status"], "finalized");
    *h.backend.transaction.lock().unwrap() = Value::Null;
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    assert_eq!(
        post(
            &confirm_app,
            "/transfer/confirm",
            "test-user",
            confirm.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    h.backend.wrong_cluster.store(false, Ordering::SeqCst);
    let mut different = confirm.clone();
    different["signature"] = json!(h.fixture.wallet.sign_message(b"different").to_string());
    assert_eq!(
        post(&confirm_app, "/transfer/confirm", "test-user", different)
            .await
            .1["error"],
        "transfer_already_confirmed"
    );

    let failure_app = h.app();
    assert_eq!(
        post(&failure_app, "/transfer", "other-user", h.request())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut wrong_key = h.request();
    wrong_key["aes_key"] = json!(STANDARD.encode([9; 16]));
    assert_eq!(
        post(&failure_app, "/transfer", "test-user", wrong_key)
            .await
            .1["error"],
        "proof_generation_failed"
    );
    assert_eq!(h.audit_count().await, 2);
    h.admin
        .batch_execute("ALTER TABLE public.decryption_audit_log RENAME TO unavailable_audit_log")
        .await
        .unwrap();
    assert_eq!(
        post(&failure_app, "/transfer", "test-user", h.request())
            .await
            .1["error"],
        "key_storage_unavailable"
    );
    h.admin
        .batch_execute("ALTER TABLE public.unavailable_audit_log RENAME TO decryption_audit_log")
        .await
        .unwrap();
    assert_eq!(h.audit_count().await, 2);
    let sender = h.fixture.transfer().sender.to_string();
    let original = h.backend.accounts.lock().unwrap().remove(&sender).unwrap();
    assert_eq!(
        post(&failure_app, "/transfer", "test-user", h.request())
            .await
            .1["error"],
        "sender_account_missing"
    );
    let mut wrong_owner = original.clone();
    let raw = STANDARD
        .decode(wrong_owner["data"][0].as_str().unwrap())
        .unwrap();
    let mut account = support::fixture::rpc_account(raw);
    let mut state = spl_token_2022_interface::extension::StateWithExtensionsMut::<
        spl_token_2022_interface::state::Account,
    >::unpack(&mut account.data)
    .unwrap();
    state.base.owner = solana_keypair::Keypair::new().pubkey();
    state.pack_base();
    wrong_owner["data"][0] = json!(STANDARD.encode(&account.data));
    h.backend
        .accounts
        .lock()
        .unwrap()
        .insert(sender.clone(), wrong_owner);
    assert_eq!(
        post(&failure_app, "/transfer", "test-user", h.request())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.audit_count().await, 2);
    h.backend.accounts.lock().unwrap().insert(sender, original);

    // Existing links need no signature; a rate-limited request never reads a key.
    let rate_app = h.app();
    let mut linked = h.request();
    linked.as_object_mut().unwrap().remove("wallet_signature");
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    for _ in 0..10 {
        assert_eq!(
            post(&rate_app, "/transfer", "test-user", linked.clone())
                .await
                .1["error"],
            "transfer_requires_devnet"
        );
    }
    assert_eq!(
        post(&rate_app, "/transfer", "test-user", linked).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(h.audit_count().await, 2);
    h.backend.wrong_cluster.store(false, Ordering::SeqCst);
    let calls = h.backend.calls.lock().unwrap().clone();
    assert!(!calls.iter().any(|call| call["method"] == "sendTransaction"));
    assert!(calls.iter().filter(|call| call["method"] == "getTransaction").all(|call| call["params"][1] == json!({"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1})));

    let url = std::env::var("TRANSFER_TEST_DATABASE_URL").unwrap();
    let mut receipts: reqwest::Url = url.parse().unwrap();
    receipts.set_username("cadence_transfer_service").unwrap();
    receipts.set_password(Some("transfer54-test-only")).unwrap();
    receipts.set_query(Some("sslmode=disable"));
    let store = TransferStore::new(receipts.as_str()).unwrap();
    let id = prepared["request_id"].as_str().unwrap();
    assert!(matches!(
        store.get(OTHER, id).await,
        Err(cadence_proof::error::AppError::TransferNotFound)
    ));
    assert_eq!(
        store.get(USER, id).await.unwrap().signature.as_deref(),
        confirm["signature"].as_str()
    );
    let columns: Vec<String> = h.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('transfer_requests', 'proof_wallets')", &[]).await.unwrap().iter().map(|row| row.get(0)).collect();
    for secret in ["amount", "aes_key", "wallet_signature", "secret"] {
        assert!(!columns.iter().any(|name| name == secret));
    }
    for role in ["anon", "authenticated", "service_role"] {
        h.admin
            .batch_execute(&format!("SET ROLE {role}"))
            .await
            .unwrap();
        for sql in [
            "SELECT * FROM public.transfer_requests",
            "SELECT * FROM public.proof_wallets",
            "INSERT INTO public.proof_wallets DEFAULT VALUES",
        ] {
            assert!(h.admin.batch_execute(sql).await.is_err());
        }
        h.admin.batch_execute("RESET ROLE").await.unwrap();
    }
    let receipts_db =
        cadence_proof::database::Database::new(receipts.as_str(), "cadence_transfer_service")
            .unwrap();
    let client = receipts_db.connect().await.unwrap();
    for sql in [
        "UPDATE public.proof_wallets SET user_id = '22222222-2222-4222-8222-222222222222'",
        "DELETE FROM public.proof_wallets",
        "DELETE FROM public.transfer_requests",
        "UPDATE public.transfer_requests SET transaction = 'tampered'",
        "UPDATE public.transfer_requests SET signature = repeat('2',88), slot = 99",
        "SELECT * FROM vault.decrypted_secrets",
        "SELECT * FROM cadence_private.viewing_keys",
    ] {
        assert!(client.batch_execute(sql).await.is_err());
    }
    drop(client);
    receipts.set_username("cadence_key_service").unwrap();
    let key_db =
        cadence_proof::database::Database::new(receipts.as_str(), "cadence_key_service").unwrap();
    let keys = key_db.connect().await.unwrap();
    for sql in [
        "SELECT * FROM public.transfer_requests",
        "SELECT * FROM public.proof_wallets",
    ] {
        assert!(keys.batch_execute(sql).await.is_err());
    }
}
