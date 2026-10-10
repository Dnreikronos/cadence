use super::support::{payment, Harness};
use cadence_proof::{
    error::AppError,
    indexer::store::{Kind, Store},
};
use serde_json::json;
use std::sync::atomic::Ordering;

pub async fn verify(h: &Harness) {
    let store = Store::new(&h.receipts_url).unwrap();
    // Skipped slots make a slot comparison unsafe. A pruned older block is
    // irrelevant only when a retained header proves it predates preparation.
    h.db.execute("DELETE FROM public.indexer_cursors", &[])
        .await
        .unwrap();
    let (mut p, signature, mut receipt) = payment(&h.wallet, Kind::Transfer, 60, false, false);
    p.last_valid_block_height = 1_000;
    receipt["slot"] = json!(100_010);
    h.insert(&p, 60).await;
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(signature.clone(), receipt);
    *h.backend.history.lock().unwrap() = vec![
        signature.clone(),
        "pruned-old-entry".into(),
        "even-older-entry".into(),
    ];
    h.backend.slots.lock().unwrap().extend([
        (signature.clone(), 100_010),
        ("pruned-old-entry".into(), 100_000),
    ]);
    h.backend.blocks.lock().unwrap().extend([
        (100_010, json!({"blockHeight":900})),
        (
            100_000,
            json!({"error":{"code":-32001,"message":"Block cleaned up"}}),
        ),
        (100_005, json!({"blockHeight":650})),
    ]);
    h.backend.first_available.store(100_005, Ordering::SeqCst);
    h.backend.calls.lock().unwrap().clear();
    h.indexer.backfill().await.unwrap();
    h.assert_status(&p, "finalized").await;
    assert!(!h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "getTransaction" && c["params"][0] == "pruned-old-entry"));
    assert_eq!(
        store.cursors().await.unwrap().get(&p.wallet),
        Some(&signature)
    );

    // The completed cursor must not advance past a failed later page, but the
    // resume starts at the failed page before the final fresh catch-up pass.
    let (mut first, first_sig, mut first_receipt) =
        payment(&h.wallet, Kind::Unwrap, 61, false, false);
    let (_, unrelated_sig, mut unrelated_receipt) =
        payment(&h.wallet, Kind::Wrap, 62, false, false);
    let (mut later, later_sig, mut later_receipt) =
        payment(&h.wallet, Kind::Transfer, 63, false, false);
    first.last_valid_block_height = 1_000;
    later.last_valid_block_height = 1_000;
    for (signature, receipt, slot) in [
        (&first_sig, &mut first_receipt, 110_003),
        (&unrelated_sig, &mut unrelated_receipt, 110_002),
        (&later_sig, &mut later_receipt, 110_001),
    ] {
        receipt["slot"] = json!(slot);
        h.backend
            .slots
            .lock()
            .unwrap()
            .insert(signature.clone(), slot);
        h.backend
            .blocks
            .lock()
            .unwrap()
            .insert(slot, json!({"blockHeight":900}));
    }
    h.insert(&first, 61).await;
    h.insert(&later, 63).await;
    h.backend.transactions.lock().unwrap().extend([
        (first_sig.clone(), first_receipt),
        (unrelated_sig.clone(), unrelated_receipt),
    ]);
    *h.backend.history.lock().unwrap() = vec![
        first_sig.clone(),
        unrelated_sig.clone(),
        later_sig.clone(),
        signature.clone(),
    ];
    assert!(matches!(
        h.indexer.backfill().await,
        Err(AppError::Conflict("transaction_history_unavailable"))
    ));
    assert_eq!(
        store.cursors().await.unwrap().get(&p.wallet),
        Some(&signature)
    );
    let checkpoint =
        h.db.query_one(
            "SELECT scan_head,scan_before FROM public.indexer_cursors WHERE wallet=$1",
            &[&p.wallet],
        )
        .await
        .unwrap();
    assert_eq!(checkpoint.get::<_, String>(0), first_sig);
    assert_eq!(checkpoint.get::<_, String>(1), unrelated_sig);
    h.assert_status(&first, "finalized").await;
    h.assert_status(&later, "prepared").await;
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(later_sig.clone(), later_receipt);
    h.backend.calls.lock().unwrap().clear();
    h.indexer.backfill().await.unwrap();
    h.assert_status(&later, "finalized").await;
    let calls = h.backend.calls.lock().unwrap().clone();
    assert!(calls
        .iter()
        .any(|c| c["method"] == "getSignaturesForAddress"
            && c["params"][1]["before"] == unrelated_sig));
    let fresh = calls
        .iter()
        .position(|c| {
            c["method"] == "getSignaturesForAddress" && c["params"][1]["before"].is_null()
        })
        .unwrap();
    assert!(!calls[..fresh]
        .iter()
        .any(|c| c["method"] == "getTransaction" && c["params"][0] == first_sig));
    let cursor =
        h.db.query_one(
            "SELECT signature,scan_head,scan_before FROM public.indexer_cursors WHERE wallet=$1",
            &[&p.wallet],
        )
        .await
        .unwrap();
    assert_eq!(cursor.get::<_, String>(0), first_sig);
    assert_eq!(cursor.get::<_, Option<String>>(1), None);
    assert_eq!(cursor.get::<_, Option<String>>(2), None);

    // Newer unrelated history outside an expired request's window needs no
    // transaction body, even if that body is unavailable.
    let (mut absent, _, _) = payment(&h.wallet, Kind::Unwrap, 64, false, false);
    absent.last_valid_block_height = 300;
    h.insert(&absent, 64).await;
    let (_, too_new_sig, mut too_new_receipt) = payment(&h.wallet, Kind::Wrap, 65, false, false);
    *h.backend.history.lock().unwrap() = vec![too_new_sig.clone(), first_sig];
    h.backend
        .slots
        .lock()
        .unwrap()
        .insert(too_new_sig.clone(), 120_000);
    h.backend
        .blocks
        .lock()
        .unwrap()
        .insert(120_000, json!({"blockHeight":900}));
    h.backend.calls.lock().unwrap().clear();
    h.indexer.backfill().await.unwrap();
    h.assert_status(&absent, "prepared").await;
    assert!(!h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "getTransaction"));
    // A preparation can commit after a previous pass read its pending set.
    // Bounded recovery must still find its transaction behind the completed cursor.
    let (mut late, late_sig, mut late_receipt) = payment(&h.wallet, Kind::Unwrap, 66, false, false);
    late.last_valid_block_height = 1_000;
    late_receipt["slot"] = json!(110_000);
    too_new_receipt["slot"] = json!(120_000);
    h.insert(&late, 66).await;
    h.backend
        .slots
        .lock()
        .unwrap()
        .insert(late_sig.clone(), 110_000);
    h.backend
        .blocks
        .lock()
        .unwrap()
        .insert(110_000, json!({"blockHeight":900}));
    h.backend.transactions.lock().unwrap().extend([
        (late_sig.clone(), late_receipt),
        (too_new_sig.clone(), too_new_receipt),
    ]);
    *h.backend.history.lock().unwrap() = vec![too_new_sig, late_sig];
    h.indexer.backfill().await.unwrap();
    h.assert_status(&late, "finalized").await;
    h.backend.history.lock().unwrap().clear();
    h.backend.blocks.lock().unwrap().clear();
    h.backend.slots.lock().unwrap().clear();
    // Leave an unresolved expired request for the scheduling regression.
    assert_eq!(
        h.db.query_one(
            "SELECT status FROM public.unwrap_requests WHERE id=$1",
            &[&absent.id]
        )
        .await
        .unwrap()
        .get::<_, String>(0),
        "prepared"
    );
    assert_eq!(h.events().await, 16);
}
