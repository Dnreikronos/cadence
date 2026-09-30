use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::{
    token_wrap::{self, Addresses, TOKEN_2022},
    v0, v1, wrap,
};
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_hash::Hash;
use solana_zk_sdk::{
    encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
    zk_elgamal_proof_program::build_pubkey_validity_proof_data,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        ExtensionType, StateWithExtensionsMut,
    },
    state::{Account, AccountState},
};

fn setup() -> wrap::Setup {
    let proof = build_pubkey_validity_proof_data(&ElGamalKeypair::new_rand()).unwrap();
    let zero: solana_zk_sdk_pod::encryption::auth_encryption::PodAeCiphertext =
        AeKey::new_rand().encrypt(0).into();
    wrap::Setup {
        pubkey_validity_proof: STANDARD.encode(bytemuck::bytes_of(&proof)),
        decryptable_zero_balance: STANDARD.encode(bytemuck::bytes_of(&zero)),
    }
}

fn account(wallet: Address, confidential: bool) -> RpcAccount {
    let extensions = if confidential {
        vec![ExtensionType::ConfidentialTransferAccount]
    } else {
        vec![]
    };
    let len = ExtensionType::try_calculate_account_len::<Account>(&extensions).unwrap();
    let mut data = vec![0; len];
    let mut state = StateWithExtensionsMut::<Account>::unpack_uninitialized(&mut data).unwrap();
    if confidential {
        let config = state
            .init_extension::<ConfidentialTransferAccount>(true)
            .unwrap();
        config.approved = true.into();
        config.allow_confidential_credits = true.into();
        config.maximum_pending_balance_credit_counter = 65_536.into();
    }
    state.base = Account {
        owner: wallet,
        mint: Addresses::for_usdc().wrapped_mint,
        state: AccountState::Initialized,
        ..Account::default()
    };
    state.pack_base();
    state.init_account_type().unwrap();
    RpcAccount {
        data,
        owner: TOKEN_2022,
        ..RpcAccount::default()
    }
}

#[test]
fn fresh_destination_is_created_configured_wrapped_and_deposited_unsigned() {
    let wallet = Address::new_from_array([9; 32]);
    let ix = wrap::instructions(&wallet, 1_000_000, None, Some(&setup())).unwrap();
    assert_eq!(ix.len(), 6);
    assert_eq!(ix[0].program_id, token_wrap::ASSOCIATED_TOKEN);
    assert_eq!(ix[1].data[0], 29); // Reallocate
    assert_eq!(&ix[2].data[..2], &[27, 2]); // ConfigureAccount
    assert_eq!(*ix[2].data.last().unwrap(), 1); // proof follows immediately
    assert_eq!(ix[4].program_id, token_wrap::PROGRAM);
    assert_eq!(
        ix[4].data,
        [vec![1], 1_000_000u64.to_le_bytes().to_vec()].concat()
    );
    assert_eq!(ix[4].accounts[0].pubkey, wrap::destination(&wallet));
    assert_eq!(&ix[5].data[..2], &[27, 5]); // Deposit
    let tx = v1::compile_unsigned(&ix, &wallet, Hash::new_from_array([8; 32])).unwrap();
    assert_eq!(tx.signatures, vec![solana_signature::Signature::default()]);
    assert_eq!(tx.message.static_account_keys()[0], wallet);
    assert!(v1::serialize(&tx).unwrap().len() <= 4096);
    let compatible = v0::compile_unsigned(&ix, &wallet, Hash::new_from_array([8; 32])).unwrap();
    assert_eq!(
        compatible.signatures,
        vec![solana_signature::Signature::default()]
    );
    assert!(v1::serialize(&compatible).unwrap().len() <= 1232);
    let solana_message::VersionedMessage::V0(message) = compatible.message else {
        panic!("wrap must fit v0")
    };
    assert!(message.address_table_lookups.is_empty());
    assert_eq!(message.instructions.len(), ix.len() + 2);
    for (i, tag, value) in [(0, 2, 400_000u32), (1, 4, 64 * 1024 * 1024u32)] {
        let budget = &message.instructions[i];
        assert_eq!(
            message.account_keys[budget.program_id_index as usize].to_string(),
            "ComputeBudget111111111111111111111111111111"
        );
        assert_eq!(
            budget.data,
            [vec![tag], value.to_le_bytes().to_vec()].concat()
        );
    }
    for (original, compiled) in ix.iter().zip(message.instructions.iter().skip(2)) {
        assert_eq!(compiled.data, original.data);
        assert_eq!(
            message.account_keys[compiled.program_id_index as usize],
            original.program_id
        );
        assert_eq!(
            compiled
                .accounts
                .iter()
                .map(|i| message.account_keys[*i as usize])
                .collect::<Vec<_>>(),
            original
                .accounts
                .iter()
                .map(|a| a.pubkey)
                .collect::<Vec<_>>()
        );
    }
    assert_eq!(*message.instructions[4].data.last().unwrap(), 1);
    assert_eq!(message.instructions[5].data, ix[3].data);
}

#[test]
fn existing_public_account_is_reallocated_and_existing_private_account_is_preserved() {
    let wallet = Address::new_from_array([9; 32]);
    let public = account(wallet, false);
    assert_eq!(
        wrap::instructions(&wallet, 1, Some(&public), Some(&setup()))
            .unwrap()
            .len(),
        5
    );
    let private = account(wallet, true);
    let ix = wrap::instructions(&wallet, 1, Some(&private), None).unwrap();
    assert_eq!(ix.len(), 2);
    assert_eq!(ix[0].program_id, token_wrap::PROGRAM);
    assert!(wrap::instructions(&wallet, 1, Some(&private), Some(&setup())).is_err());
}

#[test]
fn rejects_bad_amounts_proofs_and_destinations() {
    for s in [
        "",
        "0",
        "-1",
        "+1",
        "1.0",
        " 1",
        "18446744073709551616",
        "281474976710656",
    ] {
        assert!(wrap::amount(s).is_err(), "{s}");
    }
    assert_eq!(wrap::amount("281474976710655").unwrap(), wrap::MAX_DEPOSIT);
    let wallet = Address::new_from_array([9; 32]);
    assert!(wrap::instructions(&wallet, 1, None, None).is_err());
    let mut malformed = setup();
    malformed.pubkey_validity_proof = STANDARD.encode([0; 96]);
    assert!(wrap::instructions(&wallet, 1, None, Some(&malformed)).is_err());
    let wrong_owner = account(Address::new_from_array([8; 32]), true);
    assert!(wrap::instructions(&wallet, 1, Some(&wrong_owner), None).is_err());
    let mut exhausted = account(wallet, true);
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut exhausted.data).unwrap();
    state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .pending_balance_credit_counter = 65_536.into();
    assert!(wrap::instructions(&wallet, 1, Some(&exhausted), None).is_err());
}

#[test]
fn prefunded_system_account_can_still_be_created() {
    let wallet = Address::new_from_array([9; 32]);
    let donated = RpcAccount {
        lamports: 1,
        owner: solana_system_interface::program::ID,
        ..RpcAccount::default()
    };
    assert_eq!(
        wrap::instructions(&wallet, 1, Some(&donated), Some(&setup()))
            .unwrap()
            .len(),
        6
    );
}
