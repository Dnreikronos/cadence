use axum::{
    body::Body,
    extract::State,
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use cadence_proof::solana::client::RpcClient;
use serde_json::{json, Value};
use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};

pub struct Reply {
    status: StatusCode,
    body: String,
    delay: Duration,
    body_delay: Duration,
    retry_after: Option<&'static str>,
}
impl Reply {
    pub fn raw(body: &str) -> Self {
        Self {
            status: StatusCode::OK,
            body: body.into(),
            delay: Duration::ZERO,
            body_delay: Duration::ZERO,
            retry_after: None,
        }
    }
    pub fn json(body: Value) -> Self {
        Self::raw(&body.to_string())
    }
    pub fn result(body: Value) -> Self {
        Self::json(json!({"jsonrpc":"2.0","id":1,"result":body}))
    }
    pub fn error(code: i64) -> Self {
        Self::json(
            json!({"jsonrpc":"2.0","id":1,"error":{"code":code,"message":"private-provider-token","data":{"amount":"secret-amount"}}}),
        )
    }
    pub fn http(status: StatusCode) -> Self {
        Self {
            status,
            ..Self::raw("private-provider-token")
        }
    }
    pub fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
    pub fn body_delay(mut self, delay: Duration) -> Self {
        self.body_delay = delay;
        self
    }
    pub fn retry_after(mut self, delay: &'static str) -> Self {
        self.retry_after = Some(delay);
        self
    }
}
pub struct StateData {
    replies: Mutex<VecDeque<Reply>>,
    pub calls: Mutex<Vec<Value>>,
    pub arrived: Notify,
}
pub struct Rpc {
    pub client: RpcClient,
    pub state: Arc<StateData>,
    task: JoinHandle<()>,
}
impl Drop for Rpc {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn respond(State(state): State<Arc<StateData>>, Json(request): Json<Value>) -> Response {
    state.calls.lock().await.push(request);
    state.arrived.notify_one();
    let reply = state
        .replies
        .lock()
        .await
        .pop_front()
        .expect("unexpected extra RPC attempt");
    tokio::time::sleep(reply.delay).await;
    let mut response = Response::builder()
        .status(reply.status)
        .header(CONTENT_TYPE, "application/json");
    if let Some(wait) = reply.retry_after {
        response = response.header("retry-after", HeaderValue::from_static(wait));
    }
    response
        .body(Body::from_stream(futures_util::stream::once(async move {
            tokio::time::sleep(reply.body_delay).await;
            Ok::<_, Infallible>(reply.body)
        })))
        .unwrap()
}
impl Rpc {
    pub async fn start(replies: Vec<Reply>) -> Self {
        Self::with_timeout(replies, Duration::from_secs(2)).await
    }
    pub async fn with_timeout(replies: Vec<Reply>, timeout: Duration) -> Self {
        let state = Arc::new(StateData {
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(vec![]),
            arrived: Notify::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}?api-key=private-provider-token",
            listener.local_addr().unwrap()
        );
        let app = Router::new()
            .route("/", post(respond))
            .with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            client: RpcClient::new(url.parse().unwrap(), timeout).unwrap(),
            state,
            task,
        }
    }
}
