//! Creates and inspects Cadence's wrapped USDC mint — issue #47.
//!
//! The wrap program is Cadence's deployment of upstream token-wrap
//! (ops/token-wrap), because the canonical one is not on any cluster.

mod mint;
mod rpc;
mod token_wrap;
mod v1;

fn main() -> anyhow::Result<()> {
    anyhow::bail!("usage: cadence-mint")
}
