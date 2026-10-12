#[path = "support/confidential.rs"]
#[allow(dead_code)]
mod fixture;
use cadence_proof::solana::{accounts, token_wrap::Addresses};
use solana_signer::Signer;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::Account,
};

#[test]
fn apply_preserves_the_pending_counter_and_uses_the_enrolled_key() {
    let mut f = fixture::Fixture::new();
    let sender = f.transfer().sender;
    let wallet = f.wallet.pubkey();
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
    state.base.mint = Addresses::for_usdc().wrapped_mint;
    state.pack_base();
    let config = state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap();
    config.pending_balance_credit_counter = 1.into();
    config.pending_balance_lo = f.key.public_key().encrypt(25_u64).into();
    config.pending_balance_hi = f.key.public_key().encrypt(0_u64).into();
    let config = *config;
    assert_eq!(
        accounts::balances(&config, &f.key, &f.aes).unwrap(),
        (fixture::BALANCE, 25)
    );
    let tx = accounts::apply(
        &wallet,
        &sender,
        &config,
        &f.key,
        &f.aes,
        f.transfer().blockhash,
    )
    .unwrap();
    assert!(tx
        .signatures
        .iter()
        .all(|s| *s == solana_signature::Signature::default()));
    assert_eq!(tx.message.header().num_required_signatures, 1);
    assert_eq!(tx.message.static_account_keys()[0], wallet);
    assert!(accounts::configured(&f.sender, &wallet, &[0; 32]).is_err());
    let mut mismatch = config;
    mismatch.expected_pending_balance_credit_counter = 1.into();
    mismatch.actual_pending_balance_credit_counter = 2.into();
    assert!(matches!(
        accounts::balances(&mismatch, &f.key, &f.aes),
        Err(cadence_proof::error::AppError::Conflict(
            "credit_counter_mismatch"
        ))
    ));
    let mut empty = config;
    empty.pending_balance_credit_counter = 0.into();
    assert!(accounts::apply(
        &wallet,
        &sender,
        &empty,
        &f.key,
        &f.aes,
        f.transfer().blockhash
    )
    .is_err());
}
#[test]
fn configure_only_creates_a_missing_canonical_account() {
    let f = fixture::Fixture::new();
    let wallet = f.wallet.pubkey();
    let account = cadence_proof::solana::wrap::destination(&wallet);
    let tx = accounts::configure(
        &wallet,
        &account,
        None,
        &f.key,
        &f.aes,
        f.transfer().blockhash,
    )
    .unwrap();
    assert_eq!(tx.message.header().num_required_signatures, 1);
    assert!(cadence_proof::solana::v1::serialize(&tx).unwrap().len() < 4096);
    assert!(accounts::configure(
        &wallet,
        &f.transfer().sender,
        None,
        &f.key,
        &f.aes,
        f.transfer().blockhash
    )
    .is_err());
}

#[test]
fn configure_handles_an_allocated_empty_extension_and_disabled_credits() {
    let mut f = fixture::Fixture::new();
    let wallet = f.wallet.pubkey();
    let account = f.transfer().sender;
    let hash = f.transfer().blockhash;
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
    state.base.mint = Addresses::for_usdc().wrapped_mint;
    state.pack_base();
    *state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap() = ConfidentialTransferAccount::default();
    assert!(accounts::configure(&wallet, &account, Some(&f.sender), &f.key, &f.aes, hash).is_ok());
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
    let config = state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap();
    config.elgamal_pubkey = f.key.public_key().into();
    config.approved = true.into();
    config.allow_confidential_credits = false.into();
    assert!(accounts::configure(&wallet, &account, Some(&f.sender), &f.key, &f.aes, hash).is_ok());
    let mut state = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
    state
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .allow_confidential_credits = true.into();
    assert!(matches!(
        accounts::configure(&wallet, &account, Some(&f.sender), &f.key, &f.aes, hash),
        Err(cadence_proof::error::AppError::Conflict(
            "account_already_configured"
        ))
    ));
}
