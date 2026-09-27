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

        let response = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("{method} request to {} failed", self.url))?;

        // Before touching the body. A gateway rejecting the request for rate
        // does not have to answer in JSON, and usually doesn't — decode first
        // and the retry never sees it, it just sees malformed JSON.
        let status = response.status();
        if status.as_u16() == 429 || status.is_server_error() {
            let detail = response.text().await.unwrap_or_default();
            return Err(Transient(format!(
                "{method} on {} returned HTTP {status} {}",
                self.url,
                detail.chars().take(200).collect::<String>()
            ))
            .into());
        }

        let response: Value = response
            .json()
            .await
            .with_context(|| format!("{method} response from {} was not JSON", self.url))?;

        if let Some(error) = response.get("error").filter(|e| !e.is_null()) {
            let message = error["message"].as_str().unwrap_or_default();
            if is_rate_limit_message(message) {
                return Err(Transient(format!("{method} on {} returned {error}", self.url)).into());
            }
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

    /// Fetches a transaction with the parsed encoding. This is the call that
    /// fails outright on a client that has not declared v1 support.
    pub async fn get_transaction(&self, signature: &str) -> Result<Value> {
        self.fetch_transaction(signature, "jsonParsed").await
    }

    /// Fetches the same transaction unparsed, so the instruction data can be
    /// read as bytes instead of as whatever the RPC chose to render.
    pub async fn get_transaction_raw(&self, signature: &str) -> Result<Value> {
        self.fetch_transaction(signature, "json").await
    }

    /// Fetches a transaction, waiting out the two things a free third-party
    /// endpoint reliably does: lag a slot or two behind the sending node, and
    /// rate-limit a second request that follows too closely on the first.
    async fn fetch_transaction(&self, signature: &str, encoding: &str) -> Result<Value> {
        let mut last_error = None;

        for attempt in 0..RPC_FETCH_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }

            match self.fetch_transaction_once(signature, encoding).await {
                Ok(Some(transaction)) => return Ok(transaction),
                Ok(None) => last_error = Some(anyhow!("{} has not seen {signature}", self.url)),
                Err(e) if is_transient(&e) => last_error = Some(e),
                Err(e) => return Err(e),
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow!("{} never returned {signature}", self.url)))
    }

    /// `Ok(None)` means the RPC answered and has not seen it yet.
    async fn fetch_transaction_once(
        &self,
        signature: &str,
        encoding: &str,
    ) -> Result<Option<Value>> {
        let result = self
            .call(
                "getTransaction",
                json!([
                    signature,
                    {
                        "encoding": encoding,
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

/// An error worth waiting out rather than giving up on.
///
/// A marker type rather than a phrase to grep the message for, because the
/// message is whatever the endpoint felt like sending and the retry should not
/// depend on guessing at it.
#[derive(Debug)]
pub struct Transient(pub String);

impl std::fmt::Display for Transient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for Transient {}

fn is_transient(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<Transient>())
}

/// A JSON-RPC error that is really a rate limit wearing an error code. The
/// codes differ per provider, so the wording is all there is to go on here.
fn is_rate_limit_message(message: &str) -> bool {
    let message = message.to_lowercase();
    message.contains("too many requests")
        || message.contains("rate limit")
        || message.contains("429")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transient_error_is_retried_through_any_wrapping() {
        let error = anyhow!(Transient("HTTP 429".into())).context("fetching a transaction");
        assert!(is_transient(&error));
    }

    #[test]
    fn an_ordinary_error_is_not_retried() {
        assert!(!is_transient(&anyhow!("transaction not found")));
        // The old check keyed off wording, so this used to retry forever.
        assert!(!is_transient(&anyhow!(
            "response was not JSON: rate limit in the body text"
        )));
    }

    #[test]
    fn rate_limit_wording_is_recognised_whatever_the_code() {
        assert!(is_rate_limit_message(
            "Too Many Requests, Please apply an OnFinality API key"
        ));
        assert!(is_rate_limit_message("You have hit your rate limit"));
        assert!(!is_rate_limit_message("Transaction simulation failed"));
    }
}
