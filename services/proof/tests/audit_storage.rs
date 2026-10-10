#[path = "support/auditor_checks.rs"]
mod checks;
#[path = "support/auditor.rs"]
mod support;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use support::{Harness, ADMIN_A, ADMIN_B, AUDITOR_A, AUDITOR_B, COMPANY_A, UNGRANTED};

async fn request(
    h: &Harness,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    use tower::ServiceExt;
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    if !status.is_success() {
        assert!(body.get("amount").is_none());
        assert!(!body.to_string().contains("sensitive-value"));
    }
    (status, body)
}

#[tokio::test]
#[ignore = "requires AUDITOR_TEST_DATABASE_URL for an empty disposable Supabase instance with vault.sql applied"]
async fn company_grants_bound_real_ciphertext_reads_and_durable_audit_records() {
    let h = Harness::new().await;
    let payroll = h.receipt(ADMIN_A, 3, true, "finalized").await;
    let standalone = h.receipt(ADMIN_A, 9, false, "finalized").await;
    h.receipt(ADMIN_B, 10, true, "finalized").await;
    h.receipt(ADMIN_A, 11, false, "prepared").await;
    h.receipt(ADMIN_A, 12, false, "failed").await;
    let path = format!("/audit/{COMPANY_A}/payments");
    for token in ["expired", "admin-a", "auditor-b", "ungranted"] {
        let (status, _) = request(&h, "GET", &path, token, Value::Null).await;
        assert_eq!(
            status,
            if token == "expired" {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::NOT_FOUND
            }
        );
    }
    assert_eq!(h.audit_count().await, 0);
    let (status, page) = request(&h, "GET", &path, "auditor-a", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["items"][0]["payment_id"], payroll);
    assert_eq!(page["items"][1]["payment_id"], standalone);
    assert!(!page["items"][0]["run_id"].is_null());
    assert!(page["items"][1]["run_id"].is_null());
    for item in page["items"].as_array().unwrap() {
        assert_eq!(item["amount"], support::fixture::AMOUNT.to_string());
        assert_eq!(item["status"], "confirmed");
        assert!(item["counterparty"]["id"].is_null());
    }
    assert_eq!(
        h.audit_count().await,
        1,
        "multiple sender keys share one audit row"
    );
    let log = h.admin.query_one("SELECT actor,reason,target_company::text,target_account FROM public.decryption_audit_log", &[]).await.unwrap();
    assert_eq!(log.get::<_, &str>(0), AUDITOR_A);
    assert_eq!(log.get::<_, &str>(1), "read company payments");
    assert_eq!(log.get::<_, &str>(2), COMPANY_A);
    assert!(log.get::<_, Option<String>>(3).is_none());
    let (_, first) = request(
        &h,
        "GET",
        &format!("{path}?limit=1"),
        "auditor-a",
        Value::Null,
    )
    .await;
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["next_cursor"], payroll);
    let (_, second) = request(
        &h,
        "GET",
        &format!("{path}?limit=1&cursor={payroll}"),
        "auditor-a",
        Value::Null,
    )
    .await;
    assert_eq!(second["items"][0]["payment_id"], standalone);
    assert!(second["next_cursor"].is_null());
    let before = h.audit_count().await;
    let (_, empty) = request(
        &h,
        "GET",
        &format!("{path}?cursor={standalone}"),
        "auditor-a",
        Value::Null,
    )
    .await;
    assert_eq!(empty["items"], json!([]));
    assert_eq!(h.audit_count().await, before + 1);
    for query in [
        "limit=0",
        "limit=101",
        "limit=sensitive-value",
        "cursor=sensitive-value",
        "actor=sensitive-value",
    ] {
        assert_eq!(
            request(
                &h,
                "GET",
                &format!("{path}?{query}"),
                "auditor-a",
                Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    let grants = "/company/auditor-grants";
    let (status, list) = request(&h, "GET", grants, "admin-a", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let grant_id = list["items"][0]["id"].as_str().unwrap().to_string();
    let revoke = format!("{grants}/{grant_id}/revoke");
    assert_eq!(
        request(&h, "POST", &revoke, "admin-b", Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&h, "POST", &revoke, "auditor-a", Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let before = h.audit_count().await;
    assert_eq!(
        request(&h, "POST", &revoke, "admin-a", Value::Null).await.1,
        json!({"status":"revoked"})
    );
    assert_eq!(
        request(&h, "GET", &path, "auditor-a", Value::Null).await.0,
        StatusCode::NOT_FOUND,
        "identical bearer token without its grant receives nothing"
    );
    assert_eq!(
        request(&h, "POST", &revoke, "admin-a", Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(h.audit_count().await, before);
    assert_eq!(
        request(
            &h,
            "POST",
            grants,
            "admin-a",
            json!({"auditor_id": AUDITOR_B})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &h,
            "POST",
            grants,
            "ungranted",
            json!({"auditor_id": UNGRANTED})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &h,
            "POST",
            grants,
            "admin-a",
            json!({"auditor_id": AUDITOR_A, "actor": "sensitive-value"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &h,
            "POST",
            grants,
            "admin-a",
            json!({"auditor_id": AUDITOR_A})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        request(
            &h,
            "POST",
            grants,
            "admin-a",
            json!({"auditor_id": AUDITOR_A})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.audit_count().await,
        before,
        "grant administration decrypts nothing"
    );

    checks::permits(&h).await;
    checks::attribution_and_failures(&h).await;
}
