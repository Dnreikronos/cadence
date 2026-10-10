use crate::{
    chain::{address, bridge, decode, encode, save_secrets, Chain, ConfidentialAccount, Vault},
    configure,
    rpc::JsonRpc,
    DEVNET, TOKEN,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use solana_keypair::{read_keypair_file, Keypair};
use solana_signer::Signer;
use solana_zk_elgamal_proof_interface::{
    instruction::{ContextStateInfo, ProofInstruction},
    proof_data::PubkeyValidityProofContext,
    state::ProofContextState,
};
use solana_zk_sdk::zk_elgamal_proof_program::build_pubkey_validity_proof_data;
use spl_token_2022_interface::extension::{
    confidential_transfer::{instruction as confidential, ConfidentialTransferAccount},
    BaseStateWithExtensions,
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use std::path::Path;

pub async fn probe(run: &Path) -> Result<()> {
    let evidence: Value = serde_json::from_slice(&std::fs::read(run.join("evidence.json"))?)?;
    let secrets: Value = serde_json::from_slice(&std::fs::read(run.join("secrets.json"))?)?;
    let rpc = JsonRpc::new(evidence["rpc"].as_str().context("missing RPC")?);
    ensure!(
        rpc.call("getGenesisHash", json!([])).await?.as_str() == Some(DEVNET),
        "requires devnet"
    );
    let payer_path = std::env::var("SQUADS_KEYPAIR")
        .unwrap_or_else(|_| "../confidential-transfer/devnet-payer.json".into());
    let payer =
        read_keypair_file(payer_path).map_err(|e| anyhow::anyhow!("cannot read payer: {e}"))?;
    ensure!(
        payer.pubkey().to_string() == evidence["payer"],
        "different payer"
    );
    let partner_bytes: Vec<u8> = serde_json::from_value(secrets["partner_keypair"].clone())?;
    let partner = Keypair::try_from(partner_bytes.as_slice())?;
    let create_bytes: Vec<u8> = serde_json::from_value(secrets["create_keypair"].clone())?;
    let create = Keypair::try_from(create_bytes.as_slice())?;
    let mut request = json!({"op": "inspect", "rpc_url": rpc.url(), "creator": payer.pubkey().to_string(),
        "partner": partner.pubkey().to_string(), "create_key": create.pubkey().to_string()});
    let inspected = bridge(request.clone())?;
    let mut vault = Vault {
        address: address(&inspected, "vault")?,
        request: request.clone(),
        index: inspected["transaction_index"]
            .as_u64()
            .context("missing index")?,
    };
    let mint = address(&evidence, "mint")?;
    let unbound = ConfidentialAccount::new(vault.address);
    let alternate = ConfidentialAccount::new(vault.address);
    let bound = ConfidentialAccount::new(vault.address);
    let context = Keypair::new();
    save_secrets(
        &run.join("setup-secrets.json"),
        &json!({"unbound": unbound.secrets(),
        "bound": bound.secrets(), "context_keypair": context.to_bytes().to_vec()}),
    )?;
    let mut chain = Chain {
        rpc,
        payer,
        run: run.to_path_buf(),
        evidence,
    };
    unbound
        .create(
            &mut chain,
            &mint,
            "setup probe: create empty unbound account",
        )
        .await?;
    let original = configure(&unbound, &mint)?;
    let alternative = configure(&alternate, &mint)?;
    request["index"] = json!(vault.index + 1);
    request["op"] = json!("propose");
    request["instructions"] = json!([encode(&original[0])]);
    chain
        .send(
            "setup probe: propose inline setup",
            &decode(&bridge(request.clone())?)?,
            &[],
        )
        .await?;
    request["op"] = json!("approve");
    for member in [chain.payer.pubkey(), partner.pubkey()] {
        request["member"] = json!(member.to_string());
        chain
            .send(
                "setup probe: approve inline setup",
                &decode(&bridge(request.clone())?)?,
                &[&partner],
            )
            .await?;
    }
    request["op"] = json!("execute");
    let execute = decode(&bridge(request)?)?;
    let mut substituted = execute.clone();
    substituted.push(alternative[1].clone());
    let tx = crate::v1::compile_and_sign(
        &substituted,
        &chain.payer,
        &[],
        chain.rpc.latest_blockhash().await?,
        solana_message::v1::TransactionConfig::empty()
            .with_compute_unit_limit(1_400_000)
            .with_loaded_accounts_data_size_limit(64 * 1024 * 1024),
    )?;
    let result = chain
        .rpc
        .call(
            "simulateTransaction",
            json!([BASE64.encode(crate::v1::serialize(&tx)?),
        {"encoding": "base64", "sigVerify": true, "commitment": "confirmed"}]),
        )
        .await?;
    ensure!(
        result["value"]["err"].is_null(),
        "substitution was rejected: {result}"
    );
    chain.record(json!({"step": "inline setup accepts substituted encryption key", "simulation_error": null,
        "original_public_key": unbound.elgamal.pubkey().to_string(),
        "substituted_public_key": alternate.elgamal.pubkey().to_string(), "logs": result["value"]["logs"]}))?;
    // Do not execute the replaceable setup. Both probe accounts are empty.
    vault.index += 1;
    bound
        .create(&mut chain, &mint, "setup probe: create empty bound account")
        .await?;
    let proof = build_pubkey_validity_proof_data(&bound.elgamal)?;
    let space = std::mem::size_of::<ProofContextState<PubkeyValidityProofContext>>();
    let context_key = context.pubkey();
    let create_context = solana_system_interface::instruction::create_account(
        &chain.payer.pubkey(),
        &context_key,
        chain.rpc.minimum_balance_for_rent_exemption(space).await?,
        space as u64,
        &solana_zk_elgamal_proof_interface::ID,
    );
    let verify = ProofInstruction::VerifyPubkeyValidity.encode_verify_proof(
        Some(ContextStateInfo {
            context_state_account: &context_key,
            context_state_authority: &vault.address,
        }),
        &proof,
    );
    chain
        .send(
            "setup probe: create immutable key proof context",
            &[create_context, verify],
            &[&context],
        )
        .await?;
    let configure = confidential::configure_account(
        &TOKEN,
        &bound.token.pubkey(),
        &mint,
        &bound.aes.encrypt(0).into(),
        65_536,
        &vault.address,
        &[],
        ProofLocation::ContextStateAccount(&context_key),
    )?;
    vault
        .execute(
            &mut chain,
            &partner,
            "configure vault with bound encryption key",
            &configure,
            &[],
            &[],
        )
        .await?;
    let state = bound.state(&chain.rpc).await?;
    ensure!(
        state
            .get_extension::<ConfidentialTransferAccount>()?
            .elgamal_pubkey
            == (*bound.elgamal.pubkey()).into(),
        "wrong key"
    );
    let (program, bytes) = chain
        .rpc
        .account(&context_key)
        .await?
        .context("missing context")?;
    ensure!(
        program == solana_zk_elgamal_proof_interface::ID && bytes[..32] == vault.address.to_bytes(),
        "wrong context authority"
    );
    chain.record(
        json!({"step": "bound setup verified", "account": bound.token.pubkey().to_string(),
        "proof_context": context_key.to_string(), "close_authority": vault.address.to_string(),
        "elgamal_public_key": bound.elgamal.pubkey().to_string()}),
    )?;
    Ok(())
}

pub async fn verify(run: &Path) -> Result<()> {
    let evidence: Value = serde_json::from_slice(&std::fs::read(run.join("evidence.json"))?)?;
    let secrets: Value = serde_json::from_slice(&std::fs::read(run.join("setup-secrets.json"))?)?;
    let rpc = JsonRpc::new(evidence["rpc"].as_str().context("missing RPC")?);
    ensure!(
        rpc.call("getGenesisHash", json!([])).await?.as_str() == Some(DEVNET),
        "requires devnet"
    );
    let payer_path = std::env::var("SQUADS_KEYPAIR")
        .unwrap_or_else(|_| "../confidential-transfer/devnet-payer.json".into());
    let payer =
        read_keypair_file(payer_path).map_err(|e| anyhow::anyhow!("cannot read payer: {e}"))?;
    let bound = evidence["events"]
        .as_array()
        .context("missing events")?
        .iter()
        .find(|event| event["step"] == "bound setup verified")
        .context("missing bound setup")?;
    let context_key = address(bound, "proof_context")?;
    let vault = address(bound, "close_authority")?;
    let alternate = crate::verification::restore(&secrets["unbound"])?;
    let proof = build_pubkey_validity_proof_data(&alternate.elgamal)?;
    let overwrite = ProofInstruction::VerifyPubkeyValidity.encode_verify_proof(
        Some(ContextStateInfo {
            context_state_account: &context_key,
            context_state_authority: &vault,
        }),
        &proof,
    );
    let mut chain = Chain {
        rpc,
        payer,
        run: run.to_path_buf(),
        evidence,
    };
    chain
        .reject(
            "bound key proof context cannot be overwritten",
            &[overwrite],
            "requires an uninitialized account",
        )
        .await
}
