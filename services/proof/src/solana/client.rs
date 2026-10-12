use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_account::Account;
use solana_address::Address;
use solana_hash::Hash;
use std::{str::FromStr, time::Duration};
use tokio::time::{sleep, timeout_at, Instant};

#[path = "rpc_read.rs"]
mod rpc_read;

#[cfg(test)]
#[path = "rpc_read_tests.rs"]
mod rpc_read_tests;

#[derive(Clone)]
pub struct RpcClient {
    url: reqwest::Url,
    http: reqwest::Client,
    timeout: Duration,
}

impl RpcClient {
    pub fn new(url: reqwest::Url, timeout: Duration) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AppError::RpcUnavailable)?;
        Ok(Self { url, http, timeout })
    }

    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        self.read(method, params)
            .await
            .map_err(|_| AppError::RpcUnavailable)
    }

    async fn read(&self, method: &str, params: Value) -> Result<Value, rpc_read::Failure> {
        let deadline = Instant::now() + self.timeout;
        let attempts = if rpc_read::read_method(method) {
            rpc_read::MAX_ATTEMPTS
        } else {
            1
        };
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        for attempt in 1..=attempts {
            let failure = match timeout_at(
                deadline,
                rpc_read::request(&self.http, &self.url, &payload),
            )
            .await
            {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(failure)) => failure,
                Err(_) => rpc_read::Failure::deadline(),
            };
            let wait = failure.delay(attempt).filter(|wait| {
                attempt < attempts && *wait < deadline.saturating_duration_since(Instant::now())
            });
            eprintln!("{}", failure.diagnostic(method, attempt, wait.is_some()));
            let Some(wait) = wait else {
                return Err(failure);
            };
            if timeout_at(deadline, sleep(wait)).await.is_err() {
                eprintln!(
                    "{}",
                    rpc_read::Failure::deadline().diagnostic(method, attempt, false)
                );
                return Err(rpc_read::Failure::deadline());
            }
        }
        Err(rpc_read::Failure::deadline())
    }

    pub(crate) async fn finalized_height_at(&self, slot: u64) -> Result<Option<u64>, AppError> {
        let result = match self.read("getBlock", json!([slot, {"commitment":"finalized","transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":1}])).await {
            Ok(result) => result,
            Err(failure) if failure.unavailable_block() => return Ok(None),
            Err(_) => return Err(AppError::RpcUnavailable),
        };
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
        Self::parse_account(&result)
    }

    pub async fn finalized_account(
        &self,
        address: &Address,
        min_slot: Option<u64>,
    ) -> Result<(u64, Option<Account>), AppError> {
        let mut config = json!({"encoding":"base64","commitment":"finalized"});
        if let Some(slot) = min_slot {
            config["minContextSlot"] = json!(slot);
        }
        let result = self
            .call("getAccountInfo", json!([address.to_string(), config]))
            .await?;
        let slot = result["context"]["slot"]
            .as_u64()
            .ok_or(AppError::RpcUnavailable)?;
        if min_slot.is_some_and(|min| slot < min) {
            return Err(AppError::RpcUnavailable);
        }
        Ok((slot, Self::parse_account(&result)?))
    }

    fn parse_account(result: &Value) -> Result<Option<Account>, AppError> {
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
    async fn header_reads_retry_throttling_within_the_request_deadline() {
        for (header, failures, delay, expected_calls, success) in [
            (true, 1, 1, 2, true),
            (true, 3, 0, 3, false),
            (false, 1, 0, 2, false),
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
