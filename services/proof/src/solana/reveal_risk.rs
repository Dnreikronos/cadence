use crate::{error::AppError, keys::elgamal::ViewingKey};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use solana_address::Address;
use solana_message::VersionedMessage;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_elgamal_proof_interface::{
    instruction::ProofInstruction, proof_data::BatchedGroupedCiphertext3HandlesValidityProofData,
};
use solana_zk_sdk::encryption::elgamal::ElGamalCiphertext;
use spl_token_2022_interface::{
    extension::confidential_transfer::instruction::ConfidentialTransferInstruction,
    instruction::TokenInstruction,
};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    None,
    Near,
    Exact,
}

#[derive(Clone, Debug, Serialize)]
pub struct Match {
    pub payment_id: String,
    pub paid_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RevealRisk {
    pub level: Level,
    pub matches: Vec<Match>,
}

pub struct Received {
    pub payment: Match,
    pub amount: Zeroizing<u64>,
}

pub fn tolerance(value: Option<String>) -> Result<u16, AppError> {
    value
        .unwrap_or_else(|| "100".into())
        .parse::<u16>()
        .ok()
        .filter(|value| *value <= 10000)
        .ok_or(AppError::Config(
            "PROOF_REVEAL_RISK_TOLERANCE_BPS must be in 0..=10000",
        ))
}

pub fn check(withdrawal: u64, received: &[Received], tolerance_bps: u16) -> RevealRisk {
    let mut level = Level::None;
    let mut matches = Vec::new();
    for received in received {
        let amount = *received.amount;
        if amount == 0 {
            continue;
        }
        let exact = withdrawal == amount;
        let near = u128::from(withdrawal.abs_diff(amount)) * 10000
            <= u128::from(amount) * u128::from(tolerance_bps);
        if exact || near {
            if exact {
                level = Level::Exact;
            } else if level == Level::None {
                level = Level::Near;
            }
            matches.push(received.payment.clone());
        }
    }
    RevealRisk { level, matches }
}

/// Decode only the recipient handle of the proof context tied to this transfer.
/// Receipts must already have successful finalized confirmation in trusted storage.
pub fn received_amount(
    encoded: &str,
    recipient: &Address,
    mint: &Address,
    key: &ViewingKey,
) -> Result<Zeroizing<u64>, AppError> {
    transfer_amount(encoded, recipient, mint, key, false)
}

/// Read the sender handle of a trusted finalized company-payment receipt.
pub fn sent_amount(
    encoded: &str,
    sender: &Address,
    mint: &Address,
    key: &ViewingKey,
) -> Result<Zeroizing<u64>, AppError> {
    transfer_amount(encoded, sender, mint, key, true)
}

/// Select sender handle 0 or recipient handle 1 after checking account, mint and proof context.
/// The receipt must already be finalized; the selected proof public key must match `key`.
fn transfer_amount(
    encoded: &str,
    account: &Address,
    mint: &Address,
    key: &ViewingKey,
    sender: bool,
) -> Result<Zeroizing<u64>, AppError> {
    let invalid = || AppError::TransferUnavailable("reveal_history_unavailable");
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
    let tx: VersionedTransaction = wincode::deserialize(&bytes).map_err(|_| invalid())?;
    let VersionedMessage::V1(message) = tx.message else {
        return Err(invalid());
    };
    let address = |index: u8| message.account_keys.get(usize::from(index));
    let transfers: Vec<_> = message
        .instructions
        .iter()
        .filter(|ix| {
            address(ix.program_id_index) == Some(&spl_token_2022_interface::ID)
                && matches!(
                    TokenInstruction::unpack(&ix.data),
                    Ok(TokenInstruction::ConfidentialTransferExtension)
                )
                && ix.data.get(1) == Some(&(ConfidentialTransferInstruction::Transfer as u8))
        })
        .collect();
    if transfers.len() != 1 {
        return Err(invalid());
    }
    let transfer = transfers[0];
    if transfer.accounts.get(1).and_then(|i| address(*i)) != Some(mint)
        || transfer
            .accounts
            .get(if sender { 0 } else { 2 })
            .and_then(|i| address(*i))
            != Some(account)
    {
        return Err(invalid());
    }
    let context = transfer
        .accounts
        .get(4)
        .and_then(|i| address(*i))
        .ok_or_else(invalid)?;
    let mut proofs = message.instructions.iter().filter(|ix| {
        address(ix.program_id_index) == Some(&solana_zk_elgamal_proof_interface::ID)
            && ix.data.first()
                == Some(&(ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity as u8))
            && ix.accounts.first().and_then(|i| address(*i)) == Some(context)
    });
    let proof = proofs.next().ok_or_else(invalid)?;
    if proofs.next().is_some() {
        return Err(invalid());
    }
    let proof: BatchedGroupedCiphertext3HandlesValidityProofData =
        bytemuck::try_pod_read_unaligned(&proof.data[1..]).map_err(|_| invalid())?;
    let public_key = if sender {
        proof.context.first_pubkey
    } else {
        proof.context.second_pubkey
    };
    if public_key != key.public_key().into() {
        return Err(invalid());
    }
    let lo: ElGamalCiphertext = proof
        .context
        .grouped_ciphertext_lo
        .try_extract_ciphertext(usize::from(!sender))
        .map_err(|_| invalid())?
        .try_into()
        .map_err(|_| invalid())?;
    let hi: ElGamalCiphertext = proof
        .context
        .grouped_ciphertext_hi
        .try_extract_ciphertext(usize::from(!sender))
        .map_err(|_| invalid())?
        .try_into()
        .map_err(|_| invalid())?;
    key.with_keypair(|pair| {
        let lo = Zeroizing::new(lo.decrypt_u32(pair.secret()).ok_or_else(invalid)?);
        let hi = Zeroizing::new(hi.decrypt_u32(pair.secret()).ok_or_else(invalid)?);
        if *lo > u16::MAX.into() {
            return Err(invalid());
        }
        Ok(Zeroizing::new(*lo + (*hi << 16)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payment(amount: u64) -> Received {
        Received {
            payment: Match {
                payment_id: "payment".into(),
                paid_at: "date".into(),
            },
            amount: Zeroizing::new(amount),
        }
    }
    #[test]
    fn exact_near_safe_and_inclusive_boundaries() {
        let received = [payment(1_000_000)];
        for (amount, level) in [
            (1_000_000, Level::Exact),
            (990_000, Level::Near),
            (1_010_000, Level::Near),
            (989_999, Level::None),
            (1_010_001, Level::None),
        ] {
            let risk = check(amount, &received, 100);
            assert_eq!(risk.level, level);
            assert_eq!(risk.matches.len(), usize::from(level != Level::None));
            let json = serde_json::to_string(&risk).unwrap();
            assert!(!json.contains("amount"));
        }
    }
    #[test]
    fn exact_precedes_near_and_arithmetic_cannot_overflow() {
        assert_eq!(
            check(100, &[payment(101), payment(100)], 100).level,
            Level::Exact
        );
        assert_eq!(
            check(u64::MAX, &[payment(u64::MAX - 1)], 100).level,
            Level::Near
        );
        assert_eq!(check(0, &[payment(u64::MAX)], 100).level, Level::None);
        assert_eq!(check(99, &[payment(100)], 0).level, Level::None);
        assert_eq!(check(0, &[payment(0)], 10000).level, Level::None);
    }
    #[test]
    fn tolerance_is_bounded_and_configurable() {
        assert_eq!(tolerance(None).unwrap(), 100);
        assert_eq!(tolerance(Some("0".into())).unwrap(), 0);
        assert_eq!(tolerance(Some("10000".into())).unwrap(), 10000);
        for value in ["10001", "-1", "secret"] {
            assert!(tolerance(Some(value.into())).is_err());
        }
    }
}
