use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_account::Account;
use solana_address::Address;
use solana_hash::Hash;
use std::{str::FromStr, time::Duration};

#[derive(Clone)]
pub struct RpcClient {
    url: reqwest::Url,
    http: reqwest::Client,
}

impl RpcClient {
    pub fn new(url: reqwest::Url, timeout: Duration) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AppError::RpcUnavailable)?;
        Ok(Self { url, http })
    }

    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let envelope = self.envelope(method, params, 0).await?;
        if envelope.get("error").is_some_and(|error| !error.is_null()) {
            return Err(AppError::RpcUnavailable);
        }
        envelope
            .get("result")
            .cloned()
            .ok_or(AppError::RpcUnavailable)
    }

    async fn envelope(&self, method: &str, params: Value, retries: u32) -> Result<Value, AppError> {
        for attempt in 0..=retries {
            // Provider errors can echo credentials from the URL. Keep them out of errors.
            let response = self
                .http
                .post(self.url.clone())
                .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
                .send()
                .await
                .map_err(|_| AppError::RpcUnavailable)?;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < retries {
                let seconds = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(5 << attempt);
                if seconds > 60 {
                    return Err(AppError::RpcUnavailable);
                }
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                continue;
            }
            let envelope: Value = response
                .error_for_status()
                .map_err(|_| AppError::RpcUnavailable)?
                .json()
                .await
                .map_err(|_| AppError::RpcUnavailable)?;
            if envelope["jsonrpc"] != "2.0" || envelope["id"] != 1 {
                return Err(AppError::RpcUnavailable);
            }
            if envelope["error"]["code"] == 429 && attempt < retries {
                tokio::time::sleep(Duration::from_secs(5 << attempt)).await;
                continue;
            }
            return Ok(envelope);
        }
        Err(AppError::RpcUnavailable)
    }

    pub(crate) async fn finalized_height_at(&self, slot: u64) -> Result<Option<u64>, AppError> {
        let envelope = self.envelope("getBlock", json!([slot, {"commitment":"finalized","transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":1}]), 2).await?;
        if matches!(
            envelope["error"]["code"].as_i64(),
            Some(-32001 | -32007 | -32009)
        ) {
            return Ok(None);
        }
        if envelope.get("error").is_some_and(|e| !e.is_null()) {
            return Err(AppError::RpcUnavailable);
        }
        let result = envelope.get("result").ok_or(AppError::RpcUnavailable)?;
        if result.is_null() {
            return Ok(None);
        }
        result["blockHeight"]
            .as_u64()
            .filter(|height| *height <= slot)
            .map(Some)
            .ok_or(AppError::RpcUnavailable)
    }

    pub async fn health(&self) -> Result<(), AppError> {
        match self.call("getHealth", json!([])).await? {
            Value::String(status) if status == "ok" => Ok(()),
            _ => Err(AppError::RpcUnavailable),
        }
    }

    pub async fn transaction(&self, signature: &str) -> Result<Value, AppError> {
        self.call("getTransaction", json!([signature, Self::read_config()]))
            .await
    }

    pub async fn require_devnet(&self) -> Result<(), AppError> {
        if self.call("getGenesisHash", json!([])).await?
            != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
        {
            return Err(AppError::Conflict("wrap_requires_devnet"));
        }
        Ok(())
    }

    pub async fn finalized_block_height(&self) -> Result<u64, AppError> {
        self.call("getBlockHeight", json!([{"commitment": "finalized"}]))
            .await?
            .as_u64()
            .ok_or(AppError::RpcUnavailable)
    }

    pub async fn finalized_transaction(&self, signature: &str) -> Result<Value, AppError> {
        self.call(
            "getTransaction",
            json!([signature, {
                "encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1
            }]),
        )
        .await
    }

    pub async fn blockhash_with_expiry(&self) -> Result<(Hash, u64), AppError> {
        let result = self
            .call("getLatestBlockhash", json!([{ "commitment": "confirmed" }]))
            .await?;
        let hash = result["value"]["blockhash"]
            .as_str()
            .and_then(|hash| Hash::from_str(hash).ok())
            .ok_or(AppError::RpcUnavailable)?;
        let height = result["value"]["lastValidBlockHeight"]
            .as_u64()
            .ok_or(AppError::RpcUnavailable)?;
        Ok((hash, height))
    }

    pub async fn block(&self, slot: u64) -> Result<Value, AppError> {
        self.call("getBlock", json!([slot, Self::read_config()]))
            .await
    }

    fn read_config() -> Value {
        json!({ "encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 1 })
    }

    pub async fn latest_blockhash(&self) -> Result<Hash, AppError> {
        let result = self
            .call("getLatestBlockhash", json!([{ "commitment": "confirmed" }]))
            .await?;
        result["value"]["blockhash"]
            .as_str()
            .and_then(|hash| Hash::from_str(hash).ok())
            .ok_or(AppError::RpcUnavailable)
    }

    pub async fn minimum_balance(&self, space: usize) -> Result<u64, AppError> {
        self.call("getMinimumBalanceForRentExemption", json!([space]))
            .await?
            .as_u64()
            .ok_or(AppError::RpcUnavailable)
    }

    pub async fn account(&self, address: &Address) -> Result<Option<Account>, AppError> {
        let result = self
            .call(
                "getAccountInfo",
                json!([
                    address.to_string(), { "encoding": "base64", "commitment": "confirmed" }
                ]),
            )
            .await?;
        let value = result.get("value").ok_or(AppError::RpcUnavailable)?;
        if value.is_null() {
            return Ok(None);
        }
        let owner = value["owner"]
            .as_str()
            .and_then(|owner| Address::from_str(owner).ok())
            .ok_or(AppError::RpcUnavailable)?;
        if value["data"][1] != "base64" {
            return Err(AppError::RpcUnavailable);
        }
        let data = STANDARD
            .decode(value["data"][0].as_str().ok_or(AppError::RpcUnavailable)?)
            .map_err(|_| AppError::RpcUnavailable)?;
        Ok(Some(Account {
            lamports: value["lamports"].as_u64().ok_or(AppError::RpcUnavailable)?,
            data,
            owner,
            executable: value["executable"]
                .as_bool()
                .ok_or(AppError::RpcUnavailable)?,
            rent_epoch: value["rentEpoch"]
                .as_u64()
                .ok_or(AppError::RpcUnavailable)?,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    async fn throttled(
        State(state): State<Arc<(AtomicUsize, usize, u64)>>,
    ) -> axum::response::Response {
        let call = state.0.fetch_add(1, Ordering::SeqCst);
        if call < state.1 {
            let mut headers = HeaderMap::new();
            headers.insert("retry-after", state.2.to_string().parse().unwrap());
            return (
                StatusCode::TOO_MANY_REQUESTS,
                headers,
                "provider credential echoed here",
            )
                .into_response();
        }
        Json(json!({"jsonrpc":"2.0","id":1,"result":{"blockHeight":900}})).into_response()
    }

    #[tokio::test]
    async fn header_reads_retry_throttling_but_other_reads_keep_their_deadline() {
        for (header, failures, delay, expected_calls, success) in [
            (true, 1, 1, 2, true),
            (true, 3, 0, 3, false),
            (false, 1, 0, 1, false),
            (true, 1, 61, 1, false),
        ] {
            let state = Arc::new((AtomicUsize::new(0), failures, delay));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap())
                .parse()
                .unwrap();
            let app = Router::new()
                .route("/", post(throttled))
                .with_state(state.clone());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let rpc = RpcClient::new(url, Duration::from_secs(3)).unwrap();
            let started = tokio::time::Instant::now();
            let result = if header {
                rpc.finalized_height_at(1_000)
                    .await
                    .map(|height| assert_eq!(height, Some(900)))
            } else {
                rpc.health().await
            };
            assert_eq!(result.is_ok(), success);
            if success {
                assert!(started.elapsed() >= Duration::from_secs(delay));
            }
            assert_eq!(state.0.load(Ordering::SeqCst), expected_calls);
            if let Err(error) = result {
                assert!(!error.to_string().contains("credential"));
            }
            server.abort();
        }
    }
}
