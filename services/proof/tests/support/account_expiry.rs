use super::{request, support};
use axum::{http::StatusCode, Router};
use serde_json::Value;
use std::sync::atomic::Ordering;

pub async fn retains_unknown(
    h: &support::Harness,
    app: &Router,
    body: &Value,
    prepared: &Value,
    submitted: bool,
) {
    h.backend.finalized_height.store(501, Ordering::SeqCst);
    assert_eq!(prepared["last_valid_block_height"], 500);
    let before = h.audit_count().await;
    let (status, recovered) =
        request(app, "/accounts/configure", "other-user", Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        recovered, *prepared,
        "expiry cannot replace an unknown transaction"
    );
    assert_eq!(h.audit_count().await, before);
    let row=h.admin.query_one("SELECT status,submitted_signature IS NOT NULL,signature IS NULL,transaction,last_valid_block_height FROM public.account_requests", &[]).await.unwrap();
    assert_eq!(row.get::<_, String>(0), "prepared");
    assert_eq!(row.get::<_, bool>(1), submitted);
    assert!(row.get::<_, bool>(2));
    assert_eq!(
        row.get::<_, String>(3),
        prepared["transaction"].as_str().unwrap()
    );
    assert_eq!(row.get::<_, i64>(4), 500);
    assert_eq!(
        h.admin
            .query_one("SELECT count(*) FROM public.account_requests", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    h.backend.finalized_height.store(0, Ordering::SeqCst);
}
