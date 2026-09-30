use axum::{
    body::Body,
    http::{header::*, Request, StatusCode},
    routing::post,
    Router,
};
use cadence_proof::cors::policy;
use tower::ServiceExt;

fn app(origins: Option<&str>) -> Router {
    Router::new()
        .route("/wrap", post(|| async { StatusCode::BAD_REQUEST }))
        .layer(policy(origins).unwrap())
}

#[tokio::test]
async fn allowed_preflight_and_error_response_carry_cors_headers() {
    let app = app(Some("http://localhost:5173, https://app.example.com"));
    let preflight = app
        .clone()
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/wrap")
                .header(ORIGIN, "http://localhost:5173")
                .header(ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(ACCESS_CONTROL_REQUEST_HEADERS, "content-type,authorization")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::OK);
    assert_eq!(
        preflight.headers()[ACCESS_CONTROL_ALLOW_ORIGIN],
        "http://localhost:5173"
    );
    assert_eq!(
        preflight.headers()[ACCESS_CONTROL_ALLOW_METHODS],
        "GET,POST"
    );
    assert_eq!(
        preflight.headers()[ACCESS_CONTROL_ALLOW_HEADERS],
        "content-type,authorization"
    );
    assert!(!preflight
        .headers()
        .contains_key(ACCESS_CONTROL_ALLOW_CREDENTIALS));
    assert!(preflight.headers()[VARY]
        .to_str()
        .unwrap()
        .contains("origin"));
    let response = app
        .oneshot(
            Request::post("/wrap")
                .header(ORIGIN, "https://app.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://app.example.com"
    );
}

#[tokio::test]
async fn absent_and_unlisted_origins_receive_no_browser_access() {
    for (configured, origin) in [
        (Some(""), "https://app.example.com"),
        (
            Some("https://app.example.com"),
            "https://app.example.com.evil.test",
        ),
        (Some("https://app.example.com"), "null"),
    ] {
        for method in ["POST", "OPTIONS"] {
            let response = app(configured)
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/wrap")
                        .header(ORIGIN, origin)
                        .header(ACCESS_CONTROL_REQUEST_METHOD, "POST")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(!response.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN));
        }
    }
}

#[test]
fn invalid_allowlists_fail_configuration() {
    for origins in [
        "null",
        "https://app.example.com/",
        "https://app.example.com/path",
        "https://user:pass@app.example.com",
        "https://app.example.com?secret=x",
        "https://app.example.com,",
        "file:///tmp/test",
    ] {
        assert!(policy(Some(origins)).is_err(), "{origins}");
    }
    assert!(policy(Some(" http://localhost:5173,https://app.example.com ")).is_ok());
}

#[tokio::test]
async fn wildcard_default_allows_any_origin_without_credentials() {
    for origins in [None, Some("*")] {
        let response = app(origins)
            .oneshot(
                Request::post("/wrap")
                    .header(ORIGIN, "https://any.example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(!response
            .headers()
            .contains_key(ACCESS_CONTROL_ALLOW_CREDENTIALS));
    }
}
