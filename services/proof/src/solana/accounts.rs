use super::{
    token_wrap::{self, Addresses, TOKEN_2022},
    v1, wrap,
};
use crate::{error::AppError, keys::elgamal::ViewingKey};
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_hash::Hash;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_sdk::{
    encryption::auth_encryption::AeKey,
    zk_elgamal_proof_program::pubkey_validity::build_pubkey_validity_proof_data,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{self, ConfidentialTransferAccount},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction,
    state::{Account, AccountState},
};
use spl_token_client::zk_proofs::confidential_transfer::ApplyPendingBalanceAccountInfo;
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use std::num::NonZeroI8;

pub fn validate<'a>(
    account: &'a RpcAccount,
    wallet: &Address,
) -> Result<StateWithExtensions<'a, Account>, AppError> {
    if account.owner != TOKEN_2022 || account.executable {
        return Err(AppError::Conflict("invalid_token_account"));
    }
    let state = StateWithExtensions::<Account>::unpack(&account.data)
        .map_err(|_| AppError::Conflict("invalid_token_account"))?;
    if state.base.owner != *wallet || state.base.mint != Addresses::for_usdc().wrapped_mint {
        return Err(AppError::Forbidden);
    }
    if state.base.state != AccountState::Initialized {
        return Err(AppError::Conflict("token_account_frozen"));
    }
    Ok(state)
}

pub fn configured(
    account: &RpcAccount,
    wallet: &Address,
    public: &[u8; 32],
) -> Result<ConfidentialTransferAccount, AppError> {
    let state = validate(account, wallet)?;
    let config = state
        .get_extension::<ConfidentialTransferAccount>()
        .map_err(|_| AppError::Conflict("confidential_setup_required"))?;
    if bytemuck::bytes_of(&config.elgamal_pubkey) != public {
        return Err(AppError::Conflict("confidential_key_mismatch"));
    }
    config
        .valid_as_destination()
        .map_err(|_| AppError::Conflict("recipient_not_activated"))?;
    Ok(*config)
}

pub fn configure(
    wallet: &Address,
    account: &Address,
    existing: Option<&RpcAccount>,
    key: &ViewingKey,
    aes: &AeKey,
    blockhash: Hash,
) -> Result<VersionedTransaction, AppError> {
    let mut instructions = Vec::new();
    let existing = existing.filter(|a| {
        !(a.owner == solana_system_interface::program::ID && a.data.is_empty() && !a.executable)
    });
    if let Some(existing) = existing {
        let state = validate(existing, wallet)?;
        if let Ok(config) = state.get_extension::<ConfidentialTransferAccount>() {
            if bytemuck::bytes_of(&config.elgamal_pubkey)
                .iter()
                .any(|b| *b != 0)
            {
                if config.elgamal_pubkey != key.public_key().into() {
                    return Err(AppError::Conflict("confidential_key_mismatch"));
                }
                if !bool::from(config.approved) {
                    return Err(AppError::Conflict("recipient_not_activated"));
                }
                if !bool::from(config.allow_confidential_credits) {
                    let enable = confidential_transfer::instruction::enable_confidential_credits(
                        &TOKEN_2022,
                        account,
                        wallet,
                        &[],
                    )
                    .map_err(|_| AppError::Transaction("enable confidential credits"))?;
                    return v1::compile_unsigned(&[enable], wallet, blockhash);
                }
                return Err(AppError::Conflict("account_already_configured"));
            }
        }
    } else {
        if *account != wrap::destination(wallet) {
            return Err(AppError::Conflict("token_account_missing"));
        }
        instructions.push(token_wrap::create_associated_token_account_idempotent(
            wallet,
            wallet,
            &Addresses::for_usdc().wrapped_mint,
            &TOKEN_2022,
        ));
    }
    let proof = key
        .with_keypair(build_pubkey_validity_proof_data)
        .map_err(|_| AppError::Conflict("proof_generation_failed"))?;
    instructions.push(
        instruction::reallocate(
            &TOKEN_2022,
            account,
            wallet,
            wallet,
            &[],
            &[ExtensionType::ConfidentialTransferAccount],
        )
        .map_err(|_| AppError::Transaction("account reallocation"))?,
    );
    instructions.extend(
        confidential_transfer::instruction::configure_account(
            &TOKEN_2022,
            account,
            &Addresses::for_usdc().wrapped_mint,
            &aes.encrypt(0).into(),
            65536,
            wallet,
            &[],
            ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &proof),
        )
        .map_err(|_| AppError::Transaction("account configuration"))?,
    );
    v1::compile_unsigned(&instructions, wallet, blockhash)
}

pub fn balances(
    config: &ConfidentialTransferAccount,
    key: &ViewingKey,
    aes: &AeKey,
) -> Result<(u64, u64), AppError> {
    if config.expected_pending_balance_credit_counter
        != config.actual_pending_balance_credit_counter
    {
        return Err(AppError::Conflict("credit_counter_mismatch"));
    }
    if config.elgamal_pubkey != key.public_key().into() {
        return Err(AppError::Conflict("confidential_key_mismatch"));
    }
    let cipher = config
        .decryptable_available_balance
        .try_into()
        .map_err(|_| AppError::Conflict("balance_unavailable"))?;
    let available = aes
        .decrypt(&cipher)
        .ok_or(AppError::Conflict("balance_unavailable"))?;
    let pending = key
        .with_keypair(|pair| {
            ApplyPendingBalanceAccountInfo::new(config).get_pending_balance(pair.secret())
        })
        .map_err(|_| AppError::Conflict("balance_unavailable"))?;
    Ok((available, pending))
}

pub fn apply(
    wallet: &Address,
    account: &Address,
    config: &ConfidentialTransferAccount,
    key: &ViewingKey,
    aes: &AeKey,
    blockhash: Hash,
) -> Result<VersionedTransaction, AppError> {
    let counter = u64::from(config.pending_balance_credit_counter);
    if counter == 0 {
        return Err(AppError::Conflict("nothing_to_apply"));
    }
    let (available, pending) = balances(config, key, aes)?;
    let next = available
        .checked_add(pending)
        .ok_or(AppError::Conflict("balance_unavailable"))?;
    let instruction = confidential_transfer::instruction::apply_pending_balance(
        &TOKEN_2022,
        account,
        counter,
        &aes.encrypt(next).into(),
        wallet,
        &[],
    )
    .map_err(|_| AppError::Transaction("apply pending"))?;
    v1::compile_unsigned(&[instruction], wallet, blockhash)
}
