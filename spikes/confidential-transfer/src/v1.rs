//! Transaction v1 assembly.
//!
//! `spl-token-client` builds a legacy `Transaction`, which is capped at one
//! 1232-byte packet. A confidential transfer with its three proofs inline is
//! well past that, so the transfer instruction set is compiled here into a v1
//! message (SIMD-0296 / SIMD-0385, live at mainnet epoch 1035) instead.
//!
//! Two versions of `solana-instruction` are in the tree: Token-2022 emits 3.x
//! instructions, `solana-message` 5.x consumes 4.x. The structs are identical,
//! so `to_v1` is a field-for-field copy.

use {
    anyhow::{anyhow, Result},
    solana_hash::Hash,
    solana_instruction::Instruction as TokenInstruction,
    solana_instruction_v1::{AccountMeta as V1AccountMeta, Instruction as V1Instruction},
    solana_message::{v1, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

/// Copies a Token-2022 instruction into the crate version `solana-message` 5.x
/// compiles against.
pub fn to_v1(instruction: &TokenInstruction) -> V1Instruction {
    V1Instruction {
        program_id: instruction.program_id,
        accounts: instruction
            .accounts
            .iter()
            .map(|meta| V1AccountMeta {
                pubkey: meta.pubkey,
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: instruction.data.clone(),
    }
}

/// Compiles instructions into a signed v1 transaction.
///
/// v1 carries the budget in the message config rather than in `ComputeBudget`
/// instructions, which is why `config` is an argument instead of a pair of
/// prepended instructions.
///
/// Signing is done by hand rather than through `VersionedTransaction::try_new`
/// because the signers here are `solana-signer` 3.x — the version Token-2022
/// and the ZK SDK hand out — and `try_new` wants 4.x. The signed payload is
/// identical either way: the serialized message, version prefix included.
///
/// `signers` covers everyone *besides* the payer; the payer signs by virtue of
/// being the payer.
pub fn compile_and_sign(
    instructions: &[TokenInstruction],
    payer: &dyn Signer,
    signers: &[&dyn Signer],
    blockhash: Hash,
    config: v1::TransactionConfig,
) -> Result<VersionedTransaction> {
    let v1_instructions: Vec<_> = instructions.iter().map(to_v1).collect();

    let message =
        v1::Message::try_compile_with_config(&payer.pubkey(), &v1_instructions, blockhash, config)?;

    let required = message.header.num_required_signatures as usize;
    let signer_keys = message.account_keys[..required].to_vec();
    let message = VersionedMessage::V1(message);
    let payload = message.serialize();

    // The fee payer is always a required signature, so look it up alongside
    // `signers` rather than making every caller pass it twice.
    let signatures = signer_keys
        .iter()
        .map(|key| {
            std::iter::once(&payer)
                .chain(signers.iter())
                .find(|signer| signer.pubkey() == *key)
                .ok_or_else(|| anyhow!("no signer supplied for required signature {key}"))
                .map(|signer| signer.sign_message(&payload))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(VersionedTransaction {
        signatures,
        message,
    })
}

/// Wire-format bytes, as the RPC counts them against the 4096-byte cap.
pub fn serialize(transaction: &VersionedTransaction) -> Result<Vec<u8>> {
    wincode::serialize(transaction).map_err(|e| anyhow!("failed to serialize v1 transaction: {e}"))
}
