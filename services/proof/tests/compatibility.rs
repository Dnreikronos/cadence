mod support;

use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::{token_client, v1};
use serde_json::json;
use solana_address::Address;
use solana_hash::Hash;
use solana_message::VersionedMessage;
use solana_signature::Signature;
use solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair};
use spl_token_2022_interface::{
    extension::{confidential_transfer::ConfidentialTransferAccount, StateWithExtensionsMut},
    state::Mint,
};
use spl_token_client::zk_proofs::confidential_transfer::TransferAccountInfo;
use support::MockRpc;

#[tokio::test]
async fn patched_client_builds_inline_proofs_for_unsigned_v1() {
    let payer = Address::new_from_array([1; 32]);
    let mint = Address::new_from_array([2; 32]);
    let source = Address::new_from_array([3; 32]);
    let destination = Address::new_from_array([4; 32]);
    let mut data = vec![0; 82];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
    state.base = Mint {
        decimals: 6,
        is_initialized: true,
        ..Mint::default()
    };
    state.pack_base();
    let rpc = MockRpc::start(json!({"jsonrpc":"2.0","id":1,"result":{"value":{
        "owner":spl_token_2022_interface::ID.to_string(), "data":[STANDARD.encode(data),"base64"],
        "lamports":1, "executable":false, "rentEpoch":0
    }}}))
    .await;
    let sender_keys = ElGamalKeypair::new_rand();
    let recipient_keys = ElGamalKeypair::new_rand();
    let aes_key = AeKey::new_rand();
    let account = ConfidentialTransferAccount {
        available_balance: sender_keys.pubkey().encrypt(10_000_000_u64).into(),
        decryptable_available_balance: aes_key.encrypt(10_000_000).into(),
        ..ConfidentialTransferAccount::default()
    };
    let token = token_client::token(rpc.client.clone(), mint, payer);
    let instructions = token
        .confidential_transfer_transfer_instructions(
            &source,
            &destination,
            &payer,
            None,
            None,
            None,
            4_200_000,
            Some(TransferAccountInfo::new(&account)),
            &sender_keys,
            &aes_key,
            recipient_keys.pubkey(),
            None,
            &[payer],
        )
        .await
        .unwrap();

    assert_eq!(instructions.len(), 4);
    assert_eq!(instructions[0].program_id, spl_token_2022_interface::ID);
    assert_eq!(
        &instructions[0].data[instructions[0].data.len() - 3..],
        &[1, 2, 3]
    );
    assert!(instructions[1..].iter().all(|ix| ix.program_id
        == Address::from_str_const("ZkE1Gama1Proof11111111111111111111111111111")));
    let transaction =
        v1::compile_unsigned(&instructions, &payer, Hash::new_from_array([5; 32])).unwrap();
    let VersionedMessage::V1(message) = &transaction.message else {
        panic!("expected v1")
    };
    assert_eq!(message.instructions.len(), 4);
    assert_eq!(transaction.signatures, vec![Signature::default()]);
    let wire = v1::serialize(&transaction).unwrap();
    assert!(
        wire.len() > 1232 && wire.len() <= 4096,
        "{} bytes",
        wire.len()
    );
    let decoded: solana_transaction::versioned::VersionedTransaction =
        wincode::deserialize(&wire).unwrap();
    assert_eq!(decoded, transaction);
    let calls = rpc.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["method"], "getAccountInfo");
    assert_eq!(calls[0]["params"][0], mint.to_string());
}

#[test]
fn oversized_transactions_are_rejected_before_leaving_the_service() {
    let instruction = solana_instruction::Instruction {
        program_id: Address::new_from_array([2; 32]),
        accounts: vec![],
        data: vec![0; 4096],
    };
    assert!(v1::compile_unsigned(
        &[instruction],
        &Address::new_from_array([1; 32]),
        Hash::default()
    )
    .is_err());
}

#[tokio::test]
async fn legacy_entrypoint_cannot_sign_or_submit() {
    let rpc = MockRpc::start(json!({"jsonrpc":"2.0","id":1,"result":{
        "value":{"blockhash":Hash::new_from_array([5;32]).to_string()}
    }}))
    .await;
    let token = token_client::token(
        rpc.client.clone(),
        Address::new_from_array([2; 32]),
        Address::new_from_array([1; 32]),
    );
    let signers: Vec<&dyn solana_signer::Signer> = vec![];
    let error = token.process_ixs(&[], &signers).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("signing belongs to the browser wallet"));
    let calls = rpc.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["method"], "getLatestBlockhash");
}
