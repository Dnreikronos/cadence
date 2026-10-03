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
