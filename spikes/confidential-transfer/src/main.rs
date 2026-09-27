//! Devnet confidential transfer spike — issue #46.
//!
//! Proves the one unproven assumption in the Cadence design: that a Token-2022
//! confidential transfer fits in a single transaction, and that the amount
//! comes back from an unrelated RPC as ciphertext.
//!
//! Creates a throwaway Token-2022 mint with the confidential transfer
//! extension, configures a sender and a recipient, deposits and applies a
//! balance, then sends one confidential transfer as a v1 transaction and reads
//! it back through a second RPC provider.
//!
//! Everything it creates is disposable. Run it against devnet or a
//! mainnet-forking validator (ADR B4); a stock `solana-test-validator` does not
//! enable the ZK ElGamal Proof program and every proof instruction will fail.

mod balances;
mod rpc;
mod v1;

use {
    anyhow::{anyhow, bail, Context, Result},
    balances::Balances,
    rpc::JsonRpc,
    serde_json::Value,
    solana_address::Address,
    solana_instruction::Instruction,
    solana_keypair::Keypair,
    solana_message::v1::TransactionConfig,
    solana_signer::Signer,
    solana_zk_sdk::{
        encryption::{
            auth_encryption::AeKey, derivation::derive_confidential_keys, elgamal::ElGamalKeypair,
        },
        zk_elgamal_proof_program::build_pubkey_validity_proof_data,
    },
    spl_token_2022_interface::{
        extension::{
            confidential_transfer::{self, ConfidentialTransferAccount},
            BaseStateWithExtensions, ExtensionType, StateWithExtensionsOwned,
        },
        instruction as token_instruction,
        state::{Account, Mint},
    },
    spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation,
    spl_token_confidential_transfer_proof_generation::transfer::TransferProofData,
    std::num::NonZeroI8,
};

/// Token-2022, the program carrying the confidential instructions since the
/// 2026-06-17 redeploy.
const TOKEN_2022: Address = spl_token_2022_interface::ID;

/// USDC's decimals, so the numbers below read like the real thing.
const DECIMALS: u8 = 6;

/// Minted to the sender, then deposited whole into the confidential balance.
const FUNDING_AMOUNT: u64 = 25_000_000;

/// The amount that has to come back as ciphertext. 4.2 tokens.
const TRANSFER_AMOUNT: u64 = 4_200_000;

/// Deposits and transfers each credit the pending balance once, and the
/// recipient has to apply before the counter fills. Payroll runs nowhere near
/// this.
const MAX_PENDING_BALANCE_CREDITS: u64 = 65_536;

/// A v1 message defaults every budget field it does not carry to **zero**,
/// where a legacy transaction would have got 200k CU per instruction and a
/// 64 MiB account data allowance. Both have to be set explicitly on every
/// transaction or it fails at simulation — the account data one with
/// `MaxLoadedAccountsDataSizeExceeded`, which reads like a size problem and is
/// not.
///
/// The compute ceiling is the per-transaction maximum; range proof
/// verification alone runs 111k–368k CU. The data allowance is the maximum too,
/// because the Token-2022 program account is itself most of what gets loaded.
const BUDGET: TransactionConfig = TransactionConfig::empty()
    .with_compute_unit_limit(1_400_000)
    .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);

/// SIMD-0296, live at mainnet epoch 1035 on 2026-09-15. The number this spike
/// is measured against.
const MAX_TRANSACTION_SIZE: usize = 4_096;

/// Enough for the mint, two token accounts and five transactions, with room to
/// spare.
const MINIMUM_PAYER_LAMPORTS: u64 = 200_000_000;

#[tokio::main]
async fn main() -> Result<()> {
    let rpc_url =
        std::env::var("SPIKE_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".into());
    // Deliberately a different provider: R2 is only demonstrated if the
    // ciphertext comes back from an RPC that had no part in sending it.
    let verify_rpc_url = std::env::var("SPIKE_VERIFY_RPC_URL")
        .unwrap_or_else(|_| "https://solana-devnet.api.onfinality.io/public".into());

    let rpc = JsonRpc::new(rpc_url);
    let verify_rpc = JsonRpc::new(verify_rpc_url);

    let payer = load_payer()?;
    println!("payer            {}", payer.pubkey());
    println!("rpc              {}", rpc.url());
    println!("verification rpc {}\n", verify_rpc.url());

    ensure_funded(&rpc, &payer.pubkey()).await?;

    // --- step 1: a mint with the confidential extension ------------------
    let mint = create_mint(&rpc, &payer).await?;

    // --- step 2: two token accounts configured for confidential transfers -
    let recipient_owner = Keypair::new();
    let sender = configure_account(&rpc, &payer, &mint, &payer, "sender").await?;
    let recipient = configure_account(&rpc, &payer, &mint, &recipient_owner, "recipient").await?;

    // --- step 3: deposit, then apply --------------------------------------
    fund_confidential_balance(&rpc, &payer, &mint, &sender).await?;

    // --- step 4: one confidential transfer, one v1 transaction ------------
    let signature = send_confidential_transfer(&rpc, &payer, &mint, &sender, &recipient).await?;

    // --- step 5: read it back from somewhere else -------------------------
    verify_through_third_party(&verify_rpc, &signature).await?;

    println!("\nrecipient's balance, which only they and we can read:");
    let recipient_balances = read_balances(&rpc, &recipient.account).await?;
    println!(
        "  pending          {} units",
        recipient_balances.pending(recipient.elgamal_keypair.secret())?
    );

    Ok(())
}

/// A token account configured for confidential transfers, with the keys that
/// go with it.
struct ConfidentialAccount {
    account: Address,
    owner: Address,
    elgamal_keypair: ElGamalKeypair,
    aes_key: AeKey,
}

/// Creates the mint with `ConfidentialTransferMint` attached.
///
/// The extension has to exist at mint creation — there is no migration path,
/// which is the whole reason Cadence wraps USDC rather than using it directly.
async fn create_mint(rpc: &JsonRpc, payer: &Keypair) -> Result<Address> {
    let mint = Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::ConfidentialTransferMint,
    ])?;
    let lamports = rpc.minimum_balance_for_rent_exemption(space).await?;

    let instructions = vec![
        solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            lamports,
            space as u64,
            &TOKEN_2022,
        ),
        confidential_transfer::instruction::initialize_mint(
            &TOKEN_2022,
            &mint.pubkey(),
            Some(payer.pubkey()),
            // Auto-approve, so no ApproveAccount round trip per recipient.
            true,
            // Stock `token-wrap` leaves the auditor None, immutably. ADR O1 is
            // the decision about changing that; the spike does not prejudge it.
            None,
        )?,
        // The extension instruction has to land before InitializeMint, which
        // is what freezes the extension set.
        token_instruction::initialize_mint2(
            &TOKEN_2022,
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            DECIMALS,
        )?,
    ];

    send(rpc, &instructions, payer, &[payer, &mint], "create mint").await?;
    println!("mint             {}", mint.pubkey());
    Ok(mint.pubkey())
}

/// Creates a token account with room for the confidential extension and
/// configures it in the same transaction.
///
/// Auxiliary rather than associated: an ATA is sized from the mint's extensions
/// alone and has no space for `ConfidentialTransferAccount`, so it would need a
/// reallocate step first. The product will have to deal with that; the spike
/// does not need to.
async fn configure_account(
    rpc: &JsonRpc,
    payer: &Keypair,
    mint: &Address,
    owner: &Keypair,
    label: &str,
) -> Result<ConfidentialAccount> {
    let account = Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<Account>(&[
        ExtensionType::ConfidentialTransferAccount,
    ])?;
    let lamports = rpc.minimum_balance_for_rent_exemption(space).await?;

    // Derived from a wallet signature over the account address, so the owner
    // can always recover these keys without anything being stored.
    let (elgamal_keypair, aes_key) = derive_confidential_keys(owner, &account.pubkey().to_bytes())
        .map_err(|e| anyhow!("failed to derive {label} confidential keys: {e}"))?;

    let proof_data = build_pubkey_validity_proof_data(&elgamal_keypair)
        .map_err(|e| anyhow!("failed to build the {label} pubkey validity proof: {e}"))?;

    let mut instructions = vec![
        solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            lamports,
            space as u64,
            &TOKEN_2022,
        ),
        token_instruction::initialize_account3(
            &TOKEN_2022,
            &account.pubkey(),
            mint,
            &owner.pubkey(),
        )?,
    ];
    instructions.extend(confidential_transfer::instruction::configure_account(
        &TOKEN_2022,
        &account.pubkey(),
        mint,
        &aes_key.encrypt(0).into(),
        MAX_PENDING_BALANCE_CREDITS,
        &owner.pubkey(),
        &[],
        // The proof rides in the next instruction of this same transaction.
        ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &proof_data),
    )?);

    send(
        rpc,
        &instructions,
        payer,
        &[payer, &account, owner],
        &format!("configure {label}"),
    )
    .await?;

    println!("{label:16} {}", account.pubkey());

    Ok(ConfidentialAccount {
        account: account.pubkey(),
        owner: owner.pubkey(),
        elgamal_keypair,
        aes_key,
    })
}

/// Mints, deposits into the confidential balance, then applies it.
///
/// A deposit lands in the pending balance. Only an applied balance can be
/// spent, and applying has to name the credit counter it expects, so it cannot
/// be bundled with the deposit — the account has to be re-read in between.
async fn fund_confidential_balance(
    rpc: &JsonRpc,
    payer: &Keypair,
    mint: &Address,
    sender: &ConfidentialAccount,
) -> Result<()> {
    let instructions = vec![
        token_instruction::mint_to_checked(
            &TOKEN_2022,
            mint,
            &sender.account,
            &payer.pubkey(),
            &[],
            FUNDING_AMOUNT,
            DECIMALS,
        )?,
        confidential_transfer::instruction::deposit(
            &TOKEN_2022,
            &sender.account,
            mint,
            FUNDING_AMOUNT,
            DECIMALS,
            &sender.owner,
            &[],
        )?,
    ];
    send(rpc, &instructions, payer, &[payer], "mint and deposit").await?;

    let pending = read_balances(rpc, &sender.account).await?;
    let apply = confidential_transfer::instruction::apply_pending_balance(
        &TOKEN_2022,
        &sender.account,
        pending.pending_balance_credit_counter,
        &pending
            .after_applying_pending(sender.elgamal_keypair.secret(), &sender.aes_key)?
            .into(),
        &sender.owner,
        &[],
    )?;
    send(rpc, &[apply], payer, &[payer], "apply pending balance").await?;

    let applied = read_balances(rpc, &sender.account).await?;
    println!(
        "\nsender balance   {} units available, {} pending\n",
        applied.available(&sender.aes_key)?,
        applied.pending(sender.elgamal_keypair.secret())?
    );
    Ok(())
}

/// Generates the three proofs, assembles them with the transfer into one v1
/// transaction, and sends it.
async fn send_confidential_transfer(
    rpc: &JsonRpc,
    payer: &Keypair,
    mint: &Address,
    sender: &ConfidentialAccount,
    recipient: &ConfidentialAccount,
) -> Result<String> {
    let balances = read_balances(rpc, &sender.account).await?;

    let TransferProofData {
        equality_proof_data,
        ciphertext_validity_proof_data_with_ciphertext,
        range_proof_data,
    } = balances.transfer_proofs(
        TRANSFER_AMOUNT,
        &sender.elgamal_keypair,
        &sender.aes_key,
        recipient.elgamal_keypair.pubkey(),
        // No auditor on this mint — see ADR O1.
        None,
    )?;

    // Offsets 1, 2 and 3: each proof instruction sits that many slots after the
    // transfer instruction in the same transaction. This is the arrangement
    // that needs the larger transaction; the alternative is writing each proof
    // to a context state account first, which is the chain of transactions R3
    // rules out.
    let instructions = confidential_transfer::instruction::transfer(
        &TOKEN_2022,
        &sender.account,
        mint,
        &recipient.account,
        &balances
            .after_sending(TRANSFER_AMOUNT, &sender.aes_key)?
            .into(),
        &ciphertext_validity_proof_data_with_ciphertext.ciphertext_lo,
        &ciphertext_validity_proof_data_with_ciphertext.ciphertext_hi,
        &sender.owner,
        &[],
        ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &equality_proof_data),
        ProofLocation::InstructionOffset(
            NonZeroI8::new(2).unwrap(),
            &ciphertext_validity_proof_data_with_ciphertext.proof_data,
        ),
        ProofLocation::InstructionOffset(NonZeroI8::new(3).unwrap(), &range_proof_data),
    )
    .context("failed to build the transfer instructions")?;

    println!("--- the transfer ---");
    println!("amount           {TRANSFER_AMOUNT} units");
    println!("instructions     {} in one transaction", instructions.len());

    let sent = send(rpc, &instructions, payer, &[payer], "confidential transfer").await?;
    println!(
        "size             {} bytes of {MAX_TRANSACTION_SIZE}",
        sent.size
    );
    println!("signature        {}", sent.signature);
    println!("confirmed slot   {}", sent.slot);

    let remaining = read_balances(rpc, &sender.account).await?;
    println!(
        "sender left with {} units",
        remaining.available(&sender.aes_key)?
    );

    Ok(sent.signature)
}

/// Fetches the transfer from an RPC that had nothing to do with sending it and
/// prints what it can see of the amount.
async fn verify_through_third_party(rpc: &JsonRpc, signature: &str) -> Result<()> {
    println!("\n--- what a third party sees ---");
    println!("via              {}", rpc.url());

    // Third-party RPCs lag the sending node by a slot or two.
    let mut transaction = None;
    for _ in 0..20 {
        match rpc.get_transaction(signature).await {
            Ok(value) => {
                transaction = Some(value);
                break;
            }
            Err(e) if e.to_string().contains("has not seen") => {
                tokio::time::sleep(std::time::Duration::from_millis(1_000)).await;
            }
            Err(e) => return Err(e.context(
                "getTransaction failed — if the error mentions a transaction version, that RPC \
                 has not declared maxSupportedTransactionVersion: 1 (ADR B7)",
            )),
        }
    }
    let transaction =
        transaction.ok_or_else(|| anyhow!("{} never returned {signature}", rpc.url()))?;

    let version = &transaction["version"];
    println!("version          {version}");
    if version != &Value::from(1) {
        bail!("expected a v1 transaction, the RPC reports version {version}");
    }

    let instructions = transaction["transaction"]["message"]["instructions"]
        .as_array()
        .ok_or_else(|| anyhow!("no instructions in the fetched transaction"))?;

    let token_instructions: Vec<&Value> = instructions
        .iter()
        .filter(|ix| ix["programId"].as_str() == Some(&TOKEN_2022.to_string()))
        .collect();

    if token_instructions.is_empty() {
        bail!("the fetched transaction carries no Token-2022 instruction");
    }

    for instruction in &token_instructions {
        println!("{}", serde_json::to_string_pretty(instruction)?);
    }

    // The point of the whole exercise: an ordinary SPL transfer parses to
    // `"amount": "4200000"`. This one has no plaintext amount anywhere.
    let rendered = serde_json::to_string(&token_instructions)?;
    let transfer_amount = TRANSFER_AMOUNT.to_string();
    if rendered.contains(&transfer_amount) {
        bail!(
            "the amount {transfer_amount} appears in plaintext in the fetched instruction — \
             the transfer is not confidential"
        );
    }

    println!("\namount           {transfer_amount} does not appear in the instruction");
    match token_instructions[0]["parsed"]["info"].as_object() {
        Some(info) => {
            println!("                 what is there instead:");
            for (field, value) in info {
                println!("                   {field}: {value}");
            }
        }
        None => {
            println!("                 the RPC did not parse it; the opaque data is:");
            println!("                   {}", token_instructions[0]["data"]);
        }
    }

    Ok(())
}

/// Reads the confidential extension off a token account.
async fn read_balances(rpc: &JsonRpc, account: &Address) -> Result<Balances> {
    let data = rpc
        .account_data(account)
        .await?
        .ok_or_else(|| anyhow!("token account {account} does not exist"))?;
    let state = StateWithExtensionsOwned::<Account>::unpack(data)
        .with_context(|| format!("could not unpack token account {account}"))?;
    Ok(Balances::read(
        state.get_extension::<ConfidentialTransferAccount>()?,
    ))
}

/// What one sent transaction turned out to be.
struct Sent {
    signature: String,
    slot: u64,
    size: usize,
}

/// Compiles, signs, sends and confirms one v1 transaction.
///
/// Every transaction here is v1, not only the transfer. Doing it uniformly
/// means the whole flow exercises the size cap and the RPC's version support,
/// rather than only the one step that strictly needs it.
async fn send(
    rpc: &JsonRpc,
    instructions: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
    label: &str,
) -> Result<Sent> {
    let blockhash = rpc.latest_blockhash().await?;
    let signers: Vec<&dyn Signer> = signers.iter().map(|s| *s as &dyn Signer).collect();
    let transaction = v1::compile_and_sign(instructions, payer, &signers, blockhash, BUDGET)
        .with_context(|| format!("failed to build the {label} transaction"))?;

    let wire = v1::serialize(&transaction)?;
    if wire.len() > MAX_TRANSACTION_SIZE {
        bail!(
            "the {label} transaction is {} bytes, over the {MAX_TRANSACTION_SIZE}-byte cap",
            wire.len()
        );
    }

    let signature = rpc
        .send_transaction(&wire)
        .await
        .with_context(|| format!("failed to send the {label} transaction"))?;
    let slot = rpc
        .confirm(&signature, 60)
        .await
        .with_context(|| format!("the {label} transaction did not confirm"))?;

    Ok(Sent {
        signature,
        slot,
        size: wire.len(),
    })
}

/// Reads the payer from `SPIKE_KEYPAIR`, or from a throwaway devnet keypair
/// beside the crate, generating that one if it is not there yet.
///
/// Generating rather than reaching for `~/.config/solana/id.json` on purpose:
/// nothing here should ever be run with a key that has anything on it.
fn load_payer() -> Result<Keypair> {
    let path = std::env::var("SPIKE_KEYPAIR")
        .unwrap_or_else(|_| format!("{}/devnet-payer.json", env!("CARGO_MANIFEST_DIR")));

    if !std::path::Path::new(&path).exists() {
        let keypair = Keypair::new();
        std::fs::write(&path, serde_json::to_string(&keypair.to_bytes().to_vec())?)
            .with_context(|| format!("could not write a new keypair to {path}"))?;
        println!("generated a new devnet keypair at {path}");
        return Ok(keypair);
    }

    let contents = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read the keypair at {path}"))?;
    let bytes: Vec<u8> =
        serde_json::from_str(&contents).with_context(|| format!("{path} is not a keypair file"))?;

    Keypair::try_from(bytes.as_slice()).map_err(|e| anyhow!("{path} is not a valid keypair: {e}"))
}

/// Tops the payer up if devnet will oblige. It often will not, so the failure
/// says what to do about it.
async fn ensure_funded(rpc: &JsonRpc, payer: &Address) -> Result<()> {
    let balance = rpc.balance(payer).await?;
    if balance >= MINIMUM_PAYER_LAMPORTS {
        return Ok(());
    }

    println!("payer has {balance} lamports, requesting an airdrop");
    match rpc.request_airdrop(payer, MINIMUM_PAYER_LAMPORTS).await {
        Ok(signature) => {
            let _ = rpc.confirm(&signature, 40).await;
        }
        Err(e) => println!("airdrop refused: {e}"),
    }

    let balance = rpc.balance(payer).await.unwrap_or(balance);
    if balance >= MINIMUM_PAYER_LAMPORTS {
        return Ok(());
    }

    bail!(
        "payer {payer} has {balance} lamports and the faucet did not top it up. \
         Fund it from https://faucet.solana.com and run again."
    )
}
