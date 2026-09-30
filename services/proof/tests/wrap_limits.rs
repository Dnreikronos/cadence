#[path = "support/wrap.rs"]
mod support;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use std::net::SocketAddr;
use support::Harness;
use tower::ServiceExt;

#[tokio::test]
async fn wallet_quota_rejects_before_rpc_and_storage_across_peers() {
    let h = Harness::new(true).await;
    for i in 0..11 {
        let before = h.backend.calls.lock().unwrap().len();
        let response = h
            .app
            .clone()
            .oneshot(
                Request::post("/wrap")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, i], 8000))))
                    .header("content-type", "application/json")
                    .body(Body::from(h.request(false).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        if i == 10 {
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(response.headers()["retry-after"], "60");
            assert_eq!(h.backend.calls.lock().unwrap().len(), before);
        } else {
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
    assert_eq!(h.backend.records.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn spoofed_forwarding_headers_do_not_bypass_peer_limit() {
    let h = Harness::new(true).await;
    for i in 0..31 {
        let response = h
            .app
            .clone()
            .oneshot(
                Request::post("/wrap/confirm")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 8000))))
                    .header("x-forwarded-for", format!("10.0.0.{i}"))
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if i == 30 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::BAD_REQUEST
            }
        );
    }
    assert!(h.backend.calls.lock().unwrap().is_empty());
    assert!(h.backend.records.lock().unwrap().is_empty());
}
