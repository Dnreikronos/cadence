#[path = "support/confidential.rs"]
mod fixture;

use cadence_proof::solana::{
    confidential::{self, TransferError},
    v1,
};
use fixture::{Fixture, AMOUNT, BALANCE};
use solana_address::Address;
use solana_message::VersionedMessage;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_zk_elgamal_proof_interface::{
    instruction::ProofInstruction,
    proof_data::{
        BatchedGroupedCiphertext3HandlesValidityProofData, BatchedRangeProofU128Data,
        CiphertextCommitmentEqualityProofData,
    },
};
use solana_zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalCiphertext, ElGamalKeypair},
    },
    zk_elgamal_proof_program::VerifyZkProof,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{
            instruction::TransferInstructionData, ConfidentialTransferAccount,
            ConfidentialTransferMint,
        },
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    },
    state::{Account, AccountState, Mint},
};
use spl_token_confidential_transfer_proof_extraction::transfer::TransferProofContext;

fn verified_context(
    transaction: &solana_transaction::versioned::VersionedTransaction,
) -> TransferProofContext {
    let VersionedMessage::V1(message) = &transaction.message else {
        panic!("expected v1")
    };
    let equality: CiphertextCommitmentEqualityProofData =
        bytemuck::pod_read_unaligned(&message.instructions[1].data[1..]);
    let validity: BatchedGroupedCiphertext3HandlesValidityProofData =
        bytemuck::pod_read_unaligned(&message.instructions[3].data[1..]);
    let range: BatchedRangeProofU128Data =
        bytemuck::pod_read_unaligned(&message.instructions[5].data[1..]);
    equality.verify_proof().unwrap();
    validity.verify_proof().unwrap();
    range.verify_proof().unwrap();
    let mut corrupted = equality;
    let bytes = bytemuck::bytes_of_mut(&mut corrupted);
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    assert!(corrupted.verify_proof().is_err());
    let mut mismatched = range.context;
    mismatched.commitments[0] = Default::default();
    assert!(TransferProofContext::verify_and_extract(
        &equality.context,
        &validity.context,
        &mismatched
    )
    .is_err());
    TransferProofContext::verify_and_extract(&equality.context, &validity.context, &range.context)
        .unwrap()
}

fn decrypted_amount(
    context: &TransferProofContext,
    index: usize,
    key: &ElGamalKeypair,
) -> Option<u64> {
    let lo: ElGamalCiphertext = context
        .ciphertext_lo
        .try_extract_ciphertext(index)
        .unwrap()
        .try_into()
        .unwrap();
    let hi: ElGamalCiphertext = context
        .ciphertext_hi
        .try_extract_ciphertext(index)
        .unwrap()
        .try_into()
        .unwrap();
    Some(lo.decrypt_u32(key.secret())? + (hi.decrypt_u32(key.secret())? << 16))
}

#[test]
fn proofs_transfer_and_closes_fit_one_wallet_signable_transaction() {
    let fixture = Fixture::new();
    let request = fixture.transfer();
    let mut transaction = confidential::build(&request, &fixture.key).unwrap();
    let context = verified_context(&transaction);
    assert!(decrypted_amount(&context, 1, &fixture.recipient_key) == Some(AMOUNT));
    fixture.key.with_keypair(|key| {
        assert!(decrypted_amount(&context, 0, key) == Some(AMOUNT));
        let balance: ElGamalCiphertext = context.new_source_ciphertext.try_into().unwrap();
        assert!(balance.decrypt_u32(key.secret()) == Some(BALANCE - AMOUNT));
    });
    let VersionedMessage::V1(message) = &transaction.message else {
        panic!("expected v1")
    };
    assert_eq!(message.instructions.len(), 10);
    assert_eq!(message.header.num_required_signatures, 1);
    assert_eq!(message.account_keys[0], fixture.wallet.pubkey());
    assert_eq!(transaction.signatures, vec![Signature::default()]);
    let transfer = &message.instructions[6];
    assert_eq!(
        message.account_keys[transfer.program_id_index as usize],
        spl_token_2022_interface::ID
    );
    let transfer_data: TransferInstructionData = bytemuck::pod_read_unaligned(&transfer.data[2..]);
    assert_eq!(&transfer.data[transfer.data.len() - 3..], &[0, 0, 0]);
    let balance: AeCiphertext = transfer_data
        .new_source_decryptable_available_balance
        .try_into()
        .unwrap();
    assert!(fixture.aes.decrypt(&balance) == Some(BALANCE - AMOUNT));
    let mut contexts = vec![];
    for (index, kind) in [
        ProofInstruction::VerifyCiphertextCommitmentEquality,
        ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity,
        ProofInstruction::VerifyBatchedRangeProofU128,
    ]
    .into_iter()
    .enumerate()
    {
        let create = &message.instructions[index * 2];
        assert_eq!(
            message.account_keys[create.program_id_index as usize],
            solana_system_interface::program::ID
        );
        let verify = &message.instructions[index * 2 + 1];
        assert_eq!(
            message.account_keys[verify.program_id_index as usize],
            solana_zk_elgamal_proof_interface::ID
        );
        assert_eq!(ProofInstruction::instruction_type(&verify.data), Some(kind));
        let context = message.account_keys[verify.accounts[0] as usize];
        assert!(!contexts.contains(&context));
        contexts.push(context);
        assert_eq!(message.account_keys[create.accounts[1] as usize], context);
        assert!(transfer
            .accounts
            .iter()
            .any(|account| message.account_keys[*account as usize] == context));
        let close = &message.instructions[7 + index];
        assert_eq!(
            message.account_keys[close.program_id_index as usize],
            solana_zk_elgamal_proof_interface::ID
        );
        assert_eq!(
            ProofInstruction::instruction_type(&close.data),
            Some(ProofInstruction::CloseContextState)
        );
        assert_eq!(message.account_keys[close.accounts[0] as usize], context);
        assert_eq!(
            message.account_keys[close.accounts[1] as usize],
            request.wallet
        );
        assert_eq!(
            message.account_keys[close.accounts[2] as usize],
            request.wallet
        );
    }
    let wire = v1::serialize(&transaction).unwrap();
    assert!(wire.len() > 1232 && wire.len() < 4096);
    assert_eq!(
        wincode::deserialize::<solana_transaction::versioned::VersionedTransaction>(&wire).unwrap(),
        transaction
    );
    transaction.signatures[0] = fixture
        .wallet
        .sign_message(&transaction.message.serialize());
    assert!(
        transaction.signatures[0].verify(request.wallet.as_ref(), &transaction.message.serialize())
    );
    assert_eq!(v1::serialize(&transaction).unwrap().len(), wire.len());
}

#[test]
fn auditor_key_comes_from_the_mint_and_can_decrypt_the_amount() {
    let mut fixture = Fixture::new();
    let auditor = ElGamalKeypair::new_rand();
    let mut mint = StateWithExtensionsMut::<Mint>::unpack(&mut fixture.mint.data).unwrap();
    mint.get_extension_mut::<ConfidentialTransferMint>()
        .unwrap()
        .auditor_elgamal_pubkey = Some((*auditor.pubkey()).into()).try_into().unwrap();
    let transaction = confidential::build(&fixture.transfer(), &fixture.key).unwrap();
    let context = verified_context(&transaction);
    assert!(decrypted_amount(&context, 2, &auditor) == Some(AMOUNT));
    assert_eq!(context.transfer_pubkeys.auditor, (*auditor.pubkey()).into());
}

#[test]
fn invalid_amounts_and_balance_keys_fail_without_sensitive_errors() {
    let fixture = Fixture::new();
    for amount in [0, BALANCE + 1, confidential::MAX_TRANSFER_AMOUNT + 1] {
        let mut request = fixture.transfer();
        request.amount = amount;
        let error = confidential::build(&request, &fixture.key).unwrap_err();
        assert!(!error.to_string().contains(&amount.to_string()));
        assert!(!format!("{error:?}").contains(&BALANCE.to_string()));
    }
    let wrong_key = AeKey::new_rand();
    let mut request = fixture.transfer();
    request.aes_key = &wrong_key;
    assert!(matches!(
        confidential::build(&request, &fixture.key),
        Err(TransferError::ProofGeneration)
    ));
}

#[test]
fn rejects_mismatched_unapproved_frozen_and_exhausted_accounts() {
    for case in 0..9 {
        let mut fixture = Fixture::new();
        match case {
            0 => fixture.sender.owner = solana_system_interface::program::ID,
            1 => fixture.recipient.data.clear(),
            2 => {
                let mut sender =
                    StateWithExtensionsMut::<Account>::unpack(&mut fixture.sender.data).unwrap();
                sender.base.owner = Address::new_from_array([8; 32]);
                sender.pack_base();
            }
            3 => {
                let mut sender =
                    StateWithExtensionsMut::<Account>::unpack(&mut fixture.sender.data).unwrap();
                sender
                    .get_extension_mut::<ConfidentialTransferAccount>()
                    .unwrap()
                    .elgamal_pubkey = (*ElGamalKeypair::new_rand().pubkey()).into();
            }
            4 => {
                let mut sender =
                    StateWithExtensionsMut::<Account>::unpack(&mut fixture.sender.data).unwrap();
                sender.base.state = AccountState::Frozen;
                sender.pack_base();
            }
            5 => {
                let mut recipient =
                    StateWithExtensionsMut::<Account>::unpack(&mut fixture.recipient.data).unwrap();
                recipient.base.mint = Address::new_from_array([8; 32]);
                recipient.pack_base();
            }
            _ => {
                let mut recipient =
                    StateWithExtensionsMut::<Account>::unpack(&mut fixture.recipient.data).unwrap();
                let config = recipient
                    .get_extension_mut::<ConfidentialTransferAccount>()
                    .unwrap();
                match case {
                    6 => config.approved = false.into(),
                    7 => config.allow_confidential_credits = false.into(),
                    _ => {
                        config.pending_balance_credit_counter =
                            config.maximum_pending_balance_credit_counter
                    }
                }
            }
        }
        assert!(
            confidential::build(&fixture.transfer(), &fixture.key).is_err(),
            "case {case}"
        );
    }
}

#[test]
fn rejects_mints_requiring_fees_or_extra_hook_accounts() {
    for extension in [
        ExtensionType::TransferFeeConfig,
        ExtensionType::TransferHook,
    ] {
        let mut fixture = Fixture::new();
        fixture.mint = fixture::mint(&[ExtensionType::ConfidentialTransferMint, extension]);
        assert!(matches!(
            confidential::build(&fixture.transfer(), &fixture.key),
            Err(TransferError::Invalid("unsupported mint extension"))
        ));
    }
}

#[test]
fn rejects_a_stale_aes_balance_even_when_it_decrypts_with_the_correct_key() {
    let mut fixture = Fixture::new();
    let mut sender = StateWithExtensionsMut::<Account>::unpack(&mut fixture.sender.data).unwrap();
    sender
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .decryptable_available_balance = fixture.aes.encrypt(BALANCE + 1).into();
    assert!(matches!(
        confidential::build(&fixture.transfer(), &fixture.key),
        Err(TransferError::ProofGeneration)
    ));
}
