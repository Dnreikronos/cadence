use super::{apply_sender, chain, request, sign, support::Harness};
use cadence_proof::solana::batch;
use serde_json::{json, Value};
use solana_address::Address;
use std::sync::atomic::Ordering;

pub(super) async fn expired_payments_do_not_block_other_positions(h: &Harness, body: &Value) {
    let recipients: Vec<_> = (30..33)
        .map(|i| Address::new_from_array([i; 32]).to_string())
        .collect();
    let destination = h
        .backend
        .accounts
        .lock()
        .unwrap()
        .get(&h.fixture.transfer().recipient.to_string())
        .unwrap()
        .clone();
    {
        let mut accounts = h.backend.accounts.lock().unwrap();
        accounts.insert(recipients[0].clone(), destination.clone());
        accounts.insert(recipients[2].clone(), destination.clone());
    }
    h.backend.finalized_height.store(499, Ordering::SeqCst);
    let audit = h.audit_count().await;
    let mut body = body.clone();
    body["payments"] = json!(recipients
        .iter()
        .map(|recipient| json!({"recipient":recipient,"amount":"1000000"}))
        .collect::<Vec<_>>());
    let app = h.app();
    let (status, run) = request(&app, "/runs", "test-user", Some(body.clone())).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{run}");
    assert_eq!(run["payments"][1]["status"], "preparation_failed");
    let id = run["run_id"].as_str().unwrap();
    let retry = format!("/runs/{id}/retry");
    let only_failed =
        json!({"aes_key":body["aes_key"],"payments":[{"position":1,"amount":"1000000"}]});
    for height in [499, 500] {
        h.backend.finalized_height.store(height, Ordering::SeqCst);
        let (status, blocked) = request(&app, &retry, "test-user", Some(only_failed.clone())).await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(blocked["error"], "outstanding_payments");
    }
    let unsigned = json!({"aes_key":body["aes_key"],"payments":[
        {"position":0,"amount":"1000000"},
        {"position":1,"amount":"1000000"},
        {"position":2,"amount":"1000000"},
    ]});
    let (status, blocked) = request(&app, &retry, "test-user", Some(unsigned)).await;
    assert_eq!(status, axum::http::StatusCode::CONFLICT);
    assert_eq!(blocked["error"], "original_signature_required");
    h.backend.finalized_height.store(501, Ordering::SeqCst);
    h.backend.wrong_cluster.store(true, Ordering::SeqCst);
    let (_, blocked) = request(&app, &retry, "test-user", Some(only_failed.clone())).await;
    assert_eq!(blocked["error"], "runs_requires_devnet");
    h.backend.wrong_cluster.store(false, Ordering::SeqCst);
    assert_eq!(h.audit_count().await, audit + 1);

    // Position 0 landed, while the unsigned position 2 was never broadcast.
    let landed = sign(h, &run["payments"][0]);
    apply_sender(h, &landed);
    h.backend
        .accounts
        .lock()
        .unwrap()
        .insert(recipients[1].clone(), destination);
    let (status, recovered) = request(&app, &retry, "test-user", Some(only_failed)).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{recovered}");
    let expected = json!([
        {"position":0,"error":"transaction_history_unavailable"},
        {"position":2,"error":"transaction_history_unavailable"},
    ]);
    assert_eq!(recovered["errors"], expected);
    for position in [0, 2] {
        let payment = &recovered["payments"][position];
        assert_eq!(payment["status"], "prepared");
        assert_eq!(payment["attempt"], 0);
        assert_eq!(
            payment["request_id"],
            run["payments"][position]["request_id"]
        );
        assert!(payment.get("transaction").is_none());
        assert!(payment.get("last_valid_block_height").is_none());
        let row = h.admin.query_one(
            "SELECT transaction,last_valid_block_height,attempt FROM public.payments WHERE run_id=$1::text::uuid AND position=$2",
            &[&id, &(position as i16)],
        ).await.unwrap();
        assert_eq!(
            row.get::<_, String>(0),
            run["payments"][position]["transaction"].as_str().unwrap()
        );
        assert_eq!(
            row.get::<_, i64>(1),
            run["payments"][position]["last_valid_block_height"]
                .as_i64()
                .unwrap()
        );
        assert_eq!(row.get::<_, i32>(2), 0);
    }
    assert_eq!(recovered["payments"][1]["attempt"], 1);
    let rebuilt = sign(h, &recovered["payments"][1]);
    let (_, after_landed) = batch::resulting_balance(&landed).unwrap();
    let after_landed = after_landed.try_into().unwrap();
    let (_, after_retry) = batch::resulting_balance(&rebuilt).unwrap();
    let after_retry = after_retry.try_into().unwrap();
    assert_eq!(
        h.fixture.aes.decrypt(&after_retry).unwrap(),
        h.fixture.aes.decrypt(&after_landed).unwrap() - 1_000_000
    );
    assert_eq!(h.audit_count().await, audit + 2);
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(rebuilt.signatures[0].to_string(), chain(&rebuilt, false));
    let (_, paid) = request(
        &app, &format!("/runs/{id}/confirm"), "test-user",
        Some(json!({"payments":[{"position":1,"request_id":recovered["payments"][1]["request_id"],"signature":rebuilt.signatures[0].to_string()}]})),
    ).await;
    assert_eq!(paid["payments"][1]["status"], "finalized");
    apply_sender(h, &rebuilt);

    let unresolved = json!({"aes_key":body["aes_key"],"payments":[
        {"position":0,"amount":"1000000","signature":landed.signatures[0].to_string()},
        {"position":2,"amount":"1000000"},
    ]});
    let (status, unchanged) = request(&app, &retry, "test-user", Some(unresolved)).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{unchanged}");
    assert_eq!(unchanged["errors"], expected);
    assert!(unchanged["payments"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p.get("transaction").is_none()));
    assert_eq!(h.audit_count().await, audit + 2);

    let original = sign(h, &run["payments"][2]);
    {
        let mut transactions = h.backend.transactions.lock().unwrap();
        transactions.insert(landed.signatures[0].to_string(), chain(&landed, false));
        transactions.insert(original.signatures[0].to_string(), chain(&original, true));
    }
    let (status, resolved) = request(
        &app,
        &retry,
        "test-user",
        Some(json!({"aes_key":body["aes_key"],"payments":[
            {"position":0,"amount":"1000000","signature":landed.signatures[0].to_string()},
            {"position":2,"amount":"1000000","signature":original.signatures[0].to_string()},
        ]})),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{resolved}");
    assert_eq!(resolved["payments"][0]["status"], "finalized");
    assert_eq!(resolved["payments"][0]["attempt"], 0);
    assert!(resolved["payments"][0].get("transaction").is_none());
    assert_eq!(resolved["payments"][2]["attempt"], 1);
    assert!(resolved.get("errors").is_none());
    assert_eq!(h.audit_count().await, audit + 3);
}
