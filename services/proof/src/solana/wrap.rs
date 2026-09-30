use super::token_wrap::{self, Addresses, TOKEN, TOKEN_2022};
use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_zk_elgamal_proof_interface::proof_data::PubkeyValidityProofData;
use solana_zk_sdk::zk_elgamal_proof_program::VerifyZkProof;
use solana_zk_sdk_pod::encryption::auth_encryption::PodAeCiphertext;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{self, ConfidentialTransferAccount, ConfidentialTransferMint},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction,
    state::{Account, AccountState, Mint},
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use std::num::NonZeroI8;

pub const DECIMALS: u8 = 6;
pub const MAX_DEPOSIT: u64 = (1 << 48) - 1;

/// Public artifacts produced using the wallet's enrolled confidential keys.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    pub pubkey_validity_proof: String,
    pub decryptable_zero_balance: String,
}

impl Setup {
    fn decode(&self) -> Result<(PubkeyValidityProofData, PodAeCiphertext), AppError> {
        fn pod<T: bytemuck::Pod>(encoded: &str) -> Result<T, AppError> {
            let bytes = STANDARD.decode(encoded).map_err(|_| invalid_setup())?;
            bytemuck::try_pod_read_unaligned(&bytes).map_err(|_| invalid_setup())
        }
        let proof: PubkeyValidityProofData = pod(&self.pubkey_validity_proof)?;
        proof.verify_proof().map_err(|_| invalid_setup())?;
        Ok((proof, pod(&self.decryptable_zero_balance)?))
    }
}

fn invalid_setup() -> AppError {
    AppError::BadRequest("invalid_confidential_setup")
}

pub fn amount(value: &str) -> Result<u64, AppError> {
    if value.is_empty() || value.len() > 15 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::BadRequest("invalid_amount"));
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|n| (1..=MAX_DEPOSIT).contains(n))
        .ok_or(AppError::BadRequest("invalid_amount"))
}

pub fn destination(wallet: &Address) -> Address {
    token_wrap::associated_token_address(wallet, &Addresses::for_usdc().wrapped_mint, &TOKEN_2022)
}

pub fn validate_mint(account: &RpcAccount) -> Result<(), AppError> {
    let bad = || AppError::Conflict("invalid_wrapped_mint");
    if account.owner != TOKEN_2022 || account.executable {
        return Err(bad());
    }
    let mint = StateWithExtensions::<Mint>::unpack(&account.data).map_err(|_| bad())?;
    let config = mint
        .get_extension::<ConfidentialTransferMint>()
        .map_err(|_| bad())?;
    if mint.base.decimals != DECIMALS
        || Option::<Address>::from(mint.base.mint_authority)
            != Some(Addresses::for_usdc().authority)
        || config.authority.get().is_some()
        || config.auditor_elgamal_pubkey.get().is_some()
        || !bool::from(config.auto_approve_new_accounts)
    {
        return Err(bad());
    }
    Ok(())
}

pub fn validate_source(
    account: &RpcAccount,
    wallet: &Address,
    amount: u64,
) -> Result<(), AppError> {
    let bad = || AppError::Conflict("invalid_usdc_source");
    if account.owner != TOKEN || account.executable {
        return Err(bad());
    }
    let source = StateWithExtensions::<Account>::unpack(&account.data).map_err(|_| bad())?;
    if source.base.owner != *wallet
        || source.base.mint != Addresses::for_usdc().unwrapped_mint
        || source.base.state != AccountState::Initialized
    {
        return Err(bad());
    }
    if source.base.amount < amount {
        return Err(AppError::Conflict("insufficient_usdc"));
    }
    Ok(())
}

pub fn instructions(
    wallet: &Address,
    amount: u64,
    existing: Option<&RpcAccount>,
    setup: Option<&Setup>,
) -> Result<Vec<Instruction>, AppError> {
    if !(1..=MAX_DEPOSIT).contains(&amount) {
        return Err(AppError::BadRequest("invalid_amount"));
    }
    let addresses = Addresses::for_usdc();
    let destination = destination(wallet);
    let bad = || AppError::Conflict("invalid_wrap_destination");
    let state = match existing {
        // An ATA may already hold rent donated by an unrelated wallet.
        Some(a)
            if a.owner == solana_system_interface::program::ID
                && a.data.is_empty()
                && !a.executable =>
        {
            None
        }
        Some(a) => {
            if a.owner != TOKEN_2022 || a.executable {
                return Err(bad());
            }
            let state = StateWithExtensions::<Account>::unpack(&a.data).map_err(|_| bad())?;
            if state.base.owner != *wallet
                || state.base.mint != addresses.wrapped_mint
                || state.base.state != AccountState::Initialized
            {
                return Err(bad());
            }
            Some(state)
        }
        None => None,
    };
    let extension = match &state {
        Some(s) => {
            let types = s.get_extension_types().map_err(|_| bad())?;
            if types.contains(&ExtensionType::ConfidentialTransferAccount) {
                Some(
                    s.get_extension::<ConfidentialTransferAccount>()
                        .map_err(|_| bad())?,
                )
            } else {
                None
            }
        }
        None => None,
    };
    let mut result = Vec::new();
    if state.is_none() {
        result.push(token_wrap::create_associated_token_account_idempotent(
            wallet,
            wallet,
            &addresses.wrapped_mint,
            &TOKEN_2022,
        ));
    }
    if let Some(config) = extension {
        config
            .valid_as_destination()
            .map_err(|_| AppError::Conflict("confidential_destination_unavailable"))?;
        if let Some(setup) = setup {
            let (proof, _) = setup.decode()?;
            if proof.context.pubkey != config.elgamal_pubkey {
                return Err(AppError::Conflict("confidential_key_mismatch"));
            }
        }
    } else {
        let (proof, zero) = setup
            .ok_or(AppError::Conflict("confidential_setup_required"))?
            .decode()?;
        result.push(
            instruction::reallocate(
                &TOKEN_2022,
                &destination,
                wallet,
                wallet,
                &[],
                &[ExtensionType::ConfidentialTransferAccount],
            )
            .map_err(|_| bad())?,
        );
        result.extend(
            confidential_transfer::instruction::configure_account(
                &TOKEN_2022,
                &destination,
                &addresses.wrapped_mint,
                &zero,
                65_536,
                wallet,
                &[],
                ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &proof),
            )
            .map_err(|_| bad())?,
        );
    }
    let source = token_wrap::associated_token_address(wallet, &addresses.unwrapped_mint, &TOKEN);
    result.push(token_wrap::wrap(
        &addresses,
        &destination,
        &source,
        wallet,
        amount,
    ));
    result.push(
        confidential_transfer::instruction::deposit(
            &TOKEN_2022,
            &destination,
            &addresses.wrapped_mint,
            amount,
            DECIMALS,
            wallet,
            &[],
        )
        .map_err(|_| bad())?,
    );
    Ok(result)
}
