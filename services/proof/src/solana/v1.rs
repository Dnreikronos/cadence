use crate::error::AppError;
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_instruction_v1::{AccountMeta, Instruction as V1Instruction};
use solana_message::{v1, VersionedMessage};
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;

/// v1 has no implicit compute or loaded-account budget. Set both centrally.
const BUDGET: v1::TransactionConfig = v1::TransactionConfig::empty()
    .with_compute_unit_limit(400_000)
    .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);

pub fn compile_unsigned(
    instructions: &[Instruction],
    payer: &Address,
    blockhash: Hash,
) -> Result<VersionedTransaction, AppError> {
    let instructions: Vec<_> = instructions
        .iter()
        .map(|ix| V1Instruction {
            program_id: ix.program_id,
            accounts: ix
                .accounts
                .iter()
                .map(|meta| AccountMeta {
                    pubkey: meta.pubkey,
                    is_signer: meta.is_signer,
                    is_writable: meta.is_writable,
                })
                .collect(),
            data: ix.data.clone(),
        })
        .collect();
    let message = v1::Message::try_compile_with_config(payer, &instructions, blockhash, BUDGET)
        .map_err(|_| AppError::Transaction("cannot compile v1 message"))?;
    let signatures = vec![Signature::default(); message.header.num_required_signatures as usize];
    let transaction = VersionedTransaction {
        signatures,
        message: VersionedMessage::V1(message),
    };
    serialize(&transaction)?;
    Ok(transaction)
}

pub fn serialize(transaction: &VersionedTransaction) -> Result<Vec<u8>, AppError> {
    let bytes = wincode::serialize(transaction)
        .map_err(|_| AppError::Transaction("cannot serialize v1 transaction"))?;
    if bytes.len() > 4096 {
        return Err(AppError::Transaction(
            "transaction exceeds the v1 4096-byte limit",
        ));
    }
    Ok(bytes)
}
