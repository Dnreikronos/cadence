#[path = "support/apply_confirmation.rs"]
mod apply_confirmation;
#[path = "support/account_confirmation.rs"]
mod confirmation;
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
    keys::elgamal::ViewingKey,
    solana::{v1, wrap},
};
use serde_json::{json, Value};
use solana_keypair::Keypair;
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
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    (
        status,
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap(),
    )
}
fn signed(wallet: &Keypair, prepared: &Value) -> (String, Value) {
    let mut tx: VersionedTransaction = wincode::deserialize(
        &STANDARD
            .decode(prepared["transaction"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(tx.message.static_account_keys()[0], wallet.pubkey());
    tx.signatures[0] = wallet.sign_message(&tx.message.serialize());
    (
        tx.signatures[0].to_string(),
        json!({"slot":42,"meta":{"err":null},"transaction":[STANDARD.encode(v1::serialize(&tx).unwrap()),"base64"]}),
    )
}
#[tokio::test]
async fn disabled_account_routes_reject_secrets_without_echoing_them() {
    let rpc = std::sync::Arc::new(
        cadence_proof::solana::client::RpcClient::new(
            "http://127.0.0.1:1".parse().unwrap(),
            std::time::Duration::from_secs(1),
        )
        .unwrap(),
    );
    let app = cadence_proof::routes::accounts::router(rpc, None);
    for path in [
        "/keys/enroll",
        "/accounts/configure",
        "/accounts/apply-pending",
    ] {
        let (status, body) = request(
            &app,
            path,
            "private",
            Some(json!({"signature":"private","amount":"private"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error":"invalid_request"}));
    }
    assert_eq!(
        request(&app, "/me/status", "private", None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for disposable Supabase with vault.sql"]
async fn recipient_enrolls_configures_and_applies_with_durable_receipts() {
    let h = support::Harness::new().await;
    let app = h.app();
    let (status, unmapped) = request(&app, "/me/status", "other-user", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        unmapped,
        json!({"wallet_created":false,"wallet_linked":false,"key_enrolled":false,"account_configured":false,"activated":false,"pending_credit_counter":0,"pending_credits":false})
    );
    let wallet = Keypair::new();
    let account = wrap::destination(&wallet.pubkey());
    let discover = json!({"wallet":wallet.pubkey().to_string(),"wallet_signature":wallet.sign_message(&wallet_link_message(support::OTHER,&wallet.pubkey())).to_string()});
    let (status, found) = request(
        &app,
        "/accounts/discover",
        "other-user",
        Some(discover.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["token_account"], account.to_string());
    let (_, mapped) = request(&app, "/me/status", "other-user", None).await;
    assert_eq!(mapped["wallet_created"], true);
    assert_eq!(mapped["wallet_linked"], true);
    assert_eq!(mapped["key_enrolled"], false);
    assert_eq!(mapped["account_configured"], false);
    assert_eq!(mapped["pending_credits"], false);
    assert_eq!(
        STANDARD
            .decode(found["derivation_message"].as_str().unwrap())
            .unwrap(),
        ViewingKey::signing_message(&account)
    );
    let enrollment = json!({"wallet":wallet.pubkey().to_string(),"token_account":account.to_string(),"signature":wallet.sign_message(&ViewingKey::signing_message(&account)).to_string()});
    let mut invalid = enrollment.clone();
    invalid["signature"] = discover["wallet_signature"].clone();
    let (status, rejected) = request(&app, "/keys/enroll", "other-user", Some(invalid)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(rejected, json!({"error":"invalid_signature"}));
    assert_eq!(
        request(&app, "/keys/enroll", "other-user", Some(enrollment.clone()))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "/keys/enroll", "other-user", Some(enrollment))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "/accounts/discover", "test-user", Some(discover))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let body = json!({"wallet":wallet.pubkey().to_string()});
    let (status, prepared) = request(
        &app,
        "/accounts/configure",
        "other-user",
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    let before = h.audit_count().await;
    assert_eq!(
        request(
            &app,
            "/accounts/configure",
            "other-user",
            Some(body.clone())
        )
        .await
        .1,
        prepared
    );
    assert_eq!(
        h.audit_count().await,
        before,
        "recovering an account preparation decrypts no key"
    );
    let (signature, result) = signed(&wallet, &prepared);
    let confirm = json!({"request_id":prepared["request_id"],"signature":signature});
    assert_eq!(
        request(
            &app,
            "/accounts/configure/confirm",
            "other-user",
            Some(confirm.clone())
        )
        .await
        .1["error"],
        "transaction_not_finalized"
    );
    assert!(h
        .admin
        .query_one(
            "SELECT submitted_signature IS NOT NULL FROM public.account_requests",
            &[]
        )
        .await
        .unwrap()
        .get::<_, bool>(0));
    let (pair, aes) = derive_confidential_keys(&wallet, account.as_ref()).unwrap();
    let mut chain = h.fixture.sender.clone();
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
    state.base.owner = wallet.pubkey();
    state.base.mint = cadence_proof::solana::token_wrap::Addresses::for_usdc().wrapped_mint;
    state.pack_base();
    *state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap() = ConfidentialTransferAccount {
        approved: true.into(),
        elgamal_pubkey: pair.pubkey_owned().into(),
        available_balance: pair.pubkey().encrypt(0_u64).into(),
        decryptable_available_balance: aes.encrypt(0).into(),
        allow_confidential_credits: true.into(),
        maximum_pending_balance_credit_counter: 65536.into(),
        ..Default::default()
    };
    h.backend
        .accounts
        .lock()
        .unwrap()
        .insert(account.to_string(), support::encoded(&chain));
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(signature.clone(), result);
    confirmation::index_configure(&h, &prepared, &signature).await;
    let (status, receipt) = request(
        &app,
        "/accounts/configure/confirm",
        "other-user",
        Some(confirm.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    confirmation::activated(&h).await;
    assert_eq!(
        request(
            &app,
            "/accounts/configure/confirm",
            "test-user",
            Some(confirm.clone())
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            "/accounts/configure/confirm",
            "other-user",
            Some(confirm)
        )
        .await
        .1,
        receipt
    );
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
    let config = state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap();
    config.pending_balance_credit_counter = 1.into();
    config.pending_balance_lo = pair.pubkey().encrypt(100_u64).into();
    config.pending_balance_hi = pair.pubkey().encrypt(0_u64).into();
    h.backend
        .accounts
        .lock()
        .unwrap()
        .insert(account.to_string(), support::encoded(&chain));
    let (_, pending) = request(&app, "/me/status", "other-user", None).await;
    assert_eq!(pending["wallet_linked"], true);
    assert_eq!(pending["key_enrolled"], true);
    assert_eq!(pending["account_configured"], true);
    assert_eq!(pending["pending_credit_counter"], 1);
    assert_eq!(pending["pending_credits"], true);
    let (status, prepared) =
        request(&app, "/accounts/apply-pending", "other-user", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    let (signature, result) = signed(&wallet, &prepared);
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
    let config = state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap();
    config.pending_balance_credit_counter = 0.into();
    config.pending_balance_lo = pair.pubkey().encrypt(0_u64).into();
    config.pending_balance_hi = pair.pubkey().encrypt(0_u64).into();
    config.available_balance = pair.pubkey().encrypt(100_u64).into();
    config.decryptable_available_balance = aes.encrypt(100).into();
    config.expected_pending_balance_credit_counter = 1.into();
    config.actual_pending_balance_credit_counter = 1.into();
    h.backend
        .accounts
        .lock()
        .unwrap()
        .insert(account.to_string(), support::encoded(&chain));
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(signature.clone(), result);
    let confirm = json!({"request_id":prepared["request_id"],"signature":signature});
    let (status, receipt) = request(
        &app,
        "/accounts/apply-pending/confirm",
        "other-user",
        Some(confirm.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(
        request(
            &app,
            "/accounts/apply-pending/confirm",
            "other-user",
            Some(confirm)
        )
        .await
        .1,
        receipt
    );
    let (_, status) = request(&app, "/me/status", "other-user", None).await;
    assert_eq!(status["activated"], true);
    assert_eq!(status["wallet_linked"], true);
    assert_eq!(status["pending_credit_counter"], 0);
    assert_eq!(status["pending_credits"], false);
    let before = h.audit_count().await;
    let (status, balance) = request(&app, "/me/balance", "other-user", None).await;
    assert_eq!(status, StatusCode::OK, "{balance}");
    assert_eq!(
        balance,
        json!({"available":"100","pending":"0","as_of_slot":100})
    );
    assert_eq!(h.audit_count().await, before + 1);
    assert_eq!(
        request(&app, "/company/balance", "other-user", None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    apply_confirmation::mismatch_is_durable(&h, &wallet, &mut chain).await;
    assert!(h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c["method"] != "sendTransaction"));
}
