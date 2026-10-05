use crate::{
    balances::Balances,
    chain::ConfidentialAccount,
    rpc::{JsonRpc, Transient},
    DEVNET, FUND, ORDINARY, PAYMENT,
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use solana_address::Address;
use solana_keypair::Keypair;
use std::{path::Path, str::FromStr, time::Duration};

pub fn restore(value: &Value) -> Result<ConfidentialAccount> {
    let token: Vec<u8> = serde_json::from_value(value["token_account_keypair"].clone())?;
    let aes: [u8; 16] = serde_json::from_value(value["aes_key"].clone())?;
    Ok(ConfidentialAccount {
        token: Keypair::try_from(token.as_slice())?,
        owner: Address::from_str(value["owner"].as_str().context("missing owner")?)?,
        elgamal: serde_json::from_value(value["elgamal_keypair"].clone())?,
        aes: aes.into(),
    })
}

async fn balances(account: &ConfidentialAccount, rpc: &JsonRpc) -> Result<Balances> {
    for attempt in 0..6 {
        match account.balances(rpc).await {
            Err(error) if attempt < 5 && error.chain().any(|cause| cause.is::<Transient>()) => {
                tokio::time::sleep(Duration::from_secs(5 * (attempt + 1))).await;
            }
            result => return result,
        }
    }
    unreachable!()
}

/// Recheck an already submitted payment; never load a payer or send a transaction.
pub async fn verify_run(run: &Path) -> Result<()> {
    let mut evidence: Value = serde_json::from_slice(&std::fs::read(run.join("evidence.json"))?)?;
    let secrets: Value = serde_json::from_slice(&std::fs::read(run.join("secrets.json"))?)?;
    let rpc = JsonRpc::new(
        evidence["verification_rpc"]
            .as_str()
            .context("missing verification RPC")?,
    );
    ensure!(
        rpc.call("getGenesisHash", json!([])).await?.as_str() == Some(DEVNET),
        "requires devnet"
    );
    let sender = restore(&secrets["sender"])?;
    let recipient = restore(&secrets["recipient"])?;
    let signature = evidence["events"]
        .as_array()
        .context("missing events")?
        .iter()
        .find(|event| event["step"] == "confidential vault transfer")
        .context("no confirmed confidential payment")?["signature"]
        .as_str()
        .context("missing signature")?
        .to_string();
    let sender_balance = balances(&sender, &rpc).await?.available(&sender.aes)?;
    let recipient_balance = balances(&recipient, &rpc)
        .await?
        .pending(recipient.elgamal.secret())?;
    ensure!(
        sender_balance == FUND - ORDINARY - PAYMENT && recipient_balance == PAYMENT,
        "balance mismatch"
    );
    let tx = rpc.get_transaction(&signature).await?;
    ensure!(
        tx["meta"]["err"].is_null() && tx["version"] == 1,
        "not a confirmed v1 payment"
    );
    let event = json!({"step": "independent verification", "signature": signature, "slot": tx["slot"],
        "version": tx["version"], "sender_available_units": sender_balance,
        "recipient_pending_units": recipient_balance, "recipient_public_units": ORDINARY, "payment_units": PAYMENT});
    println!("{event}");
    let events = evidence["events"].as_array_mut().unwrap();
    events.retain(|event| event["step"] != "independent verification");
    events.push(event);
    evidence["verdict"] = json!("direct confidential vault payment confirmed");
    std::fs::write(
        run.join("evidence.json"),
        serde_json::to_vec_pretty(&evidence)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_signer::Signer;

    #[test]
    fn independent_keys_survive_the_private_checkpoint() -> Result<()> {
        let original = ConfidentialAccount::new(Keypair::new().pubkey());
        let restored = restore(&original.secrets())?;
        assert_eq!(restored.owner, original.owner);
        assert_eq!(restored.token.pubkey(), original.token.pubkey());
        assert_eq!(restored.elgamal.pubkey(), original.elgamal.pubkey());
        assert_eq!(
            restored.aes.decrypt(&original.aes.encrypt(PAYMENT)),
            Some(PAYMENT)
        );
        Ok(())
    }
}
