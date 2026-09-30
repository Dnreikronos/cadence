use super::v1::{adapt_instructions, serialize};
use crate::error::AppError;
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_instruction_v1::Instruction as CompatibleInstruction;
use solana_message::{v0, VersionedMessage};
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;

const COMPUTE_BUDGET: Address =
    Address::from_str_const("ComputeBudget111111111111111111111111111111");

/// Wrap fits v0 without lookup tables. Prefixing budgets preserves relative proof offsets.
pub fn compile_unsigned(
    instructions: &[Instruction],
    payer: &Address,
    blockhash: Hash,
) -> Result<VersionedTransaction, AppError> {
    let mut compiled = Vec::with_capacity(instructions.len() + 2);
    for (tag, value) in [(2, 400_000u32), (4, 64 * 1024 * 1024)] {
        let mut data = vec![tag];
        data.extend_from_slice(&value.to_le_bytes());
        compiled.push(CompatibleInstruction {
            program_id: COMPUTE_BUDGET,
            accounts: vec![],
            data,
        });
    }
    compiled.extend(adapt_instructions(instructions));
    let message = v0::Message::try_compile(payer, &compiled, &[], blockhash)
        .map_err(|_| AppError::Transaction("cannot compile v0 message"))?;
    let transaction = VersionedTransaction {
        signatures: vec![Signature::default(); message.header.num_required_signatures as usize],
        message: VersionedMessage::V0(message),
    };
    serialize(&transaction)?;
    Ok(transaction)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v0_rejects_transactions_that_only_fit_v1() {
        let payer = Address::new_from_array([9; 32]);
        let instructions = [Instruction {
            program_id: Address::new_from_array([7; 32]),
            accounts: vec![],
            data: vec![0; 1300],
        }];
        assert!(compile_unsigned(&instructions, &payer, Hash::default()).is_err());
        assert!(super::super::v1::compile_unsigned(&instructions, &payer, Hash::default()).is_ok());
    }
}
