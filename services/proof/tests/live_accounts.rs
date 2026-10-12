#[path = "support/live_contract.rs"]
#[allow(dead_code)]
mod support;
use cadence_proof::solana::wrap;
use serde_json::json;
use solana_signer::Signer;
use support::Live;

#[tokio::test]
#[ignore = "explicit live devnet fixture only; see WEB3_INTEGRATION_HANDOFF.md"]
async fn live_canonical_enrollment_and_configure() {
    let h = Live::new().await;
    let actor = &h.fixture.recipient;
    let initial = h.ok(actor, "/me/status", None).await;
    assert_eq!(initial["wallet_linked"], false);
    assert_eq!(initial["pending_credits"], false);
    h.fund_recipient().await;
    h.enroll(actor).await;
    let enrolled = h.ok(actor, "/me/status", None).await;
    assert_eq!(enrolled["wallet_linked"], true);
    assert_eq!(enrolled["key_enrolled"], true);
    assert_eq!(enrolled["account_configured"], false);
    assert_eq!(h.person().await["status"], "pending");
    let wallet = actor.wallet();
    let body = json!({"wallet":wallet.pubkey().to_string()});
    let prepared = h.ok(actor, "/accounts/configure", Some(body.clone())).await;
    assert_eq!(prepared["transaction_version"], 1);
    assert_eq!(
        prepared["token_account"],
        wrap::destination(&wallet.pubkey()).to_string()
    );
    assert_eq!(
        h.ok(actor, "/accounts/configure", Some(body)).await,
        prepared,
        "lost response recovery retains exact configure payload"
    );
    let tx = h.signed(&wallet, &prepared);
    let confirmation =
        json!({"request_id":prepared["request_id"],"signature":tx.signatures[0].to_string()});
    let (status, pending) = h
        .call(
            &h.api,
            actor,
            "/accounts/configure/confirm",
            Some(confirmation.clone()),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(pending["error"], "transaction_not_finalized");
    let (_, slot) = h.execute("configure", &tx).await;
    let receipt = h
        .ok(
            actor,
            "/accounts/configure/confirm",
            Some(confirmation.clone()),
        )
        .await;
    assert_eq!(receipt["slot"], slot);
    assert_eq!(
        h.ok(actor, "/accounts/configure/confirm", Some(confirmation))
            .await,
        receipt
    );
    let state = h.ok(actor, "/me/status", None).await;
    assert_eq!(state["account_configured"], true);
    assert_eq!(state["activated"], true);
    assert_eq!(state["pending_credits"], false);
    let person = h.person().await;
    assert_eq!(person["status"], "active");
    assert_eq!(person["user_id"], actor.user_id);
    h.record(
        "configure-confirmed",
        json!({"receipt":receipt,"status":state,"person":person}),
    );
}

#[tokio::test]
#[ignore = "requires the configured recipient and finalized payroll fixture"]
async fn live_apply_pending_and_durable_receipt() {
    let h = Live::new().await;
    let actor = &h.fixture.recipient;
    let before = h.ok(actor, "/me/balance", None).await;
    let available: u64 = before["available"].as_str().unwrap().parse().unwrap();
    let pending: u64 = before["pending"].as_str().unwrap().parse().unwrap();
    assert_eq!(pending, 1111);
    let state = h.ok(actor, "/me/status", None).await;
    assert_eq!(state["pending_credits"], true);
    assert!(state["pending_credit_counter"].as_u64().unwrap() > 0);
    let wallet = actor.wallet();
    let body = json!({"wallet":wallet.pubkey().to_string()});
    let prepared = h
        .ok(actor, "/accounts/apply-pending", Some(body.clone()))
        .await;
    assert_eq!(
        h.ok(actor, "/accounts/apply-pending", Some(body.clone()))
            .await,
        prepared
    );
    let tx = h.signed(&wallet, &prepared);
    let confirmation =
        json!({"request_id":prepared["request_id"],"signature":tx.signatures[0].to_string()});
    let (status, unresolved) = h
        .call(
            &h.api,
            actor,
            "/accounts/apply-pending/confirm",
            Some(confirmation.clone()),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(unresolved["error"], "transaction_not_finalized");
    let (_, slot) = h.execute("apply", &tx).await;
    let receipt = h
        .ok(
            actor,
            "/accounts/apply-pending/confirm",
            Some(confirmation.clone()),
        )
        .await;
    assert_eq!(receipt["slot"], slot);
    assert_eq!(
        h.ok(actor, "/accounts/apply-pending/confirm", Some(confirmation))
            .await,
        receipt
    );
    let after = h.ok(actor, "/me/balance", None).await;
    assert_eq!(after["available"], (available + pending).to_string());
    assert_eq!(after["pending"], "0");
    let state = h.ok(actor, "/me/status", None).await;
    assert_eq!(state["pending_credit_counter"], 0);
    assert_eq!(state["pending_credits"], false);
    let (status, empty) = h
        .call(&h.api, actor, "/accounts/apply-pending", Some(body))
        .await;
    assert_eq!(status, 409);
    assert_eq!(empty["error"], "nothing_to_apply");
    h.record(
        "apply-confirmed",
        json!({"receipt":receipt,"before":before,"after":after,"status":state}),
    );
}
