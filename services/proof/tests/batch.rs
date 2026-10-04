#[path = "support/confidential.rs"]
mod fixture;

use cadence_proof::solana::batch::{self, Payment};
use fixture::{Fixture, BALANCE};
use solana_address::Address;
use solana_zk_sdk::encryption::{auth_encryption::AeCiphertext, elgamal::ElGamalCiphertext};

#[test]
fn three_payments_use_the_exact_preceding_ciphertexts() {
    let fixture = Fixture::new();
    let payments: Vec<_> = (0..3)
        .map(|i| Payment {
            recipient: Address::new_from_array([10 + i; 32]),
            account: Some(fixture.recipient.clone()),
            amount: 1_000_000,
        })
        .collect();
    let transactions = batch::build(&fixture.transfer(), &payments, &fixture.key);
    use spl_token_2022_interface::extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions,
        StateWithExtensions,
    };
    let source = StateWithExtensions::<spl_token_2022_interface::state::Account>::unpack(
        &fixture.sender.data,
    )
    .unwrap();
    let mut preceding: ElGamalCiphertext = source
        .get_extension::<ConfidentialTransferAccount>()
        .unwrap()
        .available_balance
        .try_into()
        .unwrap();
    for (i, tx) in transactions.into_iter().enumerate() {
        let tx = tx.unwrap();
        let solana_message::VersionedMessage::V1(message) = &tx.message else {
            panic!("expected v1")
        };
        use solana_zk_sdk::zk_elgamal_proof_program::VerifyZkProof;
        let proof: solana_zk_elgamal_proof_interface::proof_data::BatchedGroupedCiphertext3HandlesValidityProofData =
            bytemuck::pod_read_unaligned(&message.instructions[3].data[1..]);
        proof.verify_proof().unwrap();
        let equality:solana_zk_elgamal_proof_interface::proof_data::CiphertextCommitmentEqualityProofData=bytemuck::pod_read_unaligned(&message.instructions[1].data[1..]);
        let range: solana_zk_elgamal_proof_interface::proof_data::BatchedRangeProofU128Data =
            bytemuck::pod_read_unaligned(&message.instructions[5].data[1..]);
        equality.verify_proof().unwrap();
        range.verify_proof().unwrap();
        spl_token_confidential_transfer_proof_extraction::transfer::TransferProofContext::verify_and_extract(&equality.context,&proof.context,&range.context).unwrap();
        let lo: ElGamalCiphertext = proof
            .context
            .grouped_ciphertext_lo
            .try_extract_ciphertext(1)
            .unwrap()
            .try_into()
            .unwrap();
        let hi: ElGamalCiphertext = proof
            .context
            .grouped_ciphertext_hi
            .try_extract_ciphertext(1)
            .unwrap()
            .try_into()
            .unwrap();
        assert!(
            lo.decrypt_u32(fixture.recipient_key.secret()).unwrap()
                + (hi.decrypt_u32(fixture.recipient_key.secret()).unwrap() << 16)
                == 1_000_000
        );
        let (elgamal, aes) = batch::resulting_balance(&tx).unwrap();
        let elgamal: ElGamalCiphertext = elgamal.try_into().unwrap();
        let sender_lo: ElGamalCiphertext = proof
            .context
            .grouped_ciphertext_lo
            .try_extract_ciphertext(0)
            .unwrap()
            .try_into()
            .unwrap();
        let sender_hi: ElGamalCiphertext = proof
            .context
            .grouped_ciphertext_hi
            .try_extract_ciphertext(0)
            .unwrap()
            .try_into()
            .unwrap();
        assert!(elgamal == preceding - (sender_lo + sender_hi * (1u64 << 16)));
        preceding = elgamal;
        let aes: AeCiphertext = aes.try_into().unwrap();
        let expected = BALANCE - (i as u64 + 1) * 1_000_000;
        fixture.key.with_keypair(|key| {
            assert!(elgamal.decrypt_u32(key.secret()) == Some(expected));
        });
        assert!(fixture.aes.decrypt(&aes) == Some(expected));
    }
}

#[test]
fn failed_preparation_does_not_debit_the_next_payment() {
    let fixture = Fixture::new();
    let payments = [
        Payment {
            recipient: Address::new_from_array([10; 32]),
            account: None,
            amount: 1_000_000,
        },
        Payment {
            recipient: Address::new_from_array([11; 32]),
            account: Some(fixture.recipient.clone()),
            amount: BALANCE + 1,
        },
        Payment {
            recipient: Address::new_from_array([12; 32]),
            account: Some(fixture.recipient.clone()),
            amount: 1_000_000,
        },
    ];
    let transactions = batch::build(&fixture.transfer(), &payments, &fixture.key);
    assert!(transactions[0].is_err());
    assert!(transactions[1].is_err());
    let (_, aes) = batch::resulting_balance(transactions[2].as_ref().unwrap()).unwrap();
    let aes: AeCiphertext = aes.try_into().unwrap();
    assert!(fixture.aes.decrypt(&aes) == Some(BALANCE - 1_000_000));
}
