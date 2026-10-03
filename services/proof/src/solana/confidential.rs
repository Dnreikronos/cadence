//! Unsigned, atomic confidential transfers. Callers supply fresh, trusted chain snapshots.
use super::v1;
use crate::keys::{elgamal::ViewingKey, vault};
use sha2::{Digest, Sha256};
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_elgamal_proof_interface::{
    instruction::{close_context_state, ContextStateInfo, ProofInstruction},
    proof_data::{
        BatchedGroupedCiphertext3HandlesValidityProofContext, BatchedRangeProofContext,
        CiphertextCommitmentEqualityProofContext,
    },
    state::ProofContextState,
};
use solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalPubkey};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{self, ConfidentialTransferAccount, ConfidentialTransferMint},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::{Account, AccountState, Mint},
};
use spl_token_client::zk_proofs::confidential_transfer::TransferAccountInfo;
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

pub const MAX_TRANSFER_AMOUNT: u64 = (1 << 48) - 1;
pub const CONTEXT_SIZES: [usize; 3] = [
    size_of::<ProofContextState<CiphertextCommitmentEqualityProofContext>>(),
    size_of::<ProofContextState<BatchedGroupedCiphertext3HandlesValidityProofContext>>(),
    size_of::<ProofContextState<BatchedRangeProofContext>>(),
];

/// AES key and amount are transient. Intentionally has no formatting/serialization traits.
/// Rent quotes correspond to CONTEXT_SIZES in equality, validity, range order.
pub struct Transfer<'a> {
    pub mint: Address,
    pub sender: Address,
    pub recipient: Address,
    pub wallet: Address,
    pub mint_account: &'a RpcAccount,
    pub sender_account: &'a RpcAccount,
    pub recipient_account: &'a RpcAccount,
    pub amount: u64,
    pub aes_key: &'a AeKey,
    pub blockhash: Hash,
    pub context_rent: [u64; 3],
}

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("invalid confidential transfer: {0}")]
    Invalid(&'static str),
    #[error("confidential transfer proof generation failed")]
    ProofGeneration,
    #[error(transparent)]
    KeyStore(#[from] vault::KeyStoreError),
    #[error(transparent)]
    Transaction(#[from] crate::error::AppError),
}

/// Use an autocommit key-service connection. Actor comes from authenticated context.
/// Authorization for wallet/account access belongs to the caller.
pub async fn load_and_build(
    client: &tokio_postgres::Client,
    transfer: &Transfer<'_>,
    actor: &str,
) -> Result<VersionedTransaction, TransferError> {
    let key = vault::load(
        client,
        &transfer.wallet,
        &transfer.sender,
        actor,
        "generate confidential transfer proofs",
    )
    .await?;
    build(transfer, &key)
}

/// Pure builder over a previously loaded key. Only the wallet signs the result.
pub fn build(
    transfer: &Transfer<'_>,
    key: &ViewingKey,
) -> Result<VersionedTransaction, TransferError> {
    let (source, destination, auditor) = validate(transfer, key)?;
    let account_info = TransferAccountInfo::new(&source);
    let proofs = key
        .with_keypair(|keypair| {
            account_info.generate_split_transfer_proof_data(
                transfer.amount,
                keypair,
                transfer.aes_key,
                &destination,
                auditor.as_ref(),
            )
        })
        .map_err(|_| TransferError::ProofGeneration)?;
    let balance = account_info
        .new_decryptable_available_balance(transfer.amount, transfer.aes_key)
        .map_err(|_| TransferError::ProofGeneration)?
        .into();
    let validity = &proofs.ciphertext_validity_proof_data_with_ciphertext;
    let mut instructions = Vec::with_capacity(10);
    let mut contexts = Vec::with_capacity(3);
    for (index, (kind, data)) in [
        (
            ProofInstruction::VerifyCiphertextCommitmentEquality,
            bytemuck::bytes_of(&proofs.equality_proof_data),
        ),
        (
            ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity,
            bytemuck::bytes_of(&validity.proof_data),
        ),
        (
            ProofInstruction::VerifyBatchedRangeProofU128,
            bytemuck::bytes_of(&proofs.range_proof_data),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        // Hash public randomized proof bytes, never a plaintext amount or secret key.
        let digest = Sha256::digest(data);
        let seed: String = digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let context = Address::create_with_seed(
            &transfer.wallet,
            &seed,
            &solana_zk_elgamal_proof_interface::ID,
        )
        .map_err(|_| TransferError::Invalid("invalid context address"))?;
        instructions.push(
            solana_system_interface::instruction::create_account_with_seed(
                &transfer.wallet,
                &context,
                &transfer.wallet,
                &seed,
                transfer.context_rent[index],
                CONTEXT_SIZES[index] as u64,
                &solana_zk_elgamal_proof_interface::ID,
            ),
        );
        let info = Some(ContextStateInfo {
            context_state_account: &context,
            context_state_authority: &transfer.wallet,
        });
        instructions.push(match kind {
            ProofInstruction::VerifyCiphertextCommitmentEquality => {
                kind.encode_verify_proof(info, &proofs.equality_proof_data)
            }
            ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity => {
                kind.encode_verify_proof(info, &validity.proof_data)
            }
            _ => kind.encode_verify_proof(info, &proofs.range_proof_data),
        });
        contexts.push(context);
    }
    instructions.extend(
        confidential_transfer::instruction::transfer(
            &spl_token_2022_interface::ID,
            &transfer.sender,
            &transfer.mint,
            &transfer.recipient,
            &balance,
            &validity.ciphertext_lo,
            &validity.ciphertext_hi,
            &transfer.wallet,
            &[],
            ProofLocation::ContextStateAccount(&contexts[0]),
            ProofLocation::ContextStateAccount(&contexts[1]),
            ProofLocation::ContextStateAccount(&contexts[2]),
        )
        .map_err(|_| TransferError::Invalid("cannot encode transfer"))?,
    );
    instructions.extend(contexts.iter().map(|context| {
        close_context_state(
            ContextStateInfo {
                context_state_account: context,
                context_state_authority: &transfer.wallet,
            },
            &transfer.wallet,
        )
    }));
    compile(&instructions, &transfer.wallet, transfer.blockhash)
}

fn compile(
    instructions: &[Instruction],
    wallet: &Address,
    blockhash: Hash,
) -> Result<VersionedTransaction, TransferError> {
    let transaction = v1::compile_unsigned(instructions, wallet, blockhash)?;
    if v1::serialize(&transaction)?.len() >= 4096 {
        return Err(TransferError::Invalid(
            "transaction must be below 4096 bytes",
        ));
    }
    Ok(transaction)
}

fn validate(
    transfer: &Transfer<'_>,
    key: &ViewingKey,
) -> Result<
    (
        ConfidentialTransferAccount,
        ElGamalPubkey,
        Option<ElGamalPubkey>,
    ),
    TransferError,
> {
    let invalid = || TransferError::Invalid("invalid account or mint state");
    if transfer.amount == 0 || transfer.amount > MAX_TRANSFER_AMOUNT {
        return Err(TransferError::Invalid("amount outside supported range"));
    }
    if transfer.sender == transfer.recipient || transfer.context_rent.contains(&0) {
        return Err(invalid());
    }
    for account in [
        transfer.mint_account,
        transfer.sender_account,
        transfer.recipient_account,
    ] {
        if account.owner != spl_token_2022_interface::ID || account.executable {
            return Err(invalid());
        }
    }
    let mint =
        StateWithExtensions::<Mint>::unpack(&transfer.mint_account.data).map_err(|_| invalid())?;
    if mint
        .get_extension_types()
        .map_err(|_| invalid())?
        .iter()
        .any(|extension| {
            matches!(
                extension,
                ExtensionType::TransferFeeConfig | ExtensionType::TransferHook
            )
        })
    {
        return Err(TransferError::Invalid("unsupported mint extension"));
    }
    let mint_config = mint
        .get_extension::<ConfidentialTransferMint>()
        .map_err(|_| invalid())?;
    let auditor = Option::<solana_zk_sdk_pod::encryption::elgamal::PodElGamalPubkey>::from(
        mint_config.auditor_elgamal_pubkey,
    )
    .map(ElGamalPubkey::try_from)
    .transpose()
    .map_err(|_| invalid())?;
    let sender = StateWithExtensions::<Account>::unpack(&transfer.sender_account.data)
        .map_err(|_| invalid())?;
    let recipient = StateWithExtensions::<Account>::unpack(&transfer.recipient_account.data)
        .map_err(|_| invalid())?;
    if sender.base.mint != transfer.mint
        || recipient.base.mint != transfer.mint
        || sender.base.owner != transfer.wallet
        || sender.base.state != AccountState::Initialized
        || recipient.base.state != AccountState::Initialized
    {
        return Err(invalid());
    }
    let source = sender
        .get_extension::<ConfidentialTransferAccount>()
        .map_err(|_| invalid())?;
    let destination = recipient
        .get_extension::<ConfidentialTransferAccount>()
        .map_err(|_| invalid())?;
    source.valid_as_source().map_err(|_| invalid())?;
    destination.valid_as_destination().map_err(|_| invalid())?;
    if source.elgamal_pubkey != key.public_key().into() {
        return Err(TransferError::Invalid("sender viewing key mismatch"));
    }
    let destination_key =
        ElGamalPubkey::try_from(destination.elgamal_pubkey).map_err(|_| invalid())?;
    Ok((*source, destination_key, auditor))
}
