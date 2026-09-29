//! Devnet-only bridge to provider SDKs. Compiled by the original transfer spike.
use crate::{rpc::JsonRpc, v1, Sent};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_message::{v1::TransactionConfig, VersionedMessage};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    io::Write,
    process::{Command, Stdio},
    str::FromStr,
};

pub struct Provider {
    pub address: Address,
}

pub async fn require_devnet(rpc: &JsonRpc) -> Result<()> {
    let genesis = rpc.call("getGenesisHash", serde_json::json!([])).await?;
    if genesis != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" {
        bail!("wallet provider experiment requires Solana devnet");
    }
    Ok(())
}

impl Provider {
    pub fn from_env() -> Result<Option<Self>> {
        let Ok(mode) = std::env::var("WALLET_PROVIDER") else {
            return Ok(None);
        };
        if !matches!(mode.as_str(), "turnkey-sdk" | "turnkey-api" | "privy") {
            bail!("WALLET_PROVIDER must be turnkey-sdk, turnkey-api, or privy");
        }
        let address = Address::from_str(&std::env::var("WALLET_ADDRESS")?)
            .context("WALLET_ADDRESS is invalid")?;
        // Validate configuration before spending rent or assigning ownership.
        let status = Command::new("node")
            .arg(Self::bridge())
            .arg("check")
            .status()?;
        if !status.success() {
            bail!("provider configuration check failed")
        }
        Ok(Some(Self { address }))
    }

    fn bridge() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../wallet-providers/sign.mjs")
    }

    pub async fn send(
        &self,
        rpc: &JsonRpc,
        instructions: &[Instruction],
        payer: &dyn Signer,
        config: TransactionConfig,
    ) -> Result<Sent> {
        let instructions: Vec<_> = instructions.iter().map(v1::to_v1).collect();
        let message = solana_message::v1::Message::try_compile_with_config(
            &payer.pubkey(),
            &instructions,
            rpc.latest_blockhash().await?,
            config,
        )?;
        let message = VersionedMessage::V1(message);
        let required = message.header().num_required_signatures as usize;
        let keys = &message.static_account_keys()[..required];
        if !keys.contains(&self.address) || self.address == payer.pubkey() {
            bail!("provider must be a required signer distinct from the local fee payer");
        }
        let signatures = keys
            .iter()
            .map(|key| {
                if *key == payer.pubkey() {
                    Ok(payer.sign_message(&message.serialize()))
                } else if *key == self.address {
                    Ok(Signature::default())
                } else {
                    Err(anyhow!("unexpected required signer"))
                }
            })
            .collect::<Result<Vec<_>>>()?;
        let unsigned = VersionedTransaction {
            message,
            signatures,
        };
        let wire = v1::serialize(&unsigned)?;
        if wire.len() > 4096 {
            bail!("provider input exceeds v1 size cap")
        }
        let mut child = Command::new("node")
            .arg(Self::bridge())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        child
            .stdin
            .take()
            .context("missing bridge stdin")?
            .write_all(BASE64.encode(&wire).as_bytes())?;
        let output = child.wait_with_output()?;
        if !output.status.success() {
            bail!("provider signing failed; see bridge stage above")
        }
        let signed_wire = BASE64.decode(String::from_utf8(output.stdout)?.trim())?;
        validate_signed(&unsigned, &signed_wire)?;
        let signature = rpc.send_transaction(&signed_wire).await?;
        let slot = rpc.confirm(&signature, 60).await?;
        eprintln!("provider transfer confirmed: {signature} at slot {slot}");
        Ok(Sent {
            signature,
            slot,
            size: signed_wire.len(),
        })
    }
}

fn validate_signed(unsigned: &VersionedTransaction, wire: &[u8]) -> Result<()> {
    if wire.len() > 4096 {
        bail!("provider output exceeds v1 size cap")
    }
    let signed: VersionedTransaction = wincode::deserialize(wire)?;
    if signed.message != unsigned.message {
        bail!("provider changed the transaction message")
    }
    let required = unsigned.message.header().num_required_signatures as usize;
    if signed.signatures.len() != required {
        bail!("wrong signature count")
    }
    let payload = unsigned.message.serialize();
    for (index, signature) in signed.signatures.iter().enumerate() {
        if !signature.verify(
            unsigned.message.static_account_keys()[index].as_ref(),
            &payload,
        ) {
            bail!("invalid provider output signature at index {index}");
        }
        if unsigned.signatures[index] != Signature::default()
            && unsigned.signatures[index] != *signature
        {
            bail!("provider replaced an existing signature");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_keypair::Keypair;

    #[test]
    fn provider_output_must_preserve_message_and_authorize_every_signer() {
        let payer = Keypair::new();
        let owner = Keypair::new();
        let instruction =
            solana_system_interface::instruction::transfer(&owner.pubkey(), &payer.pubkey(), 1);
        let signed = v1::compile_and_sign(
            &[instruction],
            &payer,
            &[&owner],
            Default::default(),
            TransactionConfig::empty(),
        )
        .unwrap();
        let mut unsigned = signed.clone();
        unsigned.signatures[1] = Signature::default();
        validate_signed(&unsigned, &v1::serialize(&signed).unwrap()).unwrap();
        assert!(validate_signed(&unsigned, &v1::serialize(&unsigned).unwrap()).is_err());
        let mut changed = signed.clone();
        if let VersionedMessage::V1(message) = &mut changed.message {
            message.instructions[0].data.push(0);
        }
        assert!(validate_signed(&unsigned, &v1::serialize(&changed).unwrap()).is_err());
        let mut wrong = signed;
        wrong.signatures[1] = payer.sign_message(&wrong.message.serialize());
        assert!(validate_signed(&unsigned, &v1::serialize(&wrong).unwrap()).is_err());
        assert!(validate_signed(&unsigned, &[0; 4097]).is_err());
    }
}
