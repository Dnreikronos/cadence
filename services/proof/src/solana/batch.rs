use super::confidential::{self, Transfer, TransferError};
use crate::keys::elgamal::ViewingKey;
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_message::VersionedMessage;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_elgamal_proof_interface::proof_data::CiphertextCommitmentEqualityProofData;
use solana_zk_sdk_pod::encryption::{
    auth_encryption::PodAeCiphertext, elgamal::PodElGamalCiphertext,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{
            instruction::TransferInstructionData, ConfidentialTransferAccount,
        },
        BaseStateWithExtensionsMut, StateWithExtensionsMut,
    },
    state::Account,
};

pub struct Payment {
    pub recipient: Address,
    pub account: Option<RpcAccount>,
    pub amount: u64,
}

/// Advance only successful preparations. The returned transactions must execute in order.
pub fn build(
    template: &Transfer<'_>,
    payments: &[Payment],
    key: &ViewingKey,
) -> Vec<Result<VersionedTransaction, TransferError>> {
    let mut sender = template.sender_account.clone();
    payments
        .iter()
        .map(|payment| {
            let recipient = payment
                .account
                .as_ref()
                .ok_or(TransferError::Invalid("recipient account missing"))?;
            let tx = confidential::build(
                &Transfer {
                    recipient: payment.recipient,
                    recipient_account: recipient,
                    sender_account: &sender,
                    amount: payment.amount,
                    mint: template.mint,
                    sender: template.sender,
                    wallet: template.wallet,
                    mint_account: template.mint_account,
                    aes_key: template.aes_key,
                    blockhash: template.blockhash,
                    context_rent: template.context_rent,
                },
                key,
            )?;
            let (elgamal, aes) = resulting_balance(&tx)?;
            let mut account = StateWithExtensionsMut::<Account>::unpack(&mut sender.data)
                .map_err(|_| TransferError::Invalid("invalid sender account"))?;
            let config = account
                .get_extension_mut::<ConfidentialTransferAccount>()
                .map_err(|_| TransferError::Invalid("invalid sender account"))?;
            config.available_balance = elgamal;
            config.decryptable_available_balance = aes;
            Ok(tx)
        })
        .collect()
}

/// Decode the two exact ciphertexts written by the existing atomic builder.
pub fn resulting_balance(
    tx: &VersionedTransaction,
) -> Result<(PodElGamalCiphertext, PodAeCiphertext), TransferError> {
    let invalid = || TransferError::Invalid("invalid prepared transfer");
    let VersionedMessage::V1(message) = &tx.message else {
        return Err(invalid());
    };
    let equality = message.instructions.get(1).ok_or_else(invalid)?;
    let transfer = message.instructions.get(6).ok_or_else(invalid)?;
    let equality: CiphertextCommitmentEqualityProofData =
        bytemuck::try_pod_read_unaligned(equality.data.get(1..).ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
    let transfer: TransferInstructionData =
        bytemuck::try_pod_read_unaligned(transfer.data.get(2..).ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
    Ok((
        equality.context.ciphertext,
        transfer.new_source_decryptable_available_balance,
    ))
}
