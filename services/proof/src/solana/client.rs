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

    async fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        // Provider errors can echo credentials from the URL. Keep them out of errors.
        let response = self
            .http
            .post(self.url.clone())
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .map_err(|_| AppError::RpcUnavailable)?
            .error_for_status()
            .map_err(|_| AppError::RpcUnavailable)?;
        let envelope: Value = response
            .json()
            .await
            .map_err(|_| AppError::RpcUnavailable)?;
        if envelope["jsonrpc"] != "2.0"
            || envelope["id"] != 1
            || envelope.get("error").is_some_and(|error| !error.is_null())
        {
            return Err(AppError::RpcUnavailable);
        }
        envelope
            .get("result")
            .cloned()
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
