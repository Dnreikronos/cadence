#[path = "support/indexer_history.rs"]
mod history;
#[path = "support/indexer_startup.rs"]
mod startup;
#[path = "support/indexer.rs"]
mod support;

use cadence_proof::{
    error::AppError,
    indexer::{
        store::{Kind, Store},
        verify,
    },
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use solana_keypair::Keypair;
use std::{sync::atomic::Ordering, time::Duration};
use support::{payment, Harness, RUN, USER};
use tokio_tungstenite::tungstenite::Message;

#[test]
fn exact_message_verification_covers_failures_and_rejects_forged_signatures() {
    let wallet = Keypair::new();
    for kind in [Kind::Run, Kind::Wrap, Kind::Transfer, Kind::Unwrap] {
        let (p, sig, result) = payment(&wallet, kind, 1, true, true);
        assert_eq!(
            verify::outcome(&p.id, &p.wallet, &p.transaction, &sig, &result).unwrap(),
            (42, true)
        );
        assert_eq!(
            verify::discovered(&result).unwrap(),
            (p.id.clone(), sig.clone())
        );
        let (_, other, _) = payment(&Keypair::new(), kind, 1, true, false);
        assert!(matches!(
            verify::submission(&p.id, &p.wallet, &p.transaction, &other),
            Err(AppError::Conflict("transaction_mismatch"))
        ));
        assert!(verify::submission(&"a".repeat(64), &p.wallet, &p.transaction, &sig).is_err());
        let mut malformed = result.clone();
        malformed["meta"] = Value::Null;
        assert!(verify::outcome(&p.id, &p.wallet, &p.transaction, &sig, &malformed).is_err());
        let (_, _, wrong) = payment(&wallet, kind, 2, true, false);
        assert!(verify::outcome(&p.id, &p.wallet, &p.transaction, &sig, &wrong).is_err());
    }
}

#[tokio::test]
#[ignore = "requires INDEXER_TEST_DATABASE_URL for an empty disposable Supabase PostgreSQL instance"]
async fn backfill_subscriptions_events_permissions_and_restart() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let websocket = format!("ws://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let h = Harness::new(websocket).await;
    let store = Store::new(&h.receipts_url).unwrap();
    let mut records = vec![];
    for (i, kind) in [Kind::Run, Kind::Wrap, Kind::Transfer, Kind::Unwrap]
        .into_iter()
        .enumerate()
    {
        for failed in [false, true] {
            let nonce = (i * 2 + usize::from(failed) + 1) as u8;
            let (p, sig, result) = payment(&h.wallet, kind, nonce, !failed, failed);
            h.insert(&p, nonce as i16).await;
            h.backend
                .transactions
                .lock()
                .unwrap()
                .insert(sig.clone(), result);
            h.backend.history.lock().unwrap().insert(0, sig.clone());
            records.push((p, sig, failed));
        }
    }
    let (missing, missing_sig, _) = payment(&h.wallet, Kind::Run, 20, true, false);
    h.insert(&missing, 20).await;
    h.indexer.backfill().await.unwrap();
    assert_eq!(h.events().await, 8);
    for (p, sig, failed) in &records {
        h.assert_status(p, if *failed { "failed" } else { "finalized" })
            .await;
        let (a, b) = tokio::join!(
            store.finish(p, sig, 42, *failed),
            store.finish(p, sig, 42, *failed)
        );
        a.unwrap();
        b.unwrap();
        assert!(store.finish(p, sig, 43, !*failed).await.is_err());
    }
    h.indexer.backfill().await.unwrap();
    assert_eq!(h.events().await, 8);
    h.assert_status(&missing, "prepared").await;
    assert_eq!(
        h.db.query_one(
            "SELECT count(*) FROM public.transfer_requests WHERE paid_at IS NOT NULL",
            &[]
        )
        .await
        .unwrap()
        .get::<_, i64>(0),
        1
    );
    let calls = h.backend.calls.lock().unwrap().clone();
    assert!(calls
        .iter()
        .any(|c| c["method"] == "getSignaturesForAddress" && !c["params"][1]["before"].is_null()));
    assert!(calls
        .iter()
        .filter(|c| c["method"] == "getTransaction")
        .all(|c| c["params"][1]["maxSupportedTransactionVersion"] == 1));

    // A failed RPC prevents readiness/backfill and does not overwrite receipts.
    h.backend.unavailable.store(true, Ordering::SeqCst);
    assert!(h.indexer.backfill().await.is_err());
    h.backend.unavailable.store(false, Ordering::SeqCst);

    // Outbox failure rolls the receipt back, including its timestamp.
    h.db.batch_execute("CREATE FUNCTION public.reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER reject_event BEFORE INSERT ON public.payment_events FOR EACH ROW EXECUTE FUNCTION public.reject_event();").await.unwrap();
    assert!(store
        .finish(&missing, &missing_sig, 42, false)
        .await
        .is_err());
    h.assert_status(&missing, "prepared").await;
    h.db.batch_execute("DROP TRIGGER reject_event ON public.payment_events")
        .await
        .unwrap();

    // Unknown signatures and late client confirmations cannot replace tracked ones.
    assert!(store
        .finish(&missing, &records[0].1, 42, false)
        .await
        .is_err());
    let mut receipts: reqwest::Url = h.receipts_url.parse().unwrap();
    receipts.set_username("cadence_transfer_service").unwrap();
    let run_store = cadence_proof::run_store::RunStore::new(receipts.as_str()).unwrap();
    let run = run_store.get(USER, RUN).await.unwrap();
    let p = run.payments.iter().find(|p| p.position == 20).unwrap();
    run_store
        .submitted(USER, RUN, p, &missing_sig)
        .await
        .unwrap();
    assert!(run_store
        .submitted(USER, RUN, p, &records[0].1)
        .await
        .is_err());
    assert!(run_store
        .submitted("33333333-3333-4333-8333-333333333333", RUN, p, &missing_sig)
        .await
        .is_err());

    // A notification prompts an HTTP evidence read; its error body is not trusted.
    let (notify_ready, ready) = tokio::sync::oneshot::channel();
    let backend = h.backend.clone();
    let signature = missing_sig.clone();
    let (_, _, receipt) = payment(&h.wallet, Kind::Run, 20, true, false);
    let ws = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(message) = socket.next().await {
            if let Message::Text(text) = message.unwrap() {
                let request: Value = serde_json::from_str(&text).unwrap();
                if request["method"] == "signatureSubscribe" {
                    assert_eq!(request["params"][0], signature);
                    assert_eq!(request["params"][1]["commitment"], "finalized");
                    socket
                        .send(Message::Text(
                            json!({"jsonrpc":"2.0","id":request["id"],"result":7})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                    backend
                        .transactions
                        .lock()
                        .unwrap()
                        .insert(signature, receipt);
                    socket.send(Message::Text(json!({"jsonrpc":"2.0","method":"signatureNotification","params":{"subscription":7,"result":{"context":{"slot":999},"value":{"err":"amount-and-secret"}}}}).to_string().into())).await.unwrap();
                    notify_ready.send(()).unwrap();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    socket.close(None).await.unwrap();
                    break;
                }
            }
        }
    });
    let worker = h.indexer.clone().spawn();
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    for _ in 0..30 {
        if h.events().await == 9 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(h.events().await, 9);
    h.assert_status(&missing, "finalized").await;
    ws.await.unwrap();
    worker.abort();

    // Restart backfills a payment finalized while the worker was offline.
    let (offline, sig, result) = payment(&h.wallet, Kind::Unwrap, 30, true, false);
    h.insert(&offline, 30).await;
    h.backend.transactions.lock().unwrap().insert(sig, result);
    let restarted = cadence_proof::indexer::Indexer::new(
        std::sync::Arc::new(
            cadence_proof::solana::client::RpcClient::new(
                h.origin.parse().unwrap(),
                Duration::from_secs(3),
            )
            .unwrap(),
        ),
        &h.receipts_url,
        "ws://127.0.0.1:1".parse().unwrap(),
    )
    .unwrap();
    restarted.backfill().await.unwrap();
    h.assert_status(&offline, "finalized").await;
    assert_eq!(h.events().await, 10);

    let (unknown, sig, result) = payment(&h.wallet, Kind::Transfer, 40, false, false);
    h.insert(&unknown, 40).await;
    h.backend.history.lock().unwrap().insert(0, sig.clone());
    let old_cursor = store.cursors().await.unwrap();
    assert!(matches!(
        h.indexer.backfill().await,
        Err(AppError::Conflict("transaction_history_unavailable"))
    ));
    assert_eq!(store.cursors().await.unwrap(), old_cursor);
    h.assert_status(&unknown, "prepared").await;
    let mut malformed = result.clone();
    malformed["meta"] = Value::Null;
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(sig.clone(), malformed);
    assert!(h.indexer.backfill().await.is_err());
    assert_eq!(store.cursors().await.unwrap(), old_cursor);
    h.backend.transactions.lock().unwrap().insert(sig, result);
    h.indexer.backfill().await.unwrap();
    h.assert_status(&unknown, "finalized").await;
    startup::verify(&h).await;
    assert_eq!(h.events().await, 12);
    history::verify(&h).await;
    let events_before_permission_checks = h.events().await;

    for role in ["anon", "authenticated", "service_role"] {
        h.db.batch_execute(&format!("SET ROLE {role}"))
            .await
            .unwrap();
        for sql in [
            "INSERT INTO public.payment_events DEFAULT VALUES",
            "UPDATE public.payment_events SET status='failed'",
            "DELETE FROM public.payment_events",
        ] {
            assert!(h.db.batch_execute(sql).await.is_err(), "{role}: {sql}");
        }
        assert!(h
            .db
            .batch_execute("SELECT * FROM public.payment_events")
            .await
            .is_err());
        h.db.batch_execute("RESET ROLE").await.unwrap();
    }
    let database =
        cadence_proof::database::Database::new(&h.receipts_url, "cadence_indexer").unwrap();
    let indexer_connection = database.connect().await.unwrap();
    for sql in [
        "UPDATE public.payments SET transaction='tampered'",
        "SELECT * FROM vault.secrets",
        "SELECT * FROM vault.decrypted_secrets",
        "INSERT INTO public.payment_events DEFAULT VALUES",
        "DELETE FROM public.payment_events",
        "UPDATE public.payment_events SET status='failed'",
    ] {
        assert!(indexer_connection.batch_execute(sql).await.is_err());
    }
    assert_eq!(
        indexer_connection
            .query_one("SELECT count(*) FROM public.payment_events", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        events_before_permission_checks
    );
    let allowed = [
        "run_id",
        "position",
        "destination",
        "attempt",
        "request_id",
        "transaction",
        "last_valid_block_height",
        "status",
        "signature",
        "slot",
        "error",
        "payment_id",
        "paid_at",
        "submitted_signature",
        "id",
        "user_id",
        "company_wallet",
        "sender",
        "created_at",
        "wallet",
        "source",
        "kind",
        "scan_head",
        "scan_before",
    ];
    for row in h.db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('runs','payments','payment_attempts','wrap_requests','transfer_requests','unwrap_requests','payment_events','indexer_cursors')",&[]).await.unwrap() {
        assert!(allowed.contains(&row.get::<_,&str>(0)));
    }
    let events =
        h.db.query(
            "SELECT row_to_json(e)::text FROM public.payment_events e",
            &[],
        )
        .await
        .unwrap();
    assert!(events
        .iter()
        .all(|r| !r.get::<_, String>(0).contains("amount-and-secret")));
}
