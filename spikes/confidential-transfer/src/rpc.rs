//! Minimal JSON-RPC client.
//!
//! `solana-rpc-client` is not in this tree — see the note in Cargo.toml — so
//! every call the spike makes goes out as plain HTTP from here.
//!
//! Every request that can carry it sets `maxSupportedTransactionVersion: 1`
//! (ADR B7). One v1 transaction in a block breaks `getBlock` for that whole
//! block on a client that has not declared it.

use {
    anyhow::{anyhow, Context, Result},
    base64::{engine::general_purpose::STANDARD as BASE64, Engine},
    serde_json::{json, Value},
    solana_address::Address,
    solana_hash::Hash,
    std::{str::FromStr, time::Duration},
};

/// How long to keep waiting on a third-party RPC before giving up.
const RPC_FETCH_ATTEMPTS: u32 = 20;

pub struct JsonRpc {
    url: String,
    http: reqwest::Client,
}

impl JsonRpc {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            http: reqwest::Client::new(),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });

        let response: Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("{method} request to {} failed", self.url))?
            .json()
            .await
            .with_context(|| format!("{method} response from {} was not JSON", self.url))?;

        if let Some(error) = response.get("error").filter(|e| !e.is_null()) {
            return Err(anyhow!("{method} on {} returned {error}", self.url));
        }

        response
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("{method} on {} returned no result", self.url))
    }

    pub async fn latest_blockhash(&self) -> Result<Hash> {
        let result = self
            .call("getLatestBlockhash", json!([{ "commitment": "confirmed" }]))
            .await?;
        let blockhash = result["value"]["blockhash"]
            .as_str()
            .ok_or_else(|| anyhow!("getLatestBlockhash returned {result}"))?;
        Hash::from_str(blockhash).context("could not parse the blockhash")
    }

    pub async fn minimum_balance_for_rent_exemption(&self, space: usize) -> Result<u64> {
        let result = self
            .call("getMinimumBalanceForRentExemption", json!([space]))
            .await?;
        result
            .as_u64()
            .ok_or_else(|| anyhow!("getMinimumBalanceForRentExemption returned {result}"))
    }

    pub async fn balance(&self, address: &Address) -> Result<u64> {
        let result = self
            .call(
                "getBalance",
                json!([address.to_string(), { "commitment": "confirmed" }]),
            )
            .await?;
        result["value"]
            .as_u64()
            .ok_or_else(|| anyhow!("getBalance returned {result}"))
    }

    pub async fn request_airdrop(&self, address: &Address, lamports: u64) -> Result<String> {
        let result = self
            .call("requestAirdrop", json!([address.to_string(), lamports]))
            .await?;
        result
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("requestAirdrop returned {result}"))
    }

    /// Raw account data, or `None` if the account does not exist yet.
    pub async fn account_data(&self, address: &Address) -> Result<Option<Vec<u8>>> {
        let result = self
            .call(
                "getAccountInfo",
                json!([
                    address.to_string(),
                    { "encoding": "base64", "commitment": "confirmed" }
                ]),
            )
            .await?;

        let value = &result["value"];
        if value.is_null() {
            return Ok(None);
        }

        let encoded = value["data"][0]
            .as_str()
            .ok_or_else(|| anyhow!("getAccountInfo returned unexpected data for {address}"))?;
        BASE64
            .decode(encoded)
            .map(Some)
            .with_context(|| format!("account data for {address} was not base64"))
    }

    /// Submits a base64-encoded transaction. Preflight stays on: a v1
    /// transaction rejected at simulation is exactly what this spike wants to
    /// hear about.
    pub async fn send_transaction(&self, wire: &[u8]) -> Result<String> {
        let result = self
            .call(
                "sendTransaction",
                json!([
                    BASE64.encode(wire),
                    {
                        "encoding": "base64",
                        "preflightCommitment": "confirmed",
                        "maxRetries": 5,
                    }
                ]),
            )
            .await?;

        result
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("sendTransaction returned {result}"))
    }

    /// Polls `getSignatureStatuses` until the signature confirms or the budget
    /// runs out. Returns the confirmed slot.
    ///
    /// A failed poll is not a failed transaction: the public devnet endpoint
    /// rate-limits this method hard enough that a tight loop gets 429s within a
    /// few transactions. Only an `err` in the status itself is fatal.
    pub async fn confirm(&self, signature: &str, attempts: u32) -> Result<u64> {
        for _ in 0..attempts {
            tokio::time::sleep(Duration::from_millis(1_500)).await;

            let Ok(result) = self
                .call(
                    "getSignatureStatuses",
                    json!([[signature], { "searchTransactionHistory": true }]),
                )
                .await
            else {
                continue;
            };

            let status = &result["value"][0];
            if !status.is_null() {
                if let Some(err) = status.get("err").filter(|e| !e.is_null()) {
                    return Err(anyhow!("transaction {signature} failed on-chain: {err}"));
                }
                let confirmation = status["confirmationStatus"].as_str().unwrap_or_default();
                if matches!(confirmation, "confirmed" | "finalized") {
                    return Ok(status["slot"].as_u64().unwrap_or_default());
                }
            }
        }

        Err(anyhow!(
            "transaction {signature} did not confirm in time on {}",
            self.url
        ))
    }

    /// Fetches a transaction, waiting out the two things a free third-party
    /// endpoint reliably does: lag a slot or two behind the sending node, and
    /// rate-limit a second request that follows too closely on the first.
    pub async fn get_transaction(&self, signature: &str) -> Result<Value> {
        let mut last_error = None;

        for attempt in 0..RPC_FETCH_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }

            match self.get_transaction_once(signature).await {
                Ok(Some(transaction)) => return Ok(transaction),
                Ok(None) => last_error = Some(anyhow!("{} has not seen {signature}", self.url)),
                Err(e) if is_transient(&e) => last_error = Some(e),
                Err(e) => return Err(e),
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow!("{} never returned {signature}", self.url)))
    }

    /// `Ok(None)` means the RPC answered and has not seen it yet.
    async fn get_transaction_once(&self, signature: &str) -> Result<Option<Value>> {
        let result = self
            .call(
                "getTransaction",
                json!([
                    signature,
                    {
                        "encoding": "jsonParsed",
                        "commitment": "confirmed",
                        "maxSupportedTransactionVersion": 1,
                    }
                ]),
            )
            .await?;

        if result.is_null() {
            return Ok(None);
        }
        Ok(Some(result))
    }
}

/// Whether an error is worth waiting out rather than giving up on.
fn is_transient(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("too many requests") || text.contains("rate limit") || text.contains("429")
}
