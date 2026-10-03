use axum::{
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use cadence_proof::{
    auth::{wallet_link_message, SupabaseAuth},
    routes::transfer::Service,
};
use serde_json::{json, Value};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn configuration_and_link_message_bind_the_verified_user_and_wallet() {
    assert!(Service::parse(|_| None).unwrap().is_none());
    assert!(
        Service::parse(|name| (name == "PROOF_KEY_DATABASE_URL").then(|| "secret".into())).is_err()
    );
    for url in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com/path",
    ] {
        assert!(SupabaseAuth::new(url.parse().unwrap(), "test").is_err());
    }
    let wallet = Keypair::new();
    let proof = wallet.sign_message(&wallet_link_message("user-one", &wallet.pubkey()));
    assert!(proof.verify(
        wallet.pubkey().as_ref(),
        &wallet_link_message("user-one", &wallet.pubkey())
    ));
    assert!(!proof.verify(
        wallet.pubkey().as_ref(),
        &wallet_link_message("user-two", &wallet.pubkey())
    ));
    assert!(!proof.verify(wallet.pubkey().as_ref(), b"login"));
}

#[tokio::test]
async fn validates_tokens_with_auth_and_sanitizes_provider_failures() {
    async fn user(headers: HeaderMap) -> (StatusCode, Json<Value>) {
        assert_eq!(headers["apikey"], "public-test-key");
        let (status, body) = match headers["authorization"].to_str().unwrap() {
            "Bearer valid" => (
                StatusCode::OK,
                json!({"id": "11111111-1111-4111-8111-111111111111"}),
            ),
            "Bearer malformed" => (StatusCode::OK, json!({"id": "provider-sensitive-value"})),
            "Bearer down" => (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "provider-sensitive-value"}),
            ),
            _ => (
                StatusCode::UNAUTHORIZED,
                json!({"error": "provider-sensitive-value"}),
            ),
        };
        (status, Json(body))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let auth = SupabaseAuth::new(
        format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap(),
        "public-test-key",
    )
    .unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/auth/v1/user", get(user)))
            .await
            .unwrap();
    });
    assert_eq!(
        auth.user(&HeaderMap::new()).await.unwrap_err().status(),
        StatusCode::UNAUTHORIZED
    );
    for token in ["valid", "expired", "malformed", "down"] {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        let result = auth.user(&headers).await;
        if token == "valid" {
            assert_eq!(result.unwrap(), "11111111-1111-4111-8111-111111111111");
        } else {
            let error = result.unwrap_err();
            assert!(!error.to_string().contains("provider-sensitive-value"));
            assert_eq!(
                error.status(),
                if token == "expired" {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            );
        }
    }
    task.abort();
}
