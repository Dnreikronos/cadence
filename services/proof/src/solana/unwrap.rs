use super::{
    token_wrap::{self, Addresses, TOKEN, TOKEN_2022},
    v1, wrap,
};
use crate::{error::AppError, keys::elgamal::ViewingKey};
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_hash::Hash;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_sdk::encryption::auth_encryption::AeKey;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{self, ConfidentialTransferAccount},
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::{Account, AccountState},
};
use spl_token_client::zk_proofs::confidential_transfer::WithdrawAccountInfo;
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use std::num::NonZeroI8;

pub fn source(wallet: &Address) -> Address {
    wrap::destination(wallet)
}
pub fn destination(wallet: &Address) -> Address {
    token_wrap::associated_token_address(wallet, &Addresses::for_usdc().unwrapped_mint, &TOKEN)
}

pub fn validate_source(
    account: &RpcAccount,
    wallet: &Address,
) -> Result<ConfidentialTransferAccount, AppError> {
    let invalid = || AppError::Conflict("invalid_confidential_state");
    if account.owner != TOKEN_2022 || account.executable {
        return Err(invalid());
    }
    let state = StateWithExtensions::<Account>::unpack(&account.data).map_err(|_| invalid())?;
    if state.base.owner != *wallet || state.base.mint != Addresses::for_usdc().wrapped_mint {
        return Err(AppError::Forbidden);
    }
    if state.base.state != AccountState::Initialized {
        return Err(invalid());
    }
    let config = state
        .get_extension::<ConfidentialTransferAccount>()
        .map_err(|_| invalid())?;
    config.valid_as_source().map_err(|_| invalid())?;
    Ok(*config)
}

/// All proofs and balance updates follow the upstream WithdrawAccountInfo helper.
/// Only an already audited viewing key is accepted; signing belongs to the wallet.
pub fn build(
    wallet: &Address,
    config: &ConfidentialTransferAccount,
    amount: u64,
    aes: &AeKey,
    key: &ViewingKey,
    blockhash: Hash,
) -> Result<VersionedTransaction, AppError> {
    if !(1..=wrap::MAX_DEPOSIT).contains(&amount) {
        return Err(AppError::BadRequest("invalid_amount"));
    }
    if config.elgamal_pubkey != key.public_key().into() {
        return Err(AppError::Conflict("confidential_key_mismatch"));
    }
    config
        .valid_as_source()
        .map_err(|_| AppError::Conflict("invalid_confidential_state"))?;
    let info = WithdrawAccountInfo::new(config);
    let balance = info
        .new_decryptable_available_balance(amount, aes)
        .map_err(|_| AppError::Conflict("withdrawal_balance_unavailable"))?
        .into();
    let proofs = key
        .with_keypair(|pair| info.generate_proof_data(amount, pair, aes))
        .map_err(|_| AppError::Conflict("proof_generation_failed"))?;
    let addresses = Addresses::for_usdc();
    let source = source(wallet);
    let destination = destination(wallet);
    let mut instructions = vec![token_wrap::create_associated_token_account_idempotent(
        wallet,
        wallet,
        &addresses.unwrapped_mint,
        &TOKEN,
    )];
    instructions.extend(
        confidential_transfer::instruction::withdraw(
            &TOKEN_2022,
            &source,
            &addresses.wrapped_mint,
            amount,
            wrap::DECIMALS,
            &balance,
            wallet,
            &[],
            ProofLocation::InstructionOffset(
                NonZeroI8::new(1).unwrap(),
                &proofs.equality_proof_data,
            ),
            ProofLocation::InstructionOffset(NonZeroI8::new(2).unwrap(), &proofs.range_proof_data),
        )
        .map_err(|_| AppError::Transaction("cannot encode withdrawal"))?,
    );
    instructions.push(token_wrap::unwrap(
        &addresses,
        &source,
        &destination,
        wallet,
        amount,
    ));
    let transaction = v1::compile_unsigned(&instructions, wallet, blockhash)?;
    if v1::serialize(&transaction)?.len() >= 4096 {
        return Err(AppError::Transaction("withdrawal must be below 4096 bytes"));
    }
    Ok(transaction)
}
