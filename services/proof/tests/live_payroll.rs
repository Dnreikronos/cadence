#[path = "support/live_contract.rs"]
#[allow(dead_code)]
mod support;
use serde_json::json;
use support::Live;

#[tokio::test]
#[ignore = "explicit live devnet fixture with fresh configured recipient"]
async fn live_run_recovery_blocks_uncertainty_and_finalizes() {
    let h = Live::new().await;
    let actor = &h.fixture.admin;
    h.enroll(actor).await;
    let key = Live::creation_key();
    let body = h.run_body(&key, "1111");
    let (first, second) = tokio::join!(
        h.ok(actor, "/runs", Some(body.clone())),
        h.ok(actor, "/runs", Some(body.clone()))
    );
    assert_eq!(first, second, "concurrent create commits one original run");
    let id = first["run_id"].as_str().unwrap();
    assert_eq!(
        h.ok(actor, &format!("/runs/by-key/{key}"), None).await,
        first
    );
    assert_eq!(
        h.ok(actor, &format!("/runs/{id}/prepared"), None).await,
        first
    );
    let payment = &first["payments"][0];
    assert_eq!(payment["status"], "prepared");
    assert_eq!(payment["transparent"], false);
    let wallet = actor.wallet();
    let tx = h.signed(&wallet, payment);
    let other = h.run_body(&Live::creation_key(), "1111");
    let (status, overlap) = h.call(&h.api, actor, "/runs", Some(other)).await;
    assert_eq!(status, 409);
    assert_eq!(overlap["error"], "outstanding_payments");
    let retry = json!({"aes_key":h.aes(),"payments":[{"position":0,"amount":"1111","signature":tx.signatures[0].to_string()}]});
    let (status, unresolved) = h
        .call(&h.api, actor, &format!("/runs/{id}/retry"), Some(retry))
        .await;
    assert_eq!(status, 409);
    assert_eq!(unresolved["error"], "transaction_not_finalized");
    assert_eq!(
        h.ok(actor, &format!("/runs/{id}/prepared"), None).await,
        first,
        "uncertainty cannot replace payload"
    );
    let confirmation = json!({"payments":[{"position":0,"request_id":payment["request_id"],"signature":tx.signatures[0].to_string()}]});
    let before = h
        .ok(
            actor,
            &format!("/runs/{id}/confirm"),
            Some(confirmation.clone()),
        )
        .await;
    assert_eq!(before["payments"][0]["status"], "prepared");
    assert_eq!(before["errors"][0]["error"], "transaction_not_finalized");
    let (_, slot) = h.execute("payroll", &tx).await;
    let receipt = h
        .ok(
            actor,
            &format!("/runs/{id}/confirm"),
            Some(confirmation.clone()),
        )
        .await;
    assert_eq!(receipt["payments"][0]["status"], "finalized");
    assert_eq!(receipt["payments"][0]["slot"], slot);
    assert_eq!(
        h.ok(actor, &format!("/runs/{id}/confirm"), Some(confirmation))
            .await,
        receipt
    );
    let reread = h.ok(actor, &format!("/runs/{id}"), None).await;
    assert_eq!(reread["status"], "completed");
    let received = h
        .ok(&h.fixture.recipient, "/me/payments?limit=100", None)
        .await;
    let item = received["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["signature"] == tx.signatures[0].to_string())
        .unwrap();
    assert_eq!(item["amount"], "1111");
    assert_eq!(item["status"], "confirmed");
    h.record("payroll-confirmed",json!({"run_id":id,"idempotency_key":key,"receipt":receipt,"reread":reread,"received":received,"overlap_error":overlap,"uncertain_retry":unresolved}));
}
