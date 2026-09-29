use crate::error::AppError;
use std::{net::SocketAddr, time::Duration};

pub struct Config {
    pub rpc_url: reqwest::Url,
    pub build_sha: String,
    pub bind_addr: SocketAddr,
    pub rpc_timeout: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        Self::parse(|name| std::env::var(name).ok())
    }

    // Passing the environment reader keeps tests isolated from process-global state.
    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Self, AppError> {
        let rpc_url = get("PROOF_RPC_URL")
            .ok_or(AppError::Config("PROOF_RPC_URL is required"))?
            .parse::<reqwest::Url>()
            .map_err(|_| AppError::Config("PROOF_RPC_URL must be an HTTP(S) URL"))?;
        if !matches!(rpc_url.scheme(), "http" | "https") || rpc_url.host_str().is_none() {
            return Err(AppError::Config("PROOF_RPC_URL must be an HTTP(S) URL"));
        }
        let build_sha = get("BUILD_SHA").ok_or(AppError::Config("BUILD_SHA is required"))?;
        if build_sha.len() != 40 || !build_sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::Config(
                "BUILD_SHA must be a full 40-character Git SHA",
            ));
        }
        let bind_addr = get("PROOF_BIND_ADDR")
            .unwrap_or_else(|| "0.0.0.0:3000".into())
            .parse()
            .map_err(|_| AppError::Config("PROOF_BIND_ADDR must be an IP:port socket address"))?;
        let timeout_ms = get("PROOF_RPC_TIMEOUT_MS")
            .unwrap_or_else(|| "5000".into())
            .parse::<u64>()
            .map_err(|_| AppError::Config("PROOF_RPC_TIMEOUT_MS must be in 1..=60000"))?;
        if !(1..=60_000).contains(&timeout_ms) {
            return Err(AppError::Config(
                "PROOF_RPC_TIMEOUT_MS must be in 1..=60000",
            ));
        }
        Ok(Self {
            rpc_url,
            build_sha,
            bind_addr,
            rpc_timeout: Duration::from_millis(timeout_ms),
        })
    }
}
