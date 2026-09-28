//! Creates and inspects Cadence's wrapped USDC mint — issue #47.
//!
//! ```text
//! cargo run -- inspect       read the mint and check its confidential config
//! cargo run -- create        create the mint and its escrow, idempotently
//! cargo run -- wrap <units>  wrap devnet USDC into the payer's wrapped account
//! ```
//!
//! `inspect` needs no key. `create` and `wrap` sign with `OPS_KEYPAIR`.
//!
//! The wrap program is Cadence's deployment of upstream token-wrap
//! (ops/token-wrap), because the canonical one is not on any cluster.

mod mint;
mod rpc;
mod token_wrap;
mod v1;

use {
    anyhow::{anyhow, bail, Context, Result},
    mint::WrappedMint,
    rpc::JsonRpc,
    solana_address::Address,
    solana_instruction::Instruction,
    solana_keypair::Keypair,
    solana_message::v1::TransactionConfig,
    solana_signer::Signer,
    spl_token_2022_interface::{
        extension::{ExtensionType, StateWithExtensionsOwned},
        state::{Account, Mint},
    },
    token_wrap::{Addresses, TOKEN, TOKEN_2022},
};

/// A v1 message defaults every budget field it does not carry to zero, so both
/// are set on every transaction. See the spike report.
const BUDGET: TransactionConfig = TransactionConfig::empty()
    .with_compute_unit_limit(400_000)
    .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);

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
        ["create"] => {
            create(&rpc, &addresses, &load_payer()?).await?;
            inspect(&rpc, &addresses).await
        }
        ["wrap", amount] => {
            let amount = amount
                .parse()
                .with_context(|| format!("{amount} is not a number of base units"))?;
            wrap(&rpc, &addresses, &load_payer()?, amount).await
        }
        _ => bail!("usage: cadence-mint inspect | create | wrap <base units>"),
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

/// Pre-funds the two accounts the program allocates, creates the escrow, and
/// creates the mint, all in one transaction. Idempotent: running it against a
/// mint that already exists changes nothing.
async fn create(rpc: &JsonRpc, addresses: &Addresses, payer: &Keypair) -> Result<()> {
    if let Some((owner, data)) = rpc.account(&addresses.wrapped_mint).await? {
        if mint::is_created(&owner, &data) {
            println!("the wrapped mint already exists, nothing to create\n");
            return Ok(());
        }
    }

    // What DefaultToken2022Customizer allocates. TokenMetadata is not in it;
    // that extension is added later by its own instruction, if ever.
    let mint_space = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::MetadataPointer,
    ])?;
    let backpointer_space = 32;

    let mut instructions = vec![];
    for (address, space) in [
        (addresses.wrapped_mint, mint_space),
        (addresses.backpointer, backpointer_space),
    ] {
        let needed = rpc.minimum_balance_for_rent_exemption(space).await?;
        let held = rpc.lamports(&address).await?;
        if held < needed {
            instructions.push(solana_system_interface::instruction::transfer(
                &payer.pubkey(),
                &address,
                needed - held,
            ));
        }
    }
    instructions.push(token_wrap::create_associated_token_account_idempotent(
        &payer.pubkey(),
        &addresses.authority,
        &addresses.unwrapped_mint,
        &addresses.unwrapped_token_program,
    ));
    instructions.push(token_wrap::create_mint(addresses, true));

    let signature = send(rpc, &instructions, payer).await?;
    println!("created          {signature}\n");
    Ok(())
}

/// Wraps `amount` base units of the payer's devnet USDC into the payer's
/// wrapped account, then checks the escrow still covers the whole supply.
async fn wrap(rpc: &JsonRpc, addresses: &Addresses, payer: &Keypair, amount: u64) -> Result<()> {
    let source = token_wrap::associated_token_address(&payer.pubkey(), &addresses.unwrapped_mint, &TOKEN);
    let recipient =
        token_wrap::associated_token_address(&payer.pubkey(), &addresses.wrapped_mint, &TOKEN_2022);

    let held = token_balance(rpc, &source)
        .await?
        .ok_or_else(|| anyhow!("the payer has no devnet USDC account at {source}"))?;
    if held < amount {
        bail!("the payer holds {held} units of devnet USDC, not {amount}");
    }

    let instructions = vec![
        // An ordinary ATA is enough here. It holds the wrapped token
        // transparently; the confidential account is a different one, sized
        // for the extension, and is the spike's job.
        token_wrap::create_associated_token_account_idempotent(
            &payer.pubkey(),
            &payer.pubkey(),
            &addresses.wrapped_mint,
            &TOKEN_2022,
        ),
        token_wrap::wrap(addresses, &recipient, &source, &payer.pubkey(), amount),
    ];
    let signature = send(rpc, &instructions, payer).await?;

    let wrapped = token_balance(rpc, &recipient).await?.unwrap_or_default();
    let escrowed = token_balance(rpc, &addresses.escrow).await?.unwrap_or_default();
    let (owner, data) = rpc
        .account(&addresses.wrapped_mint)
        .await?
        .ok_or_else(|| anyhow!("the wrapped mint disappeared"))?;
    let supply = WrappedMint::read(owner, data)?.supply;

    println!("wrapped          {amount} units in {signature}");
    println!("payer holds      {wrapped} wrapped, {} USDC", held - amount);
    println!("escrow holds     {escrowed} USDC");
    println!("wrapped supply   {supply}");

    // The one invariant a wrap has: every wrapped token is backed by one
    // unwrapped token sitting in escrow.
    if escrowed != supply {
        bail!("the escrow holds {escrowed} but the wrapped supply is {supply}");
    }
    println!("\nok — the escrow covers the wrapped supply exactly");
    Ok(())
}

async fn token_balance(rpc: &JsonRpc, account: &Address) -> Result<Option<u64>> {
    let Some((_, data)) = rpc.account(account).await? else {
        return Ok(None);
    };
    let state = StateWithExtensionsOwned::<Account>::unpack(data)
        .with_context(|| format!("{account} is not a token account"))?;
    Ok(Some(state.base.amount))
}

async fn send(rpc: &JsonRpc, instructions: &[Instruction], payer: &Keypair) -> Result<String> {
    let blockhash = rpc.latest_blockhash().await?;
    let transaction = v1::compile_and_sign(instructions, payer, &[], blockhash, BUDGET)?;
    let signature = rpc.send_transaction(&v1::serialize(&transaction)?).await?;
    rpc.confirm(&signature, 60).await?;
    Ok(signature)
}

/// Reads `OPS_KEYPAIR`. Never generated or defaulted: this signs for an
/// account that holds real devnet USDC, so it has to be named on purpose.
fn load_payer() -> Result<Keypair> {
    let path = std::env::var("OPS_KEYPAIR")
        .map_err(|_| anyhow!("set OPS_KEYPAIR to the payer's keypair file"))?;
    let contents = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read the keypair at {path}"))?;
    let bytes: Vec<u8> =
        serde_json::from_str(&contents).with_context(|| format!("{path} is not a keypair file"))?;
    Keypair::try_from(bytes.as_slice()).map_err(|e| anyhow!("{path} is not a valid keypair: {e}"))
}

fn display<T: std::fmt::Display>(value: Option<T>) -> String {
    value.map_or_else(|| "None".into(), |v| v.to_string())
}
