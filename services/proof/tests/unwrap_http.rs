#[path = "support/transfer.rs"]
#[allow(dead_code)]
mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    auth::wallet_link_message,
    database::Database,
    keys::{elgamal::ViewingKey, vault},
    run_store::{Payment, RunStore, Status},
    solana::{unwrap, v1},
    unwrap_store::UnwrapStore,
};
use serde_json::{json, Value};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_sdk::encryption::derivation::derive_confidential_keys;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::Account,
};
use support::{
    fixture::{AMOUNT, BALANCE},
    Harness, OTHER, USER,
};
use tower::ServiceExt;

async fn post(app: Router, path: &str, token: &str, value: Value) -> (StatusCode, Value) {
    let response = app
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
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    assert!(!value.to_string().contains("sensitive-value"));
    (status, value)
}
fn chain(tx: &VersionedTransaction) -> Value {
    json!({"slot":42,"meta":{"err":null},"transaction":[STANDARD.encode(v1::serialize(tx).unwrap()),"base64"]})
}

#[tokio::test]
async fn unconfigured_and_malformed_requests_use_fixed_errors_and_limits() {
    let rpc = std::sync::Arc::new(
        cadence_proof::solana::client::RpcClient::new(
            "http://127.0.0.1:1".parse().unwrap(),
            std::time::Duration::from_secs(1),
        )
        .unwrap(),
    );
    let app = cadence_proof::routes::unwrap::router(rpc, None);
    for path in ["/unwrap", "/unwrap/check", "/unwrap/confirm"] {
        let (status, body) = post(
            app.clone(),
            path,
            "invalid",
            json!({"amount":"sensitive-value"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "invalid_request");
    }
    let wallet = solana_keypair::Keypair::new();
    assert_eq!(post(app.clone(), "/unwrap", "invalid", json!({"wallet":wallet.pubkey().to_string(),"amount":"1","aes_key":STANDARD.encode([0;16]),"acknowledge_reveal_risk":false})).await.1["error"], "unwrap_unavailable");
    for _ in 4..30 {
        post(app.clone(), "/unwrap/check", "invalid", json!({})).await;
    }
    let response = app
        .oneshot(Request::post("/unwrap").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["retry-after"], "60");
}

#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for an empty disposable Supabase instance with vault.sql applied"]
async fn authenticated_withdrawal_warns_before_preparing_and_confirms_immutably() {
    let h = Harness::new().await;
    h.admin
        .batch_execute(include_str!(
            "../../../supabase/migrations/20261003000001_runs.sql"
        ))
        .await
        .unwrap();
    h.admin
        .batch_execute(include_str!(
            "../../../supabase/migrations/20261004000000_unwrap_requests.sql"
        ))
        .await
        .unwrap();
    let wallet = h.fixture.wallet.pubkey();
    let source = unwrap::source(&wallet);
    let signature = h
        .fixture
        .wallet
        .sign_message(&ViewingKey::signing_message(&source));
    let key = ViewingKey::derive(&wallet, &source, &signature).unwrap();
    let (_, aes) = derive_confidential_keys(&h.fixture.wallet, source.as_ref()).unwrap();
    let mut keys: reqwest::Url = std::env::var("TRANSFER_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap();
    keys.set_username("cadence_key_service").unwrap();
    keys.set_password(Some("transfer54-test-only")).unwrap();
    keys.set_query(Some("sslmode=disable"));
    let database = Database::new(keys.as_str(), "cadence_key_service").unwrap();
    vault::enroll(
        &database.connect().await.unwrap(),
        &wallet,
        &source,
        &signature,
    )
    .await
    .unwrap();
    let mut account = h.fixture.sender.clone();
    {
        let mut state = StateWithExtensionsMut::<Account>::unpack(&mut account.data).unwrap();
        state.base.mint = cadence_proof::solana::token_wrap::Addresses::for_usdc().wrapped_mint;
        let config = state
            .get_extension_mut::<ConfidentialTransferAccount>()
            .unwrap();
        config.elgamal_pubkey = key.public_key().into();
        config.available_balance = key.public_key().encrypt(BALANCE).into();
        config.decryptable_available_balance = aes.encrypt(BALANCE).into();
        state.pack_base();
    }
    h.backend
        .accounts
        .lock()
        .unwrap()
        .insert(source.to_string(), support::encoded(&account));
    let aes_bytes: [u8; 16] = (&aes).into();
    let request = |amount: u64, acknowledge: bool| json!({"wallet":wallet.to_string(),"amount":amount.to_string(),"aes_key":STANDARD.encode(aes_bytes),"acknowledge_reveal_risk":acknowledge,"wallet_signature":h.fixture.wallet.sign_message(&wallet_link_message(USER,&wallet)).to_string()});
    assert_eq!(
        post(h.app(), "/unwrap", "expired", request(1, false))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(h.app(), "/unwrap", "other-user", request(1, false))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.audit_count().await, 0);
    let (status, safe) = post(h.app(), "/unwrap", "test-user", request(1_000_000, false)).await;
    assert_eq!(status, StatusCode::OK, "{safe}");
    assert_eq!(safe["reveal_risk"]["level"], "none");
    // A real confidential incoming payment, confirmed through the existing API.
    let mut transfer_request = h.request();
    transfer_request["recipient"] = json!(source.to_string());
    let (status, incoming) = post(h.app(), "/transfer", "test-user", transfer_request).await;
    assert_eq!(status, StatusCode::OK, "{incoming}");
    let mut tx: VersionedTransaction = wincode::deserialize(
        &STANDARD
            .decode(incoming["transaction"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    tx.signatures[0] = h.fixture.wallet.sign_message(&tx.message.serialize());
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    assert_eq!(
        post(
            h.app(),
            "/transfer/confirm",
            "test-user",
            json!({"request_id":incoming["request_id"],"signature":tx.signatures[0].to_string()})
        )
        .await
        .0,
        StatusCode::OK
    );
    let check = |amount: u64| json!({"wallet":wallet.to_string(),"amount":amount.to_string()});
    let mut receipts_url = keys.clone();
    receipts_url
        .set_username("cadence_transfer_service")
        .unwrap();
    let runs = RunStore::new(receipts_url.as_str()).unwrap();
    let mut payment = Payment {
        position: 0,
        destination: source.to_string(),
        attempt: 0,
        request_id: Some(incoming["request_id"].as_str().unwrap().into()),
        transaction: Some(incoming["transaction"].as_str().unwrap().into()),
        last_valid_block_height: Some(500),
        status: Status::Prepared,
        signature: None,
        slot: None,
        error: None,
    };
    let run = runs
        .prepare(
            USER,
            &wallet.to_string(),
            &h.fixture.transfer().sender.to_string(),
            std::slice::from_ref(&payment),
        )
        .await
        .unwrap();
    let (_, before) = post(h.app(), "/unwrap/check", "test-user", check(AMOUNT)).await;
    assert_eq!(
        before["reveal_risk"]["matches"].as_array().unwrap().len(),
        1
    );
    payment.status = Status::Finalized;
    payment.signature = Some(tx.signatures[0].to_string());
    payment.slot = Some(42);
    runs.finish(USER, &run.id, &payment).await.unwrap();
    let stamped: bool = h
        .admin
        .query_one(
            "SELECT paid_at IS NOT NULL FROM public.payments WHERE run_id = $1::text::uuid",
            &[&run.id],
        )
        .await
        .unwrap()
        .get(0);
    assert!(stamped);
    let mut retry_payment = Payment {
        position: 0,
        destination: source.to_string(),
        attempt: 0,
        request_id: Some("f".repeat(64)),
        transaction: payment.transaction.clone(),
        last_valid_block_height: Some(500),
        status: Status::Prepared,
        signature: None,
        slot: None,
        error: None,
    };
    let retry_run = runs
        .prepare(
            USER,
            &wallet.to_string(),
            &h.fixture.transfer().sender.to_string(),
            std::slice::from_ref(&retry_payment),
        )
        .await
        .unwrap();
    retry_payment.status = Status::Failed;
    retry_payment.signature = Some("5".repeat(88));
    retry_payment.slot = Some(43);
    retry_payment.error = Some("transaction_failed".into());
    runs.finish(USER, &retry_run.id, &retry_payment)
        .await
        .unwrap();
    retry_payment.status = Status::Prepared;
    retry_payment.request_id = Some("e".repeat(64));
    retry_payment.signature = None;
    retry_payment.slot = None;
    retry_payment.error = None;
    runs.retry(USER, &retry_run.id, std::slice::from_ref(&retry_payment))
        .await
        .unwrap();
    let archived: bool = h.admin.query_one("SELECT a.payment_id = p.payment_id FROM public.payment_attempts a JOIN public.payments p USING (run_id,position) WHERE a.run_id = $1::text::uuid", &[&retry_run.id]).await.unwrap().get(0);
    assert!(archived);
    for (amount, level) in [
        (AMOUNT, "exact"),
        (AMOUNT + 42_000, "near"),
        (2_000_000, "none"),
    ] {
        let (status, risk) = post(h.app(), "/unwrap/check", "test-user", check(amount)).await;
        assert_eq!(status, StatusCode::OK, "{risk}");
        assert_eq!(risk["reveal_risk"]["level"], level);
        assert_eq!(risk["requires_acknowledgement"], level != "none");
    }
    let (status, warning) = post(h.app(), "/unwrap", "test-user", request(AMOUNT, false)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(warning["error"], "reveal_risk_not_acknowledged");
    assert_eq!(warning["reveal_risk"]["level"], "exact");
    assert_eq!(
        warning["reveal_risk"]["matches"].as_array().unwrap().len(),
        2
    );
    assert!(uuid::Uuid::parse_str(
        warning["reveal_risk"]["matches"][0]["payment_id"]
            .as_str()
            .unwrap()
    )
    .is_ok());
    assert!(warning.get("transaction").is_none());
    assert!(!warning.to_string().contains("amount"));
    assert_eq!(
        h.admin
            .query_one("SELECT count(*) FROM public.unwrap_requests", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    let (status, prepared) = post(h.app(), "/unwrap", "test-user", request(AMOUNT, true)).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["reveal_risk"]["level"], "exact");
    assert_eq!(
        prepared["destination"],
        unwrap::destination(&wallet).to_string()
    );
    for field in ["amount", "aes_key", "wallet_signature"] {
        assert!(prepared.get(field).is_none());
    }
    let mut withdrawal: VersionedTransaction = wincode::deserialize(
        &STANDARD
            .decode(prepared["transaction"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    withdrawal.signatures[0] = h
        .fixture
        .wallet
        .sign_message(&withdrawal.message.serialize());
    let confirm = json!({"request_id":prepared["request_id"],"signature":withdrawal.signatures[0].to_string()});
    assert_eq!(
        post(h.app(), "/unwrap/confirm", "other-user", confirm.clone())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    *h.backend.transaction.lock().unwrap() = Value::Null;
    assert_eq!(
        post(h.app(), "/unwrap/confirm", "test-user", confirm.clone())
            .await
            .1["error"],
        "transaction_not_finalized"
    );
    let mut failed = chain(&withdrawal);
    failed["meta"]["err"] = json!({"InstructionError":[0,"sensitive-value"]});
    *h.backend.transaction.lock().unwrap() = failed;
    assert_eq!(
        post(h.app(), "/unwrap/confirm", "test-user", confirm.clone())
            .await
            .1["error"],
        "transaction_failed"
    );
    *h.backend.transaction.lock().unwrap() = chain(&tx);
    assert_eq!(
        post(h.app(), "/unwrap/confirm", "test-user", confirm.clone())
            .await
            .1["error"],
        "transaction_mismatch"
    );
    *h.backend.transaction.lock().unwrap() = chain(&withdrawal);
    let (status, receipt) = post(h.app(), "/unwrap/confirm", "test-user", confirm.clone()).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["status"], "finalized");
    let calls = h.backend.calls.lock().unwrap().len();
    assert_eq!(
        post(h.app(), "/unwrap/confirm", "test-user", confirm)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(h.backend.calls.lock().unwrap().len(), calls);
    keys.set_username("cadence_transfer_service").unwrap();
    let receipt_database = Database::new(keys.as_str(), "cadence_transfer_service").unwrap();
    let receipt_client = receipt_database.connect().await.unwrap();
    let store = UnwrapStore::new(keys.as_str()).unwrap();
    assert!(matches!(
        store
            .get(OTHER, prepared["request_id"].as_str().unwrap())
            .await,
        Err(cadence_proof::error::AppError::UnwrapNotFound)
    ));
    assert!(store
        .confirm(
            USER,
            prepared["request_id"].as_str().unwrap(),
            &h.fixture.wallet.sign_message(b"different").to_string(),
            99
        )
        .await
        .is_err());
    for role in ["anon", "authenticated", "service_role"] {
        h.admin
            .batch_execute(&format!("SET ROLE {role}"))
            .await
            .unwrap();
        assert!(h
            .admin
            .batch_execute("SELECT * FROM public.unwrap_requests")
            .await
            .is_err());
        h.admin.batch_execute("RESET ROLE").await.unwrap();
    }
    for sql in [
        "DELETE FROM public.unwrap_requests",
        "UPDATE public.unwrap_requests SET transaction='tampered'",
        "UPDATE public.unwrap_requests SET slot=99 WHERE signature IS NOT NULL",
    ] {
        assert!(receipt_client.batch_execute(sql).await.is_err());
    }
    h.admin.batch_execute("REVOKE EXECUTE ON FUNCTION cadence_private.audit_key_read(text,text,text) FROM cadence_key_service").await.unwrap();
    let audits = h.audit_count().await;
    assert_eq!(
        post(h.app(), "/unwrap", "test-user", request(AMOUNT, true))
            .await
            .1["error"],
        "key_storage_unavailable"
    );
    assert_eq!(h.audit_count().await, audits);
    h.admin.batch_execute("GRANT EXECUTE ON FUNCTION cadence_private.audit_key_read(text,text,text) TO cadence_key_service").await.unwrap();
    h.admin
        .batch_execute("REVOKE SELECT ON public.transfer_requests FROM cadence_transfer_service")
        .await
        .unwrap();
    let (status, error) = post(h.app(), "/unwrap", "test-user", request(AMOUNT, true)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["error"], "unwrap_storage_unavailable");
}
