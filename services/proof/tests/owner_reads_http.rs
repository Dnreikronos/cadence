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
    solana::{token_wrap::Addresses, v1, wrap},
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
async fn response(
    app: &Router,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let builder = if body.is_some() {
        Request::post(path)
    } else {
        Request::get(path)
    };
    let r = app
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
    if !path.starts_with("/transfer") {
        assert_eq!(r.headers()["cache-control"], "no-store");
    }
    (
        r.status(),
        r.headers().clone(),
        to_bytes(r.into_body(), 1048576).await.unwrap().to_vec(),
    )
}
async fn json_response(
    app: &Router,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (status, _, bytes) = response(app, path, token, body).await;
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for a disposable Supabase instance with vault.sql"]
async fn authorized_histories_roster_and_csv_share_committed_audit_gates() {
    let h = support::Harness::new().await;
    let app = h.app();
    let company = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let person = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    h.admin
        .execute(
            "UPDATE public.companies SET name='=formula,company' WHERE id=$1::text::uuid",
            &[&company],
        )
        .await
        .unwrap();
    h.admin.execute("INSERT INTO public.people(id,company_id,name,email,kind,user_id) VALUES($1::text::uuid,$2::text::uuid,'Recipient','recipient@example.test','employee',$3::text::uuid)", &[&person,&company,&support::OTHER]).await.unwrap();
    let wallet = Keypair::new();
    let destination = wrap::destination(&wallet.pubkey());
    let (pair, aes) = derive_confidential_keys(&wallet, destination.as_ref()).unwrap();
    let mut chain = h.fixture.recipient.clone();
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
    state.base.owner = wallet.pubkey();
    state.base.mint = Addresses::for_usdc().wrapped_mint;
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
        .insert(destination.to_string(), support::encoded(&chain));
    h.backend
        .finalized_accounts
        .lock()
        .unwrap()
        .insert(destination.to_string(), Value::Null);
    let enrolled = json!({"wallet":wallet.pubkey().to_string(),"token_account":destination.to_string(),"wallet_signature":wallet.sign_message(&wallet_link_message(support::OTHER,&wallet.pubkey())).to_string(),"signature":wallet.sign_message(&ViewingKey::signing_message(&destination)).to_string()});
    let (status, body) = json_response(&app, "/keys/enroll", "other-user", Some(enrolled)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!h
        .admin
        .query_one(
            "SELECT ready FROM public.proof_accounts WHERE user_id=$1::text::uuid",
            &[&support::OTHER]
        )
        .await
        .unwrap()
        .get::<_, bool>(0));
    h.backend.finalized_accounts.lock().unwrap().clear();
    let (status, found) = json_response(
        &app,
        "/accounts/discover",
        "other-user",
        Some(json!({"wallet":wallet.pubkey().to_string()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["account_configured"], true);
    assert_eq!(
        h.admin
            .query_one(
                "SELECT status::text FROM public.people WHERE id=$1::text::uuid",
                &[&person]
            )
            .await
            .unwrap()
            .get::<_, String>(0),
        "active"
    );
    let mut body = h.request();
    body["recipient"] = json!(destination.to_string());
    let (status, prepared) = json_response(&app, "/transfer", "test-user", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    let mut tx: VersionedTransaction = wincode::deserialize(
        &STANDARD
            .decode(prepared["transaction"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    tx.signatures[0] = h.fixture.wallet.sign_message(&tx.message.serialize());
    let signature = tx.signatures[0].to_string();
    h.backend.transactions.lock().unwrap().insert(signature.clone(),json!({"slot":42,"meta":{"err":null},"transaction":[STANDARD.encode(v1::serialize(&tx).unwrap()),"base64"]}));
    assert_eq!(
        json_response(
            &app,
            "/transfer/confirm",
            "test-user",
            Some(json!({"request_id":prepared["request_id"],"signature":signature}))
        )
        .await
        .0,
        StatusCode::OK
    );
    for (path, token) in [
        ("/company/payments", "test-user"),
        ("/me/payments", "other-user"),
    ] {
        let before = h.audit_count().await;
        let (status, page) = json_response(&app, path, token, None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(
            page["items"][0]["amount"],
            support::fixture::AMOUNT.to_string()
        );
        assert_eq!(h.audit_count().await, before + 1);
    }
    let before = h.audit_count().await;
    assert_eq!(
        json_response(&app, "/company/payments", "other-user", None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.audit_count().await, before);
    let path = format!("/company/people/{person}/amount");
    assert_eq!(
        json_response(
            &app,
            &path,
            "other-user",
            Some(json!({"amount":"123456789"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = json_response(
        &app,
        &path,
        "test-user",
        Some(json!({"amount":"123456789"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, roster) = json_response(&app, "/company/people/amounts", "test-user", None).await;
    assert_eq!(status, StatusCode::OK, "{roster}");
    assert_eq!(roster["items"][0]["amount"], "123456789");
    assert_eq!(roster["items"][0]["token_account"], destination.to_string());
    let (_, accounts) = json_response(&app, "/company/people/accounts", "test-user", None).await;
    assert_eq!(
        accounts["items"][0]["token_account"],
        destination.to_string()
    );
    let url = std::env::var("TRANSFER_TEST_DATABASE_URL").unwrap();
    let mut key_url: reqwest::Url = url.parse().unwrap();
    key_url.set_username("cadence_key_service").unwrap();
    key_url.set_password(Some("transfer54-test-only")).unwrap();
    let client = cadence_proof::database::Database::new(key_url.as_str(), "cadence_key_service")
        .unwrap()
        .connect()
        .await
        .unwrap();
    cadence_proof::owner_reads::identity(&client, support::USER)
        .await
        .unwrap();
    client.batch_execute("BEGIN").await.unwrap();
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read('company',20,NULL)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(client
        .query(
            "SELECT * FROM cadence_private.read_owner_payments($1,'company')",
            &[&permit]
        )
        .await
        .is_err());
    client.batch_execute("ROLLBACK").await.unwrap();
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read('company',10000,NULL)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    h.admin.execute("UPDATE cadence_private.owner_read_permits SET item_ids=(SELECT array_agg(gen_random_uuid()) FROM generate_series(1,10001)) WHERE id=$1::text::uuid", &[&permit]).await.unwrap();
    let error = client
        .query(
            "SELECT * FROM cadence_private.read_owner_payments($1,'company')",
            &[&permit],
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.code().unwrap().code(), "CD413");
    for table in [
        "cadence_private.roster_amounts",
        "cadence_private.balance_keys",
        "cadence_private.owner_read_permits",
    ] {
        assert!(client
            .query(&format!("SELECT * FROM {table}"), &[])
            .await
            .is_err());
    }
    let columns=h.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('proof_accounts','account_requests')",&[]).await.unwrap();
    for row in columns {
        assert!(!["amount", "aes_key", "signature_key", "secret"]
            .contains(&row.get::<_, String>(0).as_str()));
    }
}
