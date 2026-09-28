use axum::{routing::post, Json, Router};
use cadence_proof::solana::client::RpcClient;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle};

pub struct MockRpc {
    pub client: Arc<RpcClient>,
    pub calls: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Drop for MockRpc {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockRpc {
    pub async fn start(response: Value) -> Self {
        let calls = Arc::new(Mutex::new(vec![]));
        let captured = calls.clone();
        let app = Router::new().route(
            "/",
            post(move |Json(request): Json<Value>| {
                captured.lock().unwrap().push(request);
                let response = response.clone();
                async move { Json(response) }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            client: Arc::new(RpcClient::new(url, Duration::from_secs(1)).unwrap()),
            calls,
            task,
        }
    }
}
