use super::{request, support};
use axum::http::StatusCode;
use cadence_proof::indexer::{
    store::{Kind, Store},
    verify,
};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

pub async fn index_configure(h: &support::Harness, prepared: &Value, signature: &str) {
    h.admin
        .batch_execute(include_str!(
            "../../../../supabase/migrations/20261011000004_account_indexer.sql"
        ))
        .await
        .unwrap();
    h.admin
        .batch_execute("ALTER ROLE cadence_indexer LOGIN PASSWORD 'cr163-indexer-test-only'")
        .await
        .unwrap();
    let mut url: reqwest::Url = std::env::var("TRANSFER_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap();
    url.set_username("cadence_indexer").unwrap();
    url.set_password(Some("cr163-indexer-test-only")).unwrap();
    url.set_query(Some("sslmode=disable"));
    let store = Store::new(url.as_str()).unwrap();
    let record = store
        .pending()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == prepared["request_id"].as_str().unwrap())
        .unwrap();
    assert_eq!(record.kind, Kind::Account);
    let result = h.backend.transactions.lock().unwrap()[signature].clone();
    let (slot, failed) = verify::outcome(
        &record.id,
        &record.wallet,
        &record.transaction,
        signature,
        &result,
    )
    .unwrap();
    store
        .finish(&record, signature, slot, failed)
        .await
        .unwrap();
    assert!(!h
        .admin
        .query_one(
            "SELECT ready FROM public.proof_accounts WHERE user_id=$1::text::uuid",
            &[&support::OTHER]
        )
        .await
        .unwrap()
        .get::<_, bool>(0));
    h.admin.batch_execute("INSERT INTO public.people (id,company_id,user_id,name,email,kind,status) VALUES ('63000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','Recipient','recipient@example.test','employee','pending')").await.unwrap();
    let confirm = json!({"request_id":prepared["request_id"],"signature":signature});
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    let (status, body) = request(
        &h.app(),
        "/accounts/configure/confirm",
        "other-user",
        Some(confirm.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "wrap_requires_devnet");
    h.backend.wrong_cluster.store(false, Ordering::SeqCst);
    h.backend.finalized_accounts.lock().unwrap().insert(
        prepared["token_account"].as_str().unwrap().into(),
        Value::Null,
    );
    let (status, body) = request(
        &h.app(),
        "/accounts/configure/confirm",
        "other-user",
        Some(confirm),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "token_account_missing");
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
}

pub async fn activated(h: &support::Harness) {
    let row = h.admin.query_one("SELECT a.ready,p.status::text FROM public.proof_accounts a JOIN public.people p ON p.user_id=a.user_id WHERE a.user_id=$1::text::uuid", &[&support::OTHER]).await.unwrap();
    assert!(row.get::<_, bool>(0));
    assert_eq!(row.get::<_, String>(1), "active");
    assert!(h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "getAccountInfo"
            && c["params"][1]["commitment"] == "finalized"
            && c["params"][1]["minContextSlot"] == 42));
}
