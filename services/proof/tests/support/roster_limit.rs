use super::{response, support};
use axum::{http::StatusCode, Router};
use serde_json::{json, Value};

pub async fn saturated_writes(h: &support::Harness, app: &Router, person: &str) {
    let path = format!("/company/people/{person}/amount");
    // Hold audited balance reads at their database gate after acquiring proof permits.
    h.admin
        .batch_execute("BEGIN; LOCK TABLE public.decryption_audit_log IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let app = app.clone();
            tokio::spawn(async move { response(&app, "/me/balance", "other-user", None).await })
        })
        .collect();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let waiting: i64=h.admin.query_one("SELECT count(*) FROM pg_locks WHERE NOT granted AND relation='public.decryption_audit_log'::regclass", &[]).await.unwrap().get(0);
            if waiting==4 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("all four balance reads acquired their shared permits");
    for (user, expected) in [
        ("test-user", StatusCode::TOO_MANY_REQUESTS),
        ("other-user", StatusCode::FORBIDDEN),
    ] {
        let (status, headers, body) = response(app, &path, user, Some(json!({"amount":"1"}))).await;
        assert_eq!(status, expected);
        let body: Value = serde_json::from_slice(&body).unwrap();
        if expected == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(body, json!({"error":"transfer_rate_limited"}));
            assert_eq!(headers["retry-after"], "60");
        }
    }
    assert_eq!(
        h.admin
            .query_one("SELECT count(*) FROM cadence_private.roster_amounts", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    h.admin.batch_execute("COMMIT").await.unwrap();
    for worker in workers {
        assert_eq!(worker.await.unwrap().0, StatusCode::OK);
    }
    let (status, _, body) = response(app, &path, "test-user", Some(json!({"amount":"1"}))).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    // Remove this test write so the existing nullable-roster scenario starts unset.
    h.admin
        .batch_execute("DELETE FROM cadence_private.roster_amounts")
        .await
        .unwrap();
}
