#[path = "support/live_contract.rs"]
#[allow(dead_code)]
mod support;
use cadence_proof::solana::{token_wrap::TOKEN_2022, wrap};
use serde_json::json;
use solana_signer::Signer;
use support::Live;

#[tokio::test]
#[ignore = "explicit controlled proof-availability fixture; actual submission/finality stays on devnet"]
async fn live_public_consent_and_real_fallback_receipts() {
    let h = Live::new().await;
    let actor = &h.fixture.admin;
    let wallet = actor.wallet();
    let recipient = h.fixture.recipient.wallet();
    h.fund_public().await;
    let initial = h.public_balance().await;
    let body = json!({"company_wallet":wallet.pubkey().to_string(),"sender":wrap::destination(&wallet.pubkey()).to_string(),"recipient":wrap::destination(&recipient.pubkey()).to_string(),"amount":"1000","aes_key":h.aes()});
    let (status, denied) = h
        .call(&h.outage, actor, "/transfer", Some(body.clone()))
        .await;
    h.record("consent-denial", json!({"status":status,"body":denied}));
    assert_eq!(status, 409);
    assert_eq!(denied, json!({"error":"transparent_consent_required"}));
    let key = Live::creation_key();
    let mut run = h.run_body(&key, "500");
    let (status, run_denied) = h.call(&h.outage, actor, "/runs", Some(run.clone())).await;
    assert_eq!(status, 409);
    assert_eq!(run_denied, json!({"error":"transparent_consent_required"}));
    assert_eq!(
        h.call(&h.api, actor, &format!("/runs/by-key/{key}"), None)
            .await
            .0,
        404,
        "denied creation is not persisted"
    );
    let mut allowed = body;
    allowed["allow_transparent"] = json!(true);
    let (status, prepared) = h.call(&h.outage, actor, "/transfer", Some(allowed)).await;
    assert_eq!(status, 200);
    assert_eq!(prepared["transparent"], true);
    let tx = h.signed(&wallet, &prepared);
    let keys = tx.message.static_account_keys();
    let ix = &tx.message.instructions()[0];
    assert_eq!(tx.message.instructions().len(), 1);
    assert_eq!(keys[ix.program_id_index as usize], TOKEN_2022);
    let (signature, slot) = h.execute("public-transfer", &tx).await;
    let receipt = h
        .ok(
            actor,
            "/transfer/confirm",
            Some(json!({"request_id":prepared["request_id"],"signature":signature})),
        )
        .await;
    assert_eq!(receipt["slot"], slot);
    run["allow_transparent"] = json!(true);
    let (status, prepared_run) = h.call(&h.outage, actor, "/runs", Some(run)).await;
    h.record(
        "public-run-prepare",
        json!({"status":status,"body":prepared_run}),
    );
    assert_eq!(status, 200);
    let id = prepared_run["run_id"].as_str().unwrap();
    let payment = &prepared_run["payments"][0];
    assert_eq!(payment["transparent"], true);
    let tx = h.signed(&wallet, payment);
    let (signature, slot) = h.execute("public-payroll", &tx).await;
    let run_receipt=h.ok(actor,&format!("/runs/{id}/confirm"),Some(json!({"payments":[{"position":0,"request_id":payment["request_id"],"signature":signature}]}))).await;
    assert_eq!(run_receipt["payments"][0]["status"], "finalized");
    assert_eq!(run_receipt["payments"][0]["slot"], slot);
    assert_eq!(h.public_balance().await, initial + 1500);
    h.record("consent-confirmed",json!({"availability":"controlled RPC fixture only; no real chain outage","without_consent":denied,"run_without_consent":run_denied,"transfer_receipt":receipt,"run_receipt":run_receipt,"recipient_public_credit":"1500"}));
}

#[tokio::test]
#[ignore = "resume only the retained unsigned public run from the local fixture journal"]
async fn live_confirm_recovered_public_run() {
    let h = Live::new().await;
    let path = std::path::Path::new(&std::env::var("LIVE63_OUTPUT").unwrap())
        .join("public-run-prepare-probe.json");
    let prepared: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(prepared["status"], 200);
    let run = &prepared["body"];
    let id = run["run_id"].as_str().unwrap();
    let recovered = h
        .ok(&h.fixture.admin, &format!("/runs/{id}/prepared"), None)
        .await;
    assert_eq!(&recovered, run);
    let payment = &recovered["payments"][0];
    assert_eq!(payment["transparent"], true);
    let tx = h.signed(&h.fixture.admin.wallet(), payment);
    let (signature, slot) = h.execute("public-payroll", &tx).await;
    let receipt = h.ok(&h.fixture.admin, &format!("/runs/{id}/confirm"), Some(json!({"payments":[{"position":0,"request_id":payment["request_id"],"signature":signature}]}))).await;
    assert_eq!(receipt["payments"][0]["status"], "finalized");
    assert_eq!(receipt["payments"][0]["slot"], slot);
    assert_eq!(h.public_balance().await, 1500);
    h.record("public-payroll-confirmed", receipt);
}
