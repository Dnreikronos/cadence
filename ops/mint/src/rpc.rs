//! Minimal JSON-RPC client, cut down from the spike's.
//!
//! `solana-rpc-client` is not in this tree — see the note in Cargo.toml — so
//! every call goes out as plain HTTP from here.
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
    fn rate_limit_wording_is_recognised_whatever_the_code() {
        assert!(is_rate_limit_message(
            "Too Many Requests, Please apply an OnFinality API key"
        ));
        assert!(is_rate_limit_message("You have hit your rate limit"));
        assert!(!is_rate_limit_message("Transaction simulation failed"));
    }
}
