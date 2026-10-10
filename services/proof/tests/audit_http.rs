#[path = "support/confidential.rs"]
#[allow(dead_code)]
mod fixture;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    routes::audit::Service,
    solana::{confidential, reveal_risk, v1},
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tower::ServiceExt;

async fn request(
    app: Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
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
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    if !status.is_success() {
        assert!(value.get("amount").is_none());
        assert!(!value.to_string().contains("sensitive-value"));
    }
    (status, value)
}

#[test]
fn audit_requires_its_own_database_role_and_verified_auth_configuration() {
    assert!(Service::parse(|_| None).unwrap().is_none());
    let mut config = HashMap::from([
        (
            "PROOF_AUDIT_DATABASE_URL",
            "postgres://cadence_audit_service:test-only@localhost/db?sslmode=disable",
        ),
        ("PROOF_SUPABASE_URL", "http://127.0.0.1:1"),
        ("PROOF_SUPABASE_API_KEY", "public-test-key"),
    ]);
    assert!(
        Service::parse(|name| config.get(name).map(|value| value.to_string()))
            .unwrap()
            .is_some()
    );
    config.insert(
        "PROOF_AUDIT_DATABASE_URL",
        "postgres://postgres:test-only@localhost/db?sslmode=disable",
    );
    assert!(Service::parse(|name| config.get(name).map(|value| value.to_string())).is_err());
    config.remove("PROOF_SUPABASE_API_KEY");
    assert!(Service::parse(|name| config.get(name).map(|value| value.to_string())).is_err());
}

#[tokio::test]
async fn unconfigured_audit_routes_are_fixed_errors_and_never_cache() {
    let app = cadence_proof::routes::audit::router(None);
    for (method, path) in [
        (
            "GET",
            "/audit/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/payments",
        ),
        ("GET", "/company/auditor-grants"),
        ("POST", "/company/auditor-grants"),
        (
            "POST",
            "/company/auditor-grants/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revoke",
        ),
    ] {
        let (status, body) = request(app.clone(), method, path, "invalid", Value::Null).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, json!({"error":"audit_unavailable"}));
    }
}

#[test]
fn sender_ciphertext_requires_the_correct_account_mint_and_viewing_key() {
    let f = fixture::Fixture::new();
    let transfer = f.transfer();
    let tx =
        STANDARD.encode(v1::serialize(&confidential::build(&transfer, &f.key).unwrap()).unwrap());
    assert_eq!(
        *reveal_risk::sent_amount(&tx, &transfer.sender, &transfer.mint, &f.key).unwrap(),
        fixture::AMOUNT
    );
    assert!(reveal_risk::sent_amount(&tx, &transfer.recipient, &transfer.mint, &f.key).is_err());
    assert!(reveal_risk::sent_amount(&tx, &transfer.sender, &transfer.sender, &f.key).is_err());
    let other = fixture::Fixture::new();
    assert!(reveal_risk::sent_amount(&tx, &transfer.sender, &transfer.mint, &other.key).is_err());
}
