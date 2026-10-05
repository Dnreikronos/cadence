#[path = "../../confidential-transfer/src/balances.rs"]
mod balances;
mod chain;
#[allow(dead_code)]
#[path = "../../confidential-transfer/src/rpc.rs"]
mod rpc;
mod setup;
#[allow(dead_code)]
#[path = "../../../services/proof/src/solana/token_wrap.rs"]
mod token_wrap;
#[path = "../../confidential-transfer/src/v1.rs"]
mod v1;
mod verification;

use anyhow::{ensure, Context, Result};
use chain::{address, bridge, decode, save_secrets, Chain, ConfidentialAccount, Vault, TOKEN};
use rpc::JsonRpc;
use serde_json::json;
use solana_address::Address;
use solana_keypair::{read_keypair_file, Keypair};
use solana_signer::Signer;
use solana_zk_sdk::zk_elgamal_proof_program::build_pubkey_validity_proof_data;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{
            instruction as confidential, ConfidentialTransferAccount, ConfidentialTransferMint,
        },
        BaseStateWithExtensions, StateWithExtensionsOwned,
    },
    instruction,
    state::{Account, Mint},
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use std::{num::NonZeroI8, path::PathBuf};

const FUND: u64 = 1_000_000;
const ORDINARY: u64 = 100_000;
const PAYMENT: u64 = 420_000;
const DEVNET: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

fn configure(
    account: &ConfidentialAccount,
    mint: &Address,
) -> Result<Vec<solana_instruction::Instruction>> {
    let proof = build_pubkey_validity_proof_data(&account.elgamal)?;
    Ok(confidential::configure_account(
        &TOKEN,
        &account.token.pubkey(),
        mint,
        &account.aes.encrypt(0).into(),
        65_536,
        &account.owner,
        &[],
        ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &proof),
    )?)
}

async fn transfer(
    account: &ConfidentialAccount,
    recipient: &ConfidentialAccount,
    rpc: &JsonRpc,
    mint: &Address,
    amount: u64,
) -> Result<Vec<solana_instruction::Instruction>> {
    let balances = account.balances(rpc).await?;
    let proofs = balances.transfer_proofs(
        amount,
        &account.elgamal,
        &account.aes,
        recipient.elgamal.pubkey(),
        None,
    )?;
    Ok(confidential::transfer(
        &TOKEN,
        &account.token.pubkey(),
        mint,
        &recipient.token.pubkey(),
        &balances.after_sending(amount, &account.aes)?.into(),
        &proofs
            .ciphertext_validity_proof_data_with_ciphertext
            .ciphertext_lo,
        &proofs
            .ciphertext_validity_proof_data_with_ciphertext
            .ciphertext_hi,
        &account.owner,
        &[],
        ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &proofs.equality_proof_data),
        ProofLocation::InstructionOffset(
            NonZeroI8::new(2).unwrap(),
            &proofs
                .ciphertext_validity_proof_data_with_ciphertext
                .proof_data,
        ),
        ProofLocation::InstructionOffset(NonZeroI8::new(3).unwrap(), &proofs.range_proof_data),
    )?)
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(command) = std::env::args().nth(1) {
        let run = std::env::args()
            .nth(2)
            .context("command needs a run directory")?;
        return match command.as_str() {
            "verify" => verification::verify_run(std::path::Path::new(&run)).await,
            "probe-setup" => setup::probe(std::path::Path::new(&run)).await,
            "verify-setup" => setup::verify(std::path::Path::new(&run)).await,
            _ => anyhow::bail!(
                "usage: cargo run [-- verify|probe-setup|verify-setup <run-directory>]"
            ),
        };
    }
    let rpc_url =
        std::env::var("SQUADS_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".into());
    let rpc = JsonRpc::new(&rpc_url);
    ensure!(
        rpc.call("getGenesisHash", json!([])).await?.as_str() == Some(DEVNET),
        "requires devnet"
    );
    let verify = JsonRpc::new(
        std::env::var("SQUADS_VERIFY_RPC_URL")
            .unwrap_or_else(|_| "https://solana-devnet.api.onfinality.io/public".into()),
    );
    ensure!(
        verify.call("getGenesisHash", json!([])).await?.as_str() == Some(DEVNET),
        "verification RPC requires devnet"
    );
    ensure!(rpc.url() != verify.url(), "use independent RPC providers");
    let payer_path = std::env::var("SQUADS_KEYPAIR")
        .unwrap_or_else(|_| "../confidential-transfer/devnet-payer.json".into());
    let payer =
        read_keypair_file(&payer_path).map_err(|e| anyhow::anyhow!("cannot read payer: {e}"))?;
    ensure!(
        rpc.balance(&payer.pubkey()).await? >= 100_000_000,
        "requires 0.1 devnet SOL"
    );
    let addresses = token_wrap::Addresses::for_usdc();
    let mint = addresses.wrapped_mint;
    let (program, data) = rpc.account(&mint).await?.context("wrapped mint missing")?;
    ensure!(program == TOKEN, "wrong mint program");
    let state = StateWithExtensionsOwned::<Mint>::unpack(data)?;
    ensure!(state.base.decimals == 6, "requires six decimals");
    let extension = state.get_extension::<ConfidentialTransferMint>()?;
    ensure!(
        bool::from(extension.auto_approve_new_accounts)
            && extension.auditor_elgamal_pubkey.get().is_none(),
        "requires auto-approval and no auditor"
    );
    let source = token_wrap::associated_token_address(
        &payer.pubkey(),
        &token_wrap::DEVNET_USDC,
        &token_wrap::TOKEN,
    );
    let (_, source_data) = rpc
        .account(&source)
        .await?
        .context("payer USDC account missing")?;
    let source_state = StateWithExtensionsOwned::<Account>::unpack(source_data)?;
    ensure!(
        source_state.base.owner == payer.pubkey() && source_state.base.amount >= FUND,
        "requires 1 devnet USDC in payer ATA"
    );

    let partner = Keypair::new();
    let create_key = Keypair::new();
    let request = json!({"op": "create", "rpc_url": rpc_url, "creator": payer.pubkey().to_string(),
        "partner": partner.pubkey().to_string(), "create_key": create_key.pubkey().to_string()});
    let created = bridge(request.clone())?;
    let mut vault = Vault {
        address: address(&created, "vault")?,
        request,
        index: 0,
    };
    let sender = ConfidentialAccount::new(vault.address);
    let recipient = ConfidentialAccount::new(partner.pubkey());
    let run = PathBuf::from(".runs").join(create_key.pubkey().to_string());
    std::fs::create_dir_all(&run)?;
    save_secrets(
        &run.join("secrets.json"),
        &json!({"partner_keypair": partner.to_bytes().to_vec(),
        "create_keypair": create_key.to_bytes().to_vec(), "sender": sender.secrets(), "recipient": recipient.secrets()}),
    )?;
    let evidence = json!({"date": "2026-10-04", "cluster": "devnet", "genesis_hash": DEVNET,
        "rpc": rpc.url(), "verification_rpc": verify.url(), "payer": payer.pubkey().to_string(),
        "members": [payer.pubkey().to_string(), partner.pubkey().to_string()], "threshold": 2,
        "multisig": created["multisig"], "vault": vault.address.to_string(), "squads_program": created["program"],
        "mint": mint.to_string(), "sender": sender.token.pubkey().to_string(), "recipient": recipient.token.pubkey().to_string(),
        "sender_elgamal_public_key": sender.elgamal.pubkey().to_string(), "events": []});
    let mut chain = Chain {
        rpc,
        payer,
        run,
        evidence,
    };
    println!(
        "public evidence: {}",
        chain.run.join("evidence.json").display()
    );
    chain
        .send("create 2-of-2 multisig", &decode(&created)?, &[&create_key])
        .await?;
    sender
        .create(&mut chain, &mint, "create vault token account")
        .await?;
    recipient
        .create(&mut chain, &mint, "create recipient token account")
        .await?;
    let receiver_setup = configure(&recipient, &mint)?;
    chain
        .send("configure recipient", &receiver_setup, &[&partner])
        .await?;
    let fund = token_wrap::wrap(
        &addresses,
        &sender.token.pubkey(),
        &source,
        &chain.payer.pubkey(),
        FUND,
    );
    chain.send("wrap 1 USDC into vault", &[fund], &[]).await?;
    let ordinary = instruction::transfer_checked(
        &TOKEN,
        &sender.token.pubkey(),
        &mint,
        &recipient.token.pubkey(),
        &vault.address,
        &[],
        ORDINARY,
        6,
    )?;
    vault
        .execute(
            &mut chain,
            &partner,
            "ordinary vault transfer",
            &[ordinary],
            &[],
            &[],
        )
        .await?;
    ensure!(
        sender.state(&chain.rpc).await?.base.amount == FUND - ORDINARY,
        "wrong ordinary sender balance"
    );
    ensure!(
        recipient.state(&chain.rpc).await?.base.amount == ORDINARY,
        "ordinary recipient was not credited"
    );
    let sender_setup = configure(&sender, &mint)?;
    vault
        .execute(
            &mut chain,
            &partner,
            "configure vault confidential account",
            &sender_setup[..1],
            &sender_setup[1..],
            &[],
        )
        .await?;
    let configured = sender.state(&chain.rpc).await?;
    let configured = configured.get_extension::<ConfidentialTransferAccount>()?;
    ensure!(
        configured.elgamal_pubkey == (*sender.elgamal.pubkey()).into()
            && bool::from(configured.approved),
        "vault encryption key not configured"
    );
    let deposit = confidential::deposit(
        &TOKEN,
        &sender.token.pubkey(),
        &mint,
        FUND - ORDINARY,
        6,
        &vault.address,
        &[],
    )?;
    vault
        .execute(
            &mut chain,
            &partner,
            "deposit vault confidential balance",
            &[deposit],
            &[],
            &[],
        )
        .await?;
    let pending = sender.balances(&chain.rpc).await?;
    let apply = confidential::apply_pending_balance(
        &TOKEN,
        &sender.token.pubkey(),
        pending.pending_balance_credit_counter,
        &pending
            .after_applying_pending(sender.elgamal.secret(), &sender.aes)?
            .into(),
        &vault.address,
        &[],
    )?;
    vault
        .execute(
            &mut chain,
            &partner,
            "apply vault pending balance",
            &[apply],
            &[],
            &[],
        )
        .await?;
    let applied = sender.balances(&chain.rpc).await?;
    ensure!(
        applied.applied_cleanly() && applied.available(&sender.aes)? == FUND - ORDINARY,
        "vault balance did not apply cleanly"
    );
    let payment = transfer(&sender, &recipient, &chain.rpc, &mint, PAYMENT).await?;
    let replacement = transfer(&sender, &recipient, &chain.rpc, &mint, PAYMENT - 1).await?;
    let guards = [
        (
            "reordered transfer proofs rejected",
            vec![payment[2].clone(), payment[1].clone(), payment[3].clone()],
            "Unexpected proof instruction",
        ),
        (
            "substituted amount proofs rejected",
            replacement[1..].to_vec(),
            "Balance mismatch",
        ),
    ];
    let signature = vault
        .execute(
            &mut chain,
            &partner,
            "confidential vault transfer",
            &payment[..1],
            &payment[1..],
            &guards,
        )
        .await?;
    let sender_balance = sender.balances(&verify).await?.available(&sender.aes)?;
    let recipient_balance = recipient
        .balances(&verify)
        .await?
        .pending(recipient.elgamal.secret())?;
    ensure!(
        sender_balance == FUND - ORDINARY - PAYMENT && recipient_balance == PAYMENT,
        "confidential balance mismatch"
    );
    let tx = verify.get_transaction(&signature).await?;
    ensure!(
        tx["meta"]["err"].is_null() && tx["version"] == 1,
        "independent RPC did not confirm v1 transfer"
    );
    let outer = tx["transaction"]["message"]["instructions"]
        .as_array()
        .context("missing transaction instructions")?;
    ensure!(
        outer.len() == 4,
        "expected Squads execute plus three top-level proofs"
    );
    chain.record(json!({"step": "independent verification", "signature": signature, "slot": tx["slot"],
        "version": tx["version"], "sender_available_units": sender_balance, "recipient_pending_units": recipient_balance,
        "recipient_public_units": ORDINARY, "payment_units": PAYMENT, "outer_instructions": outer}))?;
    chain.evidence["verdict"] = json!("direct confidential vault payment confirmed");
    std::fs::write(
        chain.run.join("evidence.json"),
        serde_json::to_vec_pretty(&chain.evidence)?,
    )?;
    println!("confirmed direct confidential payment from a 2-of-2 vault");
    Ok(())
}
