use reqwest::{header::RETRY_AFTER, StatusCode};
use serde_json::Value;
use std::time::Duration;

pub(super) const MAX_ATTEMPTS: u32 = 3;
const BACKOFF: Duration = Duration::from_millis(250);

pub(super) fn read_method(method: &str) -> bool {
    matches!(
        method,
        "getHealth"
            | "getGenesisHash"
            | "getTransaction"
            | "getBlock"
            | "getBlockHeight"
            | "getLatestBlockhash"
            | "getAccountInfo"
            | "getMultipleAccounts"
            | "getMinimumBalanceForRentExemption"
            | "getSignaturesForAddress"
    )
}

pub(super) struct Failure {
    kind: &'static str,
    http_status: Option<u16>,
    rpc_code: Option<i64>,
    wait: Option<Duration>,
}
impl Failure {
    pub(super) fn deadline() -> Self {
        Self {
            kind: "deadline",
            http_status: None,
            rpc_code: None,
            wait: None,
        }
    }
    fn transport(error: reqwest::Error) -> Self {
        let retryable =
            error.is_connect() || error.is_timeout() || error.is_request() || error.is_body();
        Self {
            kind: if error.is_timeout() {
                "timeout"
            } else {
                "transport"
            },
            http_status: None,
            rpc_code: None,
            wait: retryable.then_some(Duration::ZERO),
        }
    }
    fn invalid(kind: &'static str, status: StatusCode) -> Self {
        Self {
            kind,
            http_status: Some(status.as_u16()),
            rpc_code: None,
            wait: None,
        }
    }
    fn rpc(code: i64, status: StatusCode) -> Self {
        Self {
            kind: "rpc",
            http_status: Some(status.as_u16()),
            rpc_code: matches!(code, -32700 | -32603..=-32600 | -32099..=-32000).then_some(code),
            wait: matches!(code, -32005 | -32016).then_some(Duration::ZERO),
        }
    }
    pub(super) fn unavailable_block(&self) -> bool {
        matches!(self.rpc_code, Some(-32001 | -32007 | -32009))
    }
    pub(super) fn delay(&self, attempt: u32) -> Option<Duration> {
        self.wait.map(|wait| wait.max(BACKOFF * attempt))
    }
    pub(super) fn diagnostic(&self, method: &str, attempt: u32, retrying: bool) -> String {
        let method = if read_method(method) {
            method
        } else {
            "unsupported"
        };
        let status = self
            .http_status
            .map_or_else(|| "none".into(), |n| n.to_string());
        let code = self
            .rpc_code
            .map_or_else(|| "none".into(), |n| n.to_string());
        format!("rpc_read_failed method={method} attempt={attempt} kind={} http_status={status} rpc_code={code} retrying={retrying}", self.kind)
    }
}

pub(super) async fn request(
    http: &reqwest::Client,
    url: &reqwest::Url,
    payload: &Value,
) -> Result<Value, Failure> {
    let response = http
        .post(url.clone())
        .json(payload)
        .send()
        .await
        .map_err(Failure::transport)?;
    let status = response.status();
    if !status.is_success() {
        let wait = if matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504) {
            match response.headers().get(RETRY_AFTER) {
                None => Some(Duration::ZERO),
                Some(value) => value
                    .to_str()
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .map(Duration::from_secs),
            }
        } else {
            None
        };
        return Err(Failure {
            kind: "http",
            http_status: Some(status.as_u16()),
            rpc_code: None,
            wait,
        });
    }
    let envelope: Value = response.json().await.map_err(|error| {
        if error.is_body() || error.is_timeout() {
            Failure::transport(error)
        } else {
            Failure::invalid("invalid_json", status)
        }
    })?;
    if envelope["jsonrpc"] != "2.0" || envelope["id"] != 1 {
        return Err(Failure::invalid("invalid_envelope", status));
    }
    if let Some(error) = envelope.get("error").filter(|error| !error.is_null()) {
        if envelope.get("result").is_some() || !error["message"].is_string() {
            return Err(Failure::invalid("invalid_envelope", status));
        }
        return Err(error["code"]
            .as_i64()
            .map(|code| Failure::rpc(code, status))
            .unwrap_or_else(|| Failure::invalid("invalid_envelope", status)));
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| Failure::invalid("invalid_envelope", status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_methods_and_provider_strings_never_enter_retry_diagnostics() {
        assert!(!read_method("sendTransaction"));
        assert!(!read_method("requestAirdrop"));
        let unknown =
            Failure::rpc(42_000_000, StatusCode::OK).diagnostic("private-provider-token", 1, false);
        assert!(!unknown.contains("private-provider-token"));
        assert!(!unknown.contains("42000000"));
        assert!(unknown.contains("method=unsupported"));
        assert!(unknown.contains("rpc_code=none"));
    }
}
