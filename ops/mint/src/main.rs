//! Creates and inspects Cadence's wrapped USDC mint — issue #47.
//!
//! ```text
//! cargo run -- inspect       read the mint and check its confidential config
//! ```
//!
//! The wrap program is Cadence's deployment of upstream token-wrap
//! (ops/token-wrap), because the canonical one is not on any cluster.

mod mint;
mod rpc;
mod token_wrap;
mod v1;

use {
    anyhow::{anyhow, bail, Result},
    mint::WrappedMint,
    rpc::JsonRpc,
    token_wrap::Addresses,
};

#[tokio::main]
async fn main() -> Result<()> {
    let rpc = JsonRpc::new(
        std::env::var("OPS_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
    );
    let addresses = Addresses::for_usdc();
    println!("rpc              {}", rpc.url());

    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["inspect"] => inspect(&rpc, &addresses).await,
        _ => bail!("usage: cadence-mint inspect"),
    }
}

/// Prints the wrapped mint and fails unless it is exactly what stock
/// token-wrap produces.
async fn inspect(rpc: &JsonRpc, addresses: &Addresses) -> Result<()> {
    println!("wrap program     {}", addresses.program);
    println!("unwrapped mint   {}", addresses.unwrapped_mint);
    println!("wrapped mint     {}", addresses.wrapped_mint);
    println!("mint authority   {}", addresses.authority);
    println!("backpointer      {}", addresses.backpointer);
    println!("escrow           {}", addresses.escrow);

    let (owner, data) = rpc
        .account(&addresses.wrapped_mint)
        .await?
        .ok_or_else(|| anyhow!("the wrapped mint does not exist yet — run `create`"))?;
    let mint = WrappedMint::read(owner, data)?;

    println!("\ndecimals         {}", mint.decimals);
    println!("supply           {}", mint.supply);
    println!("freeze authority {}", display(mint.freeze_authority));
    println!("extensions       {:?}", mint.extensions);

    if let Some(config) = &mint.confidential {
        println!("\nConfidentialTransferMint");
        println!("  authority                {}", display(config.authority));
        println!("  auto_approve_new_accounts {}", config.auto_approve_new_accounts);
        println!(
            "  auditor_elgamal_pubkey   {}",
            display(config.auditor_elgamal_pubkey)
        );
    }

    let mut problems = mint.problems(&addresses.authority);
    problems.extend(check_backpointer(rpc, addresses).await?);

    if !problems.is_empty() {
        bail!("the wrapped mint is not what the design assumes:\n  {}", problems.join("\n  "));
    }
    println!("\nok — no auditor, no authority, auto-approve on, and the backpointer names USDC");
    Ok(())
}

/// The backpointer is how anyone holding the wrapped token finds out what it
/// wraps. It has to be the wrap program's, and it has to name USDC.
async fn check_backpointer(rpc: &JsonRpc, addresses: &Addresses) -> Result<Vec<String>> {
    let Some((owner, data)) = rpc.account(&addresses.backpointer).await? else {
        return Ok(vec!["the backpointer does not exist".into()]);
    };

    let mut problems = vec![];
    if owner != addresses.program {
        problems.push(format!("the backpointer is owned by {owner}, not the wrap program"));
    }
    if data.as_slice() != addresses.unwrapped_mint.as_ref() {
        problems.push("the backpointer does not name devnet USDC".into());
    }
    Ok(problems)
}

fn display<T: std::fmt::Display>(value: Option<T>) -> String {
    value.map_or_else(|| "None".into(), |v| v.to_string())
}
