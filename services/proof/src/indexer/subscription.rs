use super::{store::Pending, Indexer};
use crate::error::AppError;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;

impl Indexer {
    pub(super) async fn watch(
        &self,
        hints: &tokio::sync::mpsc::Sender<Pending>,
    ) -> Result<(), AppError> {
        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(self.websocket.as_str()),
        )
        .await
        .map_err(|_| AppError::RpcUnavailable)?
        .map_err(|_| AppError::RpcUnavailable)?;
        let mut requests: HashMap<u64, Pending> = HashMap::new();
        let mut subscriptions: HashMap<u64, Pending> = HashMap::new();
        let mut active = HashSet::new();
        let mut id = 0_u64;
        let mut refresh = Box::pin(self.subscription_refresh(false));
        let mut last_message = tokio::time::Instant::now();
        loop {
            tokio::select! {
                pending = &mut refresh => {
                    refresh = Box::pin(self.subscription_refresh(true));
                    if last_message.elapsed() > Duration::from_secs(60) { return Err(AppError::RpcUnavailable); }
                    let pending = match pending {
                        Ok(pending) => pending,
                        Err(_) => {
                            eprintln!("chain indexer subscription refresh failed; retaining subscriptions");
                            continue;
                        }
                    };
                    let current: HashSet<_> = pending.iter().filter_map(|p| p.signature.clone()).collect();
                    let stale: Vec<_> = subscriptions.iter().filter(|(_,p)| !current.contains(p.signature.as_ref().unwrap())).map(|(s,_)| *s).collect();
                    for sub in stale {
                        let p = subscriptions.remove(&sub).unwrap();
                        active.remove(p.signature.as_ref().unwrap());
                        id += 1;
                        send(&mut socket, json!({"jsonrpc":"2.0","id":id,"method":"signatureUnsubscribe","params":[sub]})).await?;
                    }
                    for p in requests.values().filter(|p| !current.contains(p.signature.as_ref().unwrap())) {
                        active.remove(p.signature.as_ref().unwrap());
                    }
                    for p in pending.into_iter().filter(|p| p.signature.is_some()) {
                        let signature = p.signature.as_ref().unwrap();
                        if active.insert(signature.clone()) {
                            id += 1;
                            send(&mut socket, json!({"jsonrpc":"2.0","id":id,"method":"signatureSubscribe","params":[signature,{"commitment":"finalized","enableReceivedNotification":false}]})).await?;
                            requests.insert(id,p);
                        }
                    }
                    tokio::time::timeout(Duration::from_secs(5), socket.send(Message::Ping(Vec::new().into())))
                        .await.map_err(|_| AppError::RpcUnavailable)?.map_err(|_| AppError::RpcUnavailable)?;
                }
                message = socket.next() => {
                    let message = message.ok_or(AppError::RpcUnavailable)?.map_err(|_| AppError::RpcUnavailable)?;
                    last_message = tokio::time::Instant::now();
                    match message {
                        Message::Text(text) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| AppError::RpcUnavailable)?;
                            if value["jsonrpc"] != "2.0" || value.get("error").is_some_and(|e| !e.is_null()) { return Err(AppError::RpcUnavailable); }
                            if let Some(p) = value["id"].as_u64().and_then(|id| requests.remove(&id)) {
                                let sub = value["result"].as_u64().ok_or(AppError::RpcUnavailable)?;
                                if active.contains(p.signature.as_ref().unwrap()) {
                                    if subscriptions.insert(sub,p).is_some() { return Err(AppError::RpcUnavailable); }
                                } else {
                                    id += 1;
                                    send(&mut socket, json!({"jsonrpc":"2.0","id":id,"method":"signatureUnsubscribe","params":[sub]})).await?;
                                }
                            } else if value["method"] == "signatureNotification" {
                                let sub = value["params"]["subscription"].as_u64().ok_or(AppError::RpcUnavailable)?;
                                if value["params"]["result"]["value"] == "receivedSignature" { continue; }
                                if let Some(p) = subscriptions.remove(&sub) {
                                    active.remove(p.signature.as_ref().unwrap());
                                    // Notifications are hints; exact finalized transaction evidence is mandatory.
                                    // A full queue is safe: periodic recovery reads active signatures.
                                    let _ = hints.try_send(p);
                                }
                            }
                        },
                        Message::Close(_) => return Err(AppError::RpcUnavailable),
                        _ => {},
                    }
                }
            }
        }
    }

    async fn subscription_refresh(&self, wait: bool) -> Result<Vec<Pending>, AppError> {
        if wait {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        self.active_pending().await
    }
}

async fn send<S>(socket: &mut S, value: Value) -> Result<(), AppError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| AppError::RpcUnavailable)?
    .map_err(|_| AppError::RpcUnavailable)
}
