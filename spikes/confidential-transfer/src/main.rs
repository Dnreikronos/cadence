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
#[path = "../../wallet-providers/provider.rs"]
mod provider;
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
    std::{num::NonZeroI8, str::FromStr},
};

/// Token-2022, the program carrying the confidential instructions since the
/// 2026-06-17 redeploy.
const TOKEN_2022: Address = spl_token_2022_interface::ID;

/// USDC's decimals, so the numbers below read like the real thing.
const DECIMALS: u8 = 6;

/// Put in the sender's account, then deposited whole into the confidential
/// balance. Ten tokens, so the 20 devnet USDC Circle's faucet hands out covers
/// it when running against wrapped USDC.
const FUNDING_AMOUNT: u64 = 10_000_000;

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
    let provider = provider::Provider::from_env()?;
    if provider.is_some() {
        provider::require_devnet(&rpc).await?;
    }

    let payer = load_payer()?;
    println!("payer            {}", payer.pubkey());
    println!("rpc              {}", rpc.url());
    println!("verification rpc {}\n", verify_rpc.url());

    ensure_funded(&rpc, &payer.pubkey()).await?;

    // --- step 1: a mint with the confidential extension ------------------
    // SPIKE_MINT runs against an existing mint instead, such as the wrapped
    // USDC from ops/mint. Nobody can mint that one but the wrap program, so
    // the sender is funded out of the payer's own wrapped tokens.
    let (mint, funding) = match std::env::var("SPIKE_MINT") {
        Ok(mint) => {
            let mint = Address::from_str(&mint).context("SPIKE_MINT is not an address")?;
            let (owner, data) = rpc
                .account(&mint)
                .await?
                .ok_or_else(|| anyhow!("SPIKE_MINT {mint} does not exist"))?;
            check_existing_mint(&owner, data)?;
            println!("mint             {mint} (existing)");
            let source = associated_token_address(&payer.pubkey(), &mint);
            (mint, Funding::TransferFrom(source))
        }
        Err(_) => (create_mint(&rpc, &payer).await?, Funding::MintTo),
    };

    // --- step 2: two token accounts configured for confidential transfers -
    let recipient_owner = Keypair::new();
    let mut sender = configure_account(&rpc, &payer, &mint, &payer, "sender").await?;
    let recipient = configure_account(&rpc, &payer, &mint, &recipient_owner, "recipient").await?;

    // --- step 3: deposit, then apply --------------------------------------
    fund_confidential_balance(&rpc, &payer, &mint, &sender, &funding).await?;

    if let Some(provider) = &provider {
        let change_owner = token_instruction::set_authority(
            &TOKEN_2022,
            &sender.account,
            Some(&provider.address),
            token_instruction::AuthorityType::AccountOwner,
            &payer.pubkey(),
            &[],
        )?;
        send(&rpc, &[change_owner], &payer, &[], "assign provider owner").await?;
        sender.owner = provider.address;
    }

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

    send(rpc, &instructions, payer, &[&mint], "create mint").await?;
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
        &[&account, owner],
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

/// Confirms an existing mint can take the spike's fixed amounts, before any
/// rent is spent on token accounts for it.
///
/// The amounts are raw units and the funding transfer is checked against
/// `DECIMALS`, so a mint of any other precision fails there, two accounts in.
/// A legacy SPL Token mint has the same base layout and would read as six
/// decimals just the same, so the owner is checked first.
fn check_existing_mint(owner: &Address, data: Vec<u8>) -> Result<()> {
    if *owner != TOKEN_2022 {
        bail!("SPIKE_MINT is owned by {owner}, not Token-2022");
    }
    let state = StateWithExtensionsOwned::<Mint>::unpack(data)
        .context("SPIKE_MINT is not a Token-2022 mint")?;
    if state.base.decimals != DECIMALS {
        bail!(
            "SPIKE_MINT has {} decimals, and the spike's amounts assume {DECIMALS}",
            state.base.decimals
        );
    }
    Ok(())
}

/// Where the sender's tokens come from.
enum Funding {
    /// The spike's own mint, where the payer is the mint authority.
    MintTo,
    /// A mint the payer cannot mint, like wrapped USDC. The tokens come out of
    /// this account, which the payer owns.
    TransferFrom(Address),
}

/// The payer's associated Token-2022 account for `mint`, which is where
/// ops/mint puts wrapped tokens.
fn associated_token_address(owner: &Address, mint: &Address) -> Address {
    const ASSOCIATED_TOKEN: Address =
        Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    Address::find_program_address(
        &[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN,
    )
    .0
}

/// Funds the sender, deposits into the confidential balance, then applies it.
///
/// A deposit lands in the pending balance and only an applied balance can be
/// spent. Applying names the credit counter it expects, which is why the
/// account is re-read in between here — but the program does not check that
/// number, so the two could be bundled by predicting it. Kept apart because it
/// reads better, not because it has to be.
async fn fund_confidential_balance(
    rpc: &JsonRpc,
    payer: &Keypair,
    mint: &Address,
    sender: &ConfidentialAccount,
    funding: &Funding,
) -> Result<()> {
    let fund = match funding {
        Funding::MintTo => token_instruction::mint_to_checked(
            &TOKEN_2022,
            mint,
            &sender.account,
            &payer.pubkey(),
            &[],
            FUNDING_AMOUNT,
            DECIMALS,
        )?,
        Funding::TransferFrom(source) => token_instruction::transfer_checked(
            &TOKEN_2022,
            source,
            mint,
            &sender.account,
            &payer.pubkey(),
            &[],
            FUNDING_AMOUNT,
            DECIMALS,
        )?,
    };
    let instructions = vec![
        fund,
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
    send(rpc, &instructions, payer, &[], "fund and deposit").await?;

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
    send(rpc, &[apply], payer, &[], "apply pending balance").await?;

    let applied = read_balances(rpc, &sender.account).await?;
    // The program does not reject an apply whose expected counter was stale, it
    // just records both numbers and moves on. Comparing them afterwards is the
    // only way to learn that the AES balance now disagrees with the ElGamal one.
    if !applied.applied_cleanly() {
        bail!(
            "a credit landed while the apply was in flight, so the sender's AES balance no \
             longer matches the real one. Rerun — the spike does not handle the resync"
        );
    }
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

    let sent = if let Some(provider) = provider::Provider::from_env()? {
        provider.send(rpc, &instructions, payer, BUDGET).await?
    } else {
        send(rpc, &instructions, payer, &[], "confidential transfer").await?
    };
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

    let transaction = rpc.get_transaction(signature).await.context(
        "getTransaction failed — if the error mentions a transaction version, that RPC has \
         not declared maxSupportedTransactionVersion: 1 (ADR B7)",
    )?;

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

    let info = check_no_plaintext_amount(token_instructions[0]).with_context(|| {
        format!(
            "checked against {}; rerun with SPIKE_VERIFY_RPC_URL elsewhere if that RPC is the \
             problem",
            rpc.url()
        )
    })?;

    println!("\namount           {TRANSFER_AMOUNT} does not appear in the parsed instruction");
    println!("                 what is there instead:");
    for (field, value) in &info {
        println!("                   {field}: {value}");
    }

    show_amount_ciphertext(rpc, signature).await
}

/// Confirms a fetched Token-2022 instruction exposes no plaintext amount, and
/// returns what it does expose.
///
/// Split out from the fetch so it can be tested, because the interesting cases
/// are the ones a happy devnet run never produces. It previously searched the
/// whole instruction for the decimal amount, which quietly passed anything the
/// RPC had not parsed — unparsed data is base58, and base58 has no `0` in its
/// alphabet, so a decimal amount could never appear there.
fn check_no_plaintext_amount(instruction: &Value) -> Result<serde_json::Map<String, Value>> {
    let parsed = instruction["parsed"].as_object().ok_or_else(|| {
        anyhow!(
            "the Token-2022 instruction came back unparsed, so there is nothing here to check \
             an amount against — this is inconclusive, not a pass"
        )
    })?;

    let instruction_type = parsed["type"].as_str().unwrap_or_default();
    if instruction_type != "confidentialTransfer" {
        bail!("expected a confidentialTransfer instruction, the RPC parsed a {instruction_type}");
    }

    let info = parsed["info"]
        .as_object()
        .ok_or_else(|| anyhow!("the parsed confidentialTransfer carries no info"))?;

    // A confidential transfer has no amount to report; what it does carry is
    // the sender's re-encrypted balance. If that is missing, the instruction is
    // not shaped the way this check assumes and the result means nothing.
    if !info.contains_key("newSourceDecryptableAvailableBalance") {
        bail!(
            "the parsed confidentialTransfer has no newSourceDecryptableAvailableBalance, \
             so this is not the instruction shape the check was written against"
        );
    }

    // An ordinary SPL transfer parses to `"amount": "4200000"`.
    if serde_json::to_string(parsed)?.contains(&TRANSFER_AMOUNT.to_string()) {
        bail!(
            "the amount {TRANSFER_AMOUNT} appears in plaintext in the fetched instruction — \
             the transfer is not confidential"
        );
    }

    Ok(info.clone())
}

/// Reads the transfer amount off the wire, as ciphertext.
///
/// The parsed view above proves no plaintext amount is exposed, but it renders
/// only some of the instruction, so on its own it cannot show what the amount
/// *is*. The amount rides in `transfer_amount_auditor_ciphertext_lo` and `_hi`,
/// two ElGamal ciphertexts the parser does not surface, so the only way to see
/// them is to read the bytes.
async fn show_amount_ciphertext(rpc: &JsonRpc, signature: &str) -> Result<()> {
    let transaction = rpc.get_transaction_raw(signature).await?;
    let message = &transaction["transaction"]["message"];
    let account_keys = message["accountKeys"]
        .as_array()
        .ok_or_else(|| anyhow!("no account keys in the unparsed transaction"))?;

    let data = message["instructions"]
        .as_array()
        .ok_or_else(|| anyhow!("no instructions in the unparsed transaction"))?
        .iter()
        .find(|ix| {
            ix["programIdIndex"]
                .as_u64()
                .and_then(|i| account_keys.get(i as usize))
                .and_then(Value::as_str)
                == Some(&TOKEN_2022.to_string())
        })
        .and_then(|ix| ix["data"].as_str())
        .ok_or_else(|| anyhow!("no Token-2022 instruction in the unparsed transaction"))?;

    let bytes = bs58::decode(data)
        .into_vec()
        .context("the instruction data was not base58")?;
    let (lo, hi) = amount_ciphertext(&bytes)?;

    println!("\namount on the wire");
    println!("                 lo {}", hex(lo));
    println!("                 hi {}", hex(hi));
    println!("                 64 bytes each, ElGamal, and no plaintext anywhere in the 169");

    Ok(())
}

/// Picks the two halves of the encrypted amount out of a raw `Transfer`
/// instruction, and confirms the plaintext is not sitting beside them.
///
/// `TransferInstructionData`, in declaration order: two discriminant bytes, the
/// sender's AES balance, the two auditor ciphertexts, three proof offsets.
fn amount_ciphertext(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    const AES_BALANCE: usize = 2 + 36;
    const AUDITOR_LO: usize = AES_BALANCE + 64;
    const AUDITOR_HI: usize = AUDITOR_LO + 64;
    const INSTRUCTION_LEN: usize = AUDITOR_HI + 3;

    if bytes.len() != INSTRUCTION_LEN {
        bail!(
            "expected a {INSTRUCTION_LEN}-byte transfer instruction, got {}",
            bytes.len()
        );
    }

    // The check the parsed view cannot make. A transparent transfer puts the
    // amount here as a little-endian u64.
    if bytes.windows(8).any(|w| w == TRANSFER_AMOUNT.to_le_bytes()) {
        bail!("the transfer amount appears in the instruction data in the clear");
    }

    Ok((
        &bytes[AES_BALANCE..AUDITOR_LO],
        &bytes[AUDITOR_LO..AUDITOR_HI],
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
        write_secret(&path, &serde_json::to_string(&keypair.to_bytes().to_vec())?)
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

/// Writes a new file readable only by its owner.
///
/// `std::fs::write` takes whatever the umask allows, which usually leaves a
/// secret key world-readable. Harmless for a disposable devnet key, but this
/// crate is the closest thing to a template the proof service has, and B19
/// asks for more than this of the ElGamal secrets it will hold.
#[cfg(unix)]
fn write_secret(path: &str, contents: &str) -> std::io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};

    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_secret(path: &str, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use solana_zk_sdk::encryption::elgamal::ElGamalCiphertext;
    use spl_token_2022_interface::extension::StateWithExtensionsMut;

    /// A bare mint with the given precision, laid out as either token program
    /// would store it.
    fn mint_data(decimals: u8) -> Vec<u8> {
        let mut data = vec![0; ExtensionType::try_calculate_account_len::<Mint>(&[]).unwrap()];
        let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
        state.base = Mint {
            decimals,
            is_initialized: true,
            ..Mint::default()
        };
        state.pack_base();
        data
    }

    #[test]
    fn a_six_decimal_token_2022_mint_is_accepted() {
        check_existing_mint(&TOKEN_2022, mint_data(DECIMALS)).expect("should pass");
    }

    #[test]
    fn a_mint_of_another_precision_is_rejected() {
        let error = check_existing_mint(&TOKEN_2022, mint_data(9))
            .unwrap_err()
            .to_string();
        assert!(error.contains("9 decimals"), "got {error}");
    }

    /// Same bytes, wrong program: the funding transfer goes through
    /// Token-2022, so a legacy mint would fail there.
    #[test]
    fn a_legacy_spl_token_mint_is_rejected() {
        let legacy = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        let error = check_existing_mint(&legacy, mint_data(DECIMALS))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not Token-2022"), "got {error}");
    }

    /// What a successful run gets back.
    fn confidential_instruction() -> Value {
        json!({
            "program": "spl-token",
            "programId": TOKEN_2022.to_string(),
            "parsed": {
                "type": "confidentialTransfer",
                "info": {
                    "source": "8GYk41ncpvnfbrF5S7DwDrmdFLCu3ZbQC6mWQwmp4oU8",
                    "destination": "BfvfMyNNFykyeCy1gxisg4uBtom7cx6pFdbA9fS4K9vt",
                    "newSourceDecryptableAvailableBalance": "eG8AO9PE5KPLUklL2O23f4qKMF1qUQij5BNoyGmjt66OR8Ay",
                    "equalityProofInstructionOffset": 1,
                    "ciphertextValidityProofInstructionOffset": 2,
                    "rangeProofInstructionOffset": 3,
                }
            }
        })
    }

    #[test]
    fn a_confidential_transfer_exposes_no_amount() {
        let info = check_no_plaintext_amount(&confidential_instruction()).expect("should pass");
        assert!(info.contains_key("newSourceDecryptableAvailableBalance"));
        assert!(!info.contains_key("amount"));
    }

    /// The regression that matters. An RPC which does not parse Token-2022
    /// returns base58, whose alphabet has no `0`, so searching it for a decimal
    /// amount always came up empty and every transfer passed — including a
    /// transparent one.
    #[test]
    fn an_unparsed_instruction_is_inconclusive_not_a_pass() {
        let transparent_amount_in_base58 =
            bs58::encode(TRANSFER_AMOUNT.to_le_bytes()).into_string();
        assert!(
            !transparent_amount_in_base58.contains('0'),
            "base58 cannot contain a zero, which is what made the old check useless"
        );

        let unparsed = json!({
            "programId": TOKEN_2022.to_string(),
            "data": transparent_amount_in_base58,
        });

        let error = check_no_plaintext_amount(&unparsed)
            .unwrap_err()
            .to_string();
        assert!(error.contains("inconclusive"), "got {error}");
    }

    #[test]
    fn a_transparent_transfer_is_rejected() {
        let transparent = json!({
            "programId": TOKEN_2022.to_string(),
            "parsed": {
                "type": "confidentialTransfer",
                "info": {
                    "newSourceDecryptableAvailableBalance": "whatever",
                    "amount": TRANSFER_AMOUNT.to_string(),
                }
            }
        });

        let error = check_no_plaintext_amount(&transparent)
            .unwrap_err()
            .to_string();
        assert!(error.contains("plaintext"), "got {error}");
    }

    #[test]
    fn an_unexpected_instruction_shape_is_rejected() {
        let mut wrong_type = confidential_instruction();
        wrong_type["parsed"]["type"] = json!("transfer");
        assert!(check_no_plaintext_amount(&wrong_type).is_err());

        let mut no_balance = confidential_instruction();
        no_balance["parsed"]["info"]
            .as_object_mut()
            .unwrap()
            .remove("newSourceDecryptableAvailableBalance");
        assert!(check_no_plaintext_amount(&no_balance).is_err());
    }

    /// A real 169-byte `Transfer`, with the amount ciphertexts where the struct
    /// says they are.
    fn transfer_instruction_bytes() -> Vec<u8> {
        let mut bytes = vec![27u8, 7];
        bytes.extend([0xAA; 36]); // AES balance
        bytes.extend([0xBB; 64]); // auditor ciphertext lo
        bytes.extend([0xCC; 64]); // auditor ciphertext hi
        bytes.extend([1, 2, 3]); // proof offsets
        bytes
    }

    #[test]
    fn the_amount_ciphertext_is_where_the_struct_says() {
        let bytes = transfer_instruction_bytes();
        let (lo, hi) = amount_ciphertext(&bytes).expect("should parse");
        assert_eq!(lo, [0xBB; 64]);
        assert_eq!(hi, [0xCC; 64]);
    }

    #[test]
    fn a_plaintext_amount_in_the_raw_bytes_is_rejected() {
        let mut bytes = transfer_instruction_bytes();
        bytes[40..48].copy_from_slice(&TRANSFER_AMOUNT.to_le_bytes());
        let error = amount_ciphertext(&bytes).unwrap_err().to_string();
        assert!(error.contains("in the clear"), "got {error}");
    }

    #[test]
    fn a_wrong_length_instruction_is_rejected() {
        assert!(amount_ciphertext(&[27, 7]).is_err());
        assert!(amount_ciphertext(&transfer_instruction_bytes()[..168]).is_err());
    }

    /// Builds the real transfer — real proofs, real instruction encoding — over
    /// a synthetic balance, and measures the wire size of the v1 transaction it
    /// compiles to.
    ///
    /// This is the half of the "done when" that can be checked without a funded
    /// key. Nothing here touches a network.
    #[test]
    fn one_confidential_transfer_fits_in_a_v1_transaction() {
        let sender_keys = ElGamalKeypair::new_rand();
        let recipient_keys = ElGamalKeypair::new_rand();
        let aes_key = AeKey::new_rand();

        let available: ElGamalCiphertext = sender_keys.pubkey().encrypt(FUNDING_AMOUNT);
        let decryptable = aes_key.encrypt(FUNDING_AMOUNT);

        let TransferProofData {
            equality_proof_data,
            ciphertext_validity_proof_data_with_ciphertext,
            range_proof_data,
        } = spl_token_confidential_transfer_proof_generation::transfer::transfer_split_proof_data(
            &available,
            &decryptable,
            TRANSFER_AMOUNT,
            &sender_keys,
            &aes_key,
            recipient_keys.pubkey(),
            None,
        )
        .expect("proof generation");

        let payer = Keypair::new();
        let instructions = confidential_transfer::instruction::transfer(
            &TOKEN_2022,
            &Keypair::new().pubkey(),
            &Keypair::new().pubkey(),
            &Keypair::new().pubkey(),
            &aes_key.encrypt(FUNDING_AMOUNT - TRANSFER_AMOUNT).into(),
            &ciphertext_validity_proof_data_with_ciphertext.ciphertext_lo,
            &ciphertext_validity_proof_data_with_ciphertext.ciphertext_hi,
            &payer.pubkey(),
            &[],
            ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &equality_proof_data),
            ProofLocation::InstructionOffset(
                NonZeroI8::new(2).unwrap(),
                &ciphertext_validity_proof_data_with_ciphertext.proof_data,
            ),
            ProofLocation::InstructionOffset(NonZeroI8::new(3).unwrap(), &range_proof_data),
        )
        .expect("instruction assembly");

        assert_eq!(instructions.len(), 4, "transfer plus its three proofs");

        let signers: Vec<&dyn Signer> = vec![];
        let transaction = v1::compile_and_sign(
            &instructions,
            &payer,
            &signers,
            solana_hash::Hash::new_from_array(Keypair::new().pubkey().to_bytes()),
            BUDGET,
        )
        .expect("v1 compilation");
        let size = v1::serialize(&transaction).expect("serialization").len();

        if let Ok(path) = std::env::var("WALLET_SPIKE_FIXTURE") {
            use base64::{engine::general_purpose::STANDARD, Engine};
            let mut unsigned = transaction.clone();
            unsigned
                .signatures
                .fill(solana_signature::Signature::default());
            std::fs::write(
                path,
                serde_json::to_vec_pretty(&json!({
                    "kind": "synthetic-confidential-transfer-not-submittable",
                    "address": payer.pubkey().to_string(),
                    "transaction": STANDARD.encode(v1::serialize(&unsigned).unwrap()),
                }))
                .unwrap(),
            )
            .unwrap();
        }

        println!("one confidential transfer is {size} bytes of {MAX_TRANSACTION_SIZE}");
        assert!(
            size <= MAX_TRANSACTION_SIZE,
            "{size} bytes is over the {MAX_TRANSACTION_SIZE}-byte v1 cap"
        );
        // And the reason the old cap is not enough, stated as a test rather
        // than a claim in a comment.
        assert!(
            size > 1_232,
            "{size} bytes would have fit a legacy transaction — check the proofs are inline"
        );
    }
}
