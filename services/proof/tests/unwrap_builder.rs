#[path = "support/confidential.rs"]
mod fixture;

use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    keys::elgamal::ViewingKey,
    solana::{
        confidential, reveal_risk,
        token_wrap::{Addresses, TOKEN_2022},
        unwrap, v1,
    },
};
use fixture::{Fixture, AMOUNT, BALANCE};
use solana_address::Address;
use solana_hash::Hash;
use solana_signer::Signer;
use solana_zk_elgamal_proof_interface::proof_data::{
    BatchedRangeProofU64Data, CiphertextCommitmentEqualityProofData,
};
use solana_zk_sdk::{
    encryption::auth_encryption::{AeCiphertext, AeKey},
    zk_elgamal_proof_program::VerifyZkProof,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{
            instruction::WithdrawInstructionData, ConfidentialTransferAccount,
        },
        BaseStateWithExtensions, BaseStateWithExtensionsMut, StateWithExtensions,
        StateWithExtensionsMut,
    },
    state::Account,
};

#[test]
fn atomic_withdrawal_has_valid_proofs_correct_balance_and_only_wallet_signer() {
    let f = Fixture::new();
    let state = StateWithExtensions::<Account>::unpack(&f.sender.data).unwrap();
    let config = state
        .get_extension::<ConfidentialTransferAccount>()
        .unwrap();
    let tx = unwrap::build(
        &f.wallet.pubkey(),
        config,
        AMOUNT,
        &f.aes,
        &f.key,
        Hash::default(),
    )
    .unwrap();
    assert_eq!(tx.signatures, vec![solana_signature::Signature::default()]);
    let solana_message::VersionedMessage::V1(message) = &tx.message else {
        panic!("expected v1")
    };
    assert_eq!(message.header.num_required_signatures, 1);
    assert_eq!(message.account_keys[0], f.wallet.pubkey());
    assert_eq!(message.instructions.len(), 5);
    assert!(v1::serialize(&tx).unwrap().len() < 4096);
    let ix = &message.instructions[1];
    assert_eq!(
        message.account_keys[ix.program_id_index as usize],
        TOKEN_2022
    );
    let data: WithdrawInstructionData = bytemuck::pod_read_unaligned(&ix.data[2..]);
    assert_eq!(u64::from(data.amount), AMOUNT);
    assert_eq!(data.decimals, 6);
    assert_eq!(
        (
            data.equality_proof_instruction_offset,
            data.range_proof_instruction_offset
        ),
        (1, 2)
    );
    let balance: AeCiphertext = data.new_decryptable_available_balance.try_into().unwrap();
    assert!(f.aes.decrypt(&balance) == Some(BALANCE - AMOUNT));
    let equality: CiphertextCommitmentEqualityProofData =
        bytemuck::pod_read_unaligned(&message.instructions[2].data[1..]);
    let range: BatchedRangeProofU64Data =
        bytemuck::pod_read_unaligned(&message.instructions[3].data[1..]);
    equality.verify_proof().unwrap();
    range.verify_proof().unwrap();
    let burn = &message.instructions[4];
    let addresses = Addresses::for_usdc();
    assert_eq!(
        message.account_keys[burn.program_id_index as usize],
        addresses.program
    );
    assert_eq!(burn.data[0], 2);
    assert_eq!(
        u64::from_le_bytes(burn.data[1..].try_into().unwrap()),
        AMOUNT
    );
    let expected = [
        addresses.escrow,
        unwrap::destination(&f.wallet.pubkey()),
        addresses.authority,
        addresses.unwrapped_mint,
        TOKEN_2022,
        addresses.unwrapped_token_program,
        unwrap::source(&f.wallet.pubkey()),
        addresses.wrapped_mint,
        f.wallet.pubkey(),
    ];
    assert_eq!(
        burn.accounts
            .iter()
            .map(|i| message.account_keys[*i as usize])
            .collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn invalid_balance_keys_amounts_and_accounts_fail_closed() {
    let f = Fixture::new();
    let state = StateWithExtensions::<Account>::unpack(&f.sender.data).unwrap();
    let config = state
        .get_extension::<ConfidentialTransferAccount>()
        .unwrap();
    for amount in [0, BALANCE + 1, u64::MAX] {
        assert!(unwrap::build(
            &f.wallet.pubkey(),
            config,
            amount,
            &f.aes,
            &f.key,
            Hash::default()
        )
        .is_err());
    }
    assert!(unwrap::build(
        &f.wallet.pubkey(),
        config,
        1,
        &AeKey::new_rand(),
        &f.key,
        Hash::default()
    )
    .is_err());
    let mut mismatch = *config;
    mismatch.elgamal_pubkey = f.recipient_key.pubkey_owned().into();
    assert!(unwrap::build(
        &f.wallet.pubkey(),
        &mismatch,
        1,
        &f.aes,
        &f.key,
        Hash::default()
    )
    .is_err());
    assert!(unwrap::validate_source(&f.sender, &Address::new_from_array([9; 32])).is_err());
}

#[test]
fn history_decrypts_the_bound_recipient_handle_and_rejects_corruption() {
    let mut f = Fixture::new();
    let recipient = f.transfer().recipient;
    let sig = f
        .wallet
        .sign_message(&ViewingKey::signing_message(&recipient));
    let receiver = ViewingKey::derive(&f.wallet.pubkey(), &recipient, &sig).unwrap();
    StateWithExtensionsMut::<Account>::unpack(&mut f.recipient.data)
        .unwrap()
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .elgamal_pubkey = receiver.public_key().into();
    let transfer = f.transfer();
    let tx = confidential::build(&transfer, &f.key).unwrap();
    let encoded = STANDARD.encode(v1::serialize(&tx).unwrap());
    assert!(
        *reveal_risk::received_amount(&encoded, &recipient, &transfer.mint, &receiver).unwrap()
            == AMOUNT
    );
    assert!(reveal_risk::received_amount(&encoded, &recipient, &transfer.mint, &f.key).is_err());
    assert!(
        reveal_risk::received_amount(&encoded, &transfer.sender, &transfer.mint, &receiver)
            .is_err()
    );
    assert!(reveal_risk::received_amount("secret", &recipient, &transfer.mint, &receiver).is_err());
    let mut damaged = tx;
    if let solana_message::VersionedMessage::V1(message) = &mut damaged.message {
        message.instructions[3].accounts.clear();
    }
    assert!(reveal_risk::received_amount(
        &STANDARD.encode(v1::serialize(&damaged).unwrap()),
        &recipient,
        &transfer.mint,
        &receiver
    )
    .is_err());
}
