#[path = "support/run_creation.rs"]
mod creation;
#[path = "support/transfer.rs"]
#[allow(dead_code)]
mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
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

#[tokio::test]
#[ignore = "requires TRANSFER_TEST_DATABASE_URL for a disposable Supabase instance with vault.sql"]
async fn concurrent_create_recovers_one_run_without_rebuilding_or_cross_owner_leaks() {
    let h = support::Harness::new().await;
    let app = h.app();
    let mut body = h.request();
    let recipient = body.as_object_mut().unwrap().remove("recipient").unwrap();
    let amount = body.as_object_mut().unwrap().remove("amount").unwrap();
    let key = "63000000-0000-4000-8000-000000000001";
    body["idempotency_key"] = json!(key);
    body["payments"] = json!([{"recipient": recipient, "amount": amount}]);
    let (a, b) = tokio::join!(
        request(&app, "/runs", "test-user", Some(body.clone())),
        request(&app, "/runs", "test-user", Some(body.clone()))
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(a.1, b.1);
    assert_eq!(h.audit_count().await, 1);
    creation::slow_owner(&h.admin, key).await;
    assert_eq!(h.audit_count().await, 1);
    assert_eq!(
        h.admin
            .query_one("SELECT count(*) FROM public.runs", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    let id = a.1["run_id"].as_str().unwrap();
    assert_eq!(
        request(&app, &format!("/runs/by-key/{key}"), "test-user", None)
            .await
            .1,
        a.1
    );
    assert_eq!(
        request(&app, &format!("/runs/{id}/prepared"), "test-user", None)
            .await
            .1,
        a.1
    );
    assert_eq!(
        request(&app, &format!("/runs/by-key/{key}"), "other-user", None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, page) = request(&app, "/runs?limit=1", "test-user", None).await;
    assert_eq!(page["items"][0]["run_id"], id);
    assert!(page["items"][0]["payments"][0].get("transaction").is_none());
    assert_eq!(
        request(&app, "/runs?limit=101", "test-user", None).await.0,
        StatusCode::BAD_REQUEST
    );
    body["payments"][0]["amount"] = json!("2");
    assert_eq!(
        request(&app, "/runs", "test-user", Some(body.clone()))
            .await
            .1,
        a.1
    );
    let mut duplicate = body.clone();
    duplicate["idempotency_key"] = json!("63000000-0000-4000-8000-000000000002");
    let (_, blocked) = request(&app, "/runs", "test-user", Some(duplicate)).await;
    assert_eq!(blocked, json!({"error":"outstanding_payments"}));
    body["sender"] = json!(solana_address::Address::new_from_array([19; 32]).to_string());
    assert_eq!(
        request(&app, "/runs", "test-user", Some(body.clone()))
            .await
            .0,
        StatusCode::CONFLICT
    );
    h.admin
        .execute(
            "UPDATE public.memberships SET role='recipient' WHERE user_id=$1::text::uuid",
            &[&support::USER],
        )
        .await
        .unwrap();
    let (status, denied) = request(&app, "/runs", "test-user", Some(body)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(denied, json!({"error":"forbidden_role"}));
    let retry =
        json!({"aes_key":h.request()["aes_key"],"payments":[{"position":0,"amount":"1000000"}]});
    let (status, denied) =
        request(&app, &format!("/runs/{id}/retry"), "test-user", Some(retry)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(denied, json!({"error":"forbidden_role"}));
}
