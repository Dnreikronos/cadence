use super::support::{payment, Harness};
use cadence_proof::{
    indexer::{store::Kind, Indexer},
    solana::client::RpcClient,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;

async fn advance(seconds: u64) {
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(seconds)).await;
    tokio::time::resume();
}

pub async fn verify(h: &Harness) {
    let events = h.events().await;
    let (mut live, live_sig, live_receipt) = payment(&h.wallet, Kind::Run, 80, true, false);
    let (mut boundary, boundary_sig, _) = payment(&h.wallet, Kind::Transfer, 81, true, false);
    let (mut expired, expired_sig, expired_receipt) =
        payment(&h.wallet, Kind::Unwrap, 82, true, true);
    let (mut unsigned, unsigned_sig, _) = payment(&h.wallet, Kind::Transfer, 83, false, false);
    live.last_valid_block_height = 1_000;
    boundary.last_valid_block_height = 850;
    expired.last_valid_block_height = 849;
    unsigned.last_valid_block_height = 1_000;
    for (p, position) in [
        (&live, 80),
        (&boundary, 81),
        (&expired, 82),
        (&unsigned, 83),
    ] {
        h.insert(p, position).await;
    }
    h.backend.height.store(1_000, Ordering::SeqCst);
    h.backend.history_delay.store(true, Ordering::SeqCst);
    *h.backend.history.lock().unwrap() = vec![unsigned_sig.clone()];
    h.backend
        .slots
        .lock()
        .unwrap()
        .insert(unsigned_sig, 100_010);
    h.backend
        .blocks
        .lock()
        .unwrap()
        .insert(100_010, json!({"blockHeight":900}));
    h.backend.calls.lock().unwrap().clear();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let websocket = format!("ws://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let rpc = Arc::new(RpcClient::new(h.origin.parse().unwrap(), Duration::from_secs(3)).unwrap());
    let indexer = Arc::new(Indexer::new(rpc, &h.receipts_url, websocket).unwrap());
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let (ping_tx, mut ping) = tokio::sync::oneshot::channel();
    let (pong_tx, pong) = tokio::sync::oneshot::channel();
    let (expired_tx, unsubscribed) = tokio::sync::oneshot::channel();
    let backend = h.backend.clone();
    let expected_live = live_sig.clone();
    let expected_boundary = boundary_sig.clone();
    let socket = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut subscriptions = HashMap::new();
        let mut ready = Some(ready_tx);
        let mut pong = Some(pong_tx);
        let mut expired = Some(expired_tx);
        let mut sent = false;
        loop {
            tokio::select! {
                _ = &mut ping, if !sent => {
                    sent = true;
                    socket.send(Message::Ping(b"during-discovery".to_vec().into())).await.unwrap();
                }
                message = socket.next() => {
                    match message.unwrap().unwrap() {
                        Message::Text(text) => {
                            let request: Value = serde_json::from_str(&text).unwrap();
                            if request["method"] == "signatureSubscribe" {
                                let signature = request["params"][0].as_str().unwrap();
                                assert!(signature == expected_live || signature == expected_boundary, "expired request was subscribed");
                                let sub = 100 + subscriptions.len() as u64;
                                subscriptions.insert(signature.to_owned(), sub);
                                socket.send(Message::Text(json!({"jsonrpc":"2.0","id":request["id"],"result":sub}).to_string().into())).await.unwrap();
                                if subscriptions.len() == 2 { if let Some(ready) = ready.take() { ready.send(()).unwrap(); } }
                            } else if request["method"] == "signatureUnsubscribe" {
                                assert_eq!(request["params"][0], subscriptions[&expected_boundary]);
                                socket.send(Message::Text(json!({"jsonrpc":"2.0","id":request["id"],"result":true}).to_string().into())).await.unwrap();
                                if let Some(expired) = expired.take() { expired.send(()).unwrap(); }
                            }
                        }
                        Message::Pong(bytes) if bytes.as_ref() == b"during-discovery" => {
                            assert!(backend.history_waiting.load(Ordering::SeqCst), "socket waited for history before answering");
                            pong.take().unwrap().send(()).unwrap();
                            backend.transactions.lock().unwrap().insert(expected_live.clone(), live_receipt.clone());
                            socket.send(Message::Text(json!({"jsonrpc":"2.0","method":"signatureNotification","params":{"subscription":subscriptions[&expected_live],"result":{"value":{"err":null}}}}).to_string().into())).await.unwrap();
                        }
                        Message::Ping(bytes) => { socket.send(Message::Pong(bytes)).await.unwrap(); }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }
    });
    let worker = indexer.spawn();
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !h.backend.history_waiting.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    ping_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_millis(700), pong)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while h.events().await != events + 1 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    h.assert_status(&live, "finalized").await;
    assert!(
        h.backend.history_waiting.load(Ordering::SeqCst),
        "receipt waited for the full history read"
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        while h.backend.history_waiting.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(!h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "getTransaction" && c["params"][0] == expired_sig));
    h.backend.history_delay.store(false, Ordering::SeqCst);

    // Crossing the grace boundary removes a live subscription without assigning
    // a terminal status to the unresolved transaction.
    h.backend.height.store(1_001, Ordering::SeqCst);
    advance(6).await;
    tokio::time::timeout(Duration::from_secs(3), unsubscribed)
        .await
        .unwrap()
        .unwrap();
    h.assert_status(&boundary, "prepared").await;
    h.assert_status(&expired, "prepared").await;

    let (old_unsigned, old_sig, old_receipt) = payment(&h.wallet, Kind::Unwrap, 64, false, false);
    h.backend.transactions.lock().unwrap().extend([
        (expired_sig.clone(), expired_receipt),
        (old_sig.clone(), old_receipt),
    ]);
    *h.backend.history.lock().unwrap() = vec![old_sig.clone()];
    h.backend.calls.lock().unwrap().clear();
    advance(31).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !h
            .backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c["method"] == "getSignaturesForAddress")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(!h
        .backend
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "getTransaction"
            && (c["params"][0] == expired_sig || c["params"][0] == old_sig)));
    h.assert_status(&old_unsigned, "prepared").await;

    // The five-minute pass must recover old landed transactions excluded from
    // fast polling, including a submission whose confirm request never arrived.
    advance(270).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while h.events().await != events + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    h.assert_status(&expired, "failed").await;
    h.assert_status(&old_unsigned, "finalized").await;
    h.assert_status(&unsigned, "prepared").await;
    worker.abort();
    socket.abort();
}
