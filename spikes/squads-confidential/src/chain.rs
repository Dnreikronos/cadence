use crate::{balances::Balances, rpc::JsonRpc, v1};
use anyhow::{anyhow, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::v1::TransactionConfig;
use solana_signer::Signer;
use solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions, ExtensionType,
        StateWithExtensionsOwned,
    },
    instruction,
    state::Account,
};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    str::FromStr,
};

pub const TOKEN: Address = spl_token_2022_interface::ID;
const BUDGET: TransactionConfig = TransactionConfig::empty()
    .with_compute_unit_limit(1_400_000)
    .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);

pub struct Chain {
    pub rpc: JsonRpc,
    pub payer: Keypair,
    pub run: PathBuf,
    pub evidence: Value,
}

impl Chain {
    pub fn record(&mut self, event: Value) -> Result<()> {
        let mut summary = event.clone();
        if let Some(object) = summary.as_object_mut() {
            object.remove("logs");
            object.remove("outer_instructions");
        }
        println!("{summary}");
        self.evidence["events"].as_array_mut().unwrap().push(event);
        std::fs::write(
            self.run.join("evidence.json"),
            serde_json::to_vec_pretty(&self.evidence)?,
        )?;
        Ok(())
    }

    async fn wire(&self, instructions: &[Instruction], signers: &[&dyn Signer]) -> Result<Vec<u8>> {
        let tx = v1::compile_and_sign(
            instructions,
            &self.payer,
            signers,
            self.rpc.latest_blockhash().await?,
            BUDGET,
        )?;
        let wire = v1::serialize(&tx)?;
        ensure!(
            wire.len() <= 4096,
            "transaction exceeds v1 cap: {}",
            wire.len()
        );
        Ok(wire)
    }

    pub async fn send(
        &mut self,
        label: &str,
        instructions: &[Instruction],
        signers: &[&dyn Signer],
    ) -> Result<String> {
        let wire = self.wire(instructions, signers).await?;
        let signature = self
            .rpc
            .send_transaction(&wire)
            .await
            .with_context(|| label.to_string())?;
        let slot = self.rpc.confirm(&signature, 40).await?;
        self.record(json!({"step": label, "signature": signature, "slot": slot,
            "wire_bytes": wire.len(), "instructions": instructions.len()}))?;
        Ok(signature)
    }

    pub async fn reject(
        &mut self,
        label: &str,
        instructions: &[Instruction],
        expected_log: &str,
    ) -> Result<()> {
        let wire = self.wire(instructions, &[]).await?;
        let result = self
            .rpc
            .call(
                "simulateTransaction",
                json!([BASE64.encode(wire), {
                    "encoding": "base64", "sigVerify": true, "commitment": "confirmed"
                }]),
            )
            .await?;
        let value = &result["value"];
        ensure!(!value["err"].is_null(), "{label} unexpectedly succeeded");
        let logs = value["logs"].to_string();
        ensure!(
            logs.contains(expected_log),
            "{label} failed for an unexpected reason: {value}"
        );
        self.record(json!({"step": label, "simulation_error": value["err"], "logs": value["logs"]}))
    }
}

pub struct ConfidentialAccount {
    pub token: Keypair,
    pub owner: Address,
    pub elgamal: ElGamalKeypair,
    pub aes: AeKey,
}

impl ConfidentialAccount {
    pub fn new(owner: Address) -> Self {
        Self {
            token: Keypair::new(),
            owner,
            elgamal: ElGamalKeypair::new_rand(),
            aes: AeKey::new_rand(),
        }
    }

    pub fn secrets(&self) -> Value {
        json!({"token_account_keypair": self.token.to_bytes().to_vec(), "owner": self.owner.to_string(),
            "elgamal_keypair": self.elgamal, "aes_key": <[u8; 16]>::from(&self.aes).to_vec()})
    }

    pub async fn create(&self, chain: &mut Chain, mint: &Address, label: &str) -> Result<()> {
        let space = ExtensionType::try_calculate_account_len::<Account>(&[
            ExtensionType::ConfidentialTransferAccount,
        ])?;
        let instructions = [
            solana_system_interface::instruction::create_account(
                &chain.payer.pubkey(),
                &self.token.pubkey(),
                chain.rpc.minimum_balance_for_rent_exemption(space).await?,
                space as u64,
                &TOKEN,
            ),
            instruction::initialize_account3(&TOKEN, &self.token.pubkey(), mint, &self.owner)?,
        ];
        chain.send(label, &instructions, &[&self.token]).await?;
        Ok(())
    }

    pub async fn balances(&self, rpc: &JsonRpc) -> Result<Balances> {
        let state = self.state(rpc).await?;
        Ok(Balances::read(
            state.get_extension::<ConfidentialTransferAccount>()?,
        ))
    }

    pub async fn state(&self, rpc: &JsonRpc) -> Result<StateWithExtensionsOwned<Account>> {
        let (program, data) = rpc
            .account(&self.token.pubkey())
            .await?
            .context("missing token account")?;
        ensure!(program == TOKEN, "wrong token program");
        let state = StateWithExtensionsOwned::<Account>::unpack(data)?;
        ensure!(state.base.owner == self.owner, "token owner changed");
        Ok(state)
    }
}

pub fn save_secrets(path: &std::path::Path, secrets: &Value) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&serde_json::to_vec(secrets)?)?;
    Ok(())
}

pub fn encode(ix: &Instruction) -> Value {
    json!({"program_id": ix.program_id.to_string(), "data": ix.data,
        "accounts": ix.accounts.iter().map(|m| json!({"pubkey": m.pubkey.to_string(),
            "is_signer": m.is_signer, "is_writable": m.is_writable})).collect::<Vec<_>>()})
}

pub fn bridge(request: Value) -> Result<Value> {
    let mut child = Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/squads.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request)?)?;
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "Squads bridge failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).context("invalid bridge output")
}

pub fn decode(value: &Value) -> Result<Vec<Instruction>> {
    value["instructions"]
        .as_array()
        .context("missing instructions")?
        .iter()
        .map(|ix| {
            Ok(Instruction {
                program_id: Address::from_str(
                    ix["program_id"].as_str().context("missing program")?,
                )?,
                data: serde_json::from_value(ix["data"].clone())?,
                accounts: ix["accounts"]
                    .as_array()
                    .context("missing accounts")?
                    .iter()
                    .map(|m| {
                        Ok(AccountMeta {
                            pubkey: Address::from_str(
                                m["pubkey"].as_str().context("missing pubkey")?,
                            )?,
                            is_signer: m["is_signer"].as_bool().context("missing signer flag")?,
                            is_writable: m["is_writable"]
                                .as_bool()
                                .context("missing writable flag")?,
                        })
                    })
                    .collect::<Result<_>>()?,
            })
        })
        .collect()
}

pub struct Vault {
    pub address: Address,
    pub request: Value,
    pub index: u64,
}

impl Vault {
    pub async fn execute(
        &mut self,
        chain: &mut Chain,
        partner: &Keypair,
        label: &str,
        inner: &[Instruction],
        proofs: &[Instruction],
        guards: &[(&str, Vec<Instruction>, &str)],
    ) -> Result<String> {
        self.index += 1;
        self.request["index"] = json!(self.index);
        self.request["instructions"] = json!(inner.iter().map(encode).collect::<Vec<_>>());
        self.request["op"] = json!("propose");
        chain
            .send(
                &format!("{label}: propose"),
                &decode(&bridge(self.request.clone())?)?,
                &[],
            )
            .await?;
        self.request["op"] = json!("approve");
        self.request["member"] = json!(chain.payer.pubkey().to_string());
        chain
            .send(
                &format!("{label}: first approval"),
                &decode(&bridge(self.request.clone())?)?,
                &[],
            )
            .await?;
        self.request["op"] = json!("execute");
        let execute = decode(&bridge(self.request.clone())?)?;
        let mut outer = execute.clone();
        outer.extend_from_slice(proofs);
        chain
            .reject(
                &format!("{label}: one approval rejected"),
                &outer,
                "InvalidProposalStatus",
            )
            .await?;
        self.request["op"] = json!("approve");
        self.request["member"] = json!(partner.pubkey().to_string());
        chain
            .send(
                &format!("{label}: second approval"),
                &decode(&bridge(self.request.clone())?)?,
                &[partner],
            )
            .await?;
        for (name, invalid_proofs, expected_log) in guards {
            let mut invalid = execute.clone();
            invalid.extend_from_slice(invalid_proofs);
            chain.reject(name, &invalid, expected_log).await?;
        }
        chain.send(label, &outer, &[]).await
    }
}

pub fn address(value: &Value, key: &str) -> Result<Address> {
    Address::from_str(
        value[key]
            .as_str()
            .ok_or_else(|| anyhow!("missing {key}"))?,
    )
    .context("invalid address")
}
