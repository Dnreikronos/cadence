//! Reading a wrapped mint and checking it is the one the design assumes.
//!
//! Kept apart from the RPC so the checks can be tested against mints built in
//! memory, including the ones a correct deployment never produces.

use {
    anyhow::{Context, Result},
    solana_address::Address,
    solana_zk_sdk_pod::encryption::elgamal::PodElGamalPubkey,
    spl_token_2022_interface::{
        extension::{
            confidential_transfer::ConfidentialTransferMint, BaseStateWithExtensions,
            ExtensionType, StateWithExtensionsOwned,
        },
        state::Mint,
    },
};

/// Devnet USDC's decimals, which the wrapped mint copies.
pub const USDC_DECIMALS: u8 = 6;

pub struct WrappedMint {
    pub owner: Address,
    pub mint_authority: Option<Address>,
    pub freeze_authority: Option<Address>,
    pub decimals: u8,
    pub supply: u64,
    pub extensions: Vec<ExtensionType>,
    pub confidential: Option<ConfidentialConfig>,
}

/// `ConfidentialTransferMint`, with the pod types turned into options.
pub struct ConfidentialConfig {
    /// Who can change the config or approve accounts. `None` makes the config
    /// immutable, for good.
    pub authority: Option<Address>,
    pub auto_approve_new_accounts: bool,
    /// Who can decrypt every transfer amount on this mint.
    pub auditor_elgamal_pubkey: Option<PodElGamalPubkey>,
}

impl WrappedMint {
    pub fn read(owner: Address, data: Vec<u8>) -> Result<Self> {
        let state = StateWithExtensionsOwned::<Mint>::unpack(data)
            .context("the account is not a Token-2022 mint")?;

        let confidential = state
            .get_extension::<ConfidentialTransferMint>()
            .ok()
            .map(|extension| ConfidentialConfig {
                authority: extension.authority.get(),
                auto_approve_new_accounts: extension.auto_approve_new_accounts.into(),
                auditor_elgamal_pubkey: extension.auditor_elgamal_pubkey.get(),
            });

        Ok(Self {
            owner,
            mint_authority: state.base.mint_authority.into(),
            freeze_authority: state.base.freeze_authority.into(),
            decimals: state.base.decimals,
            supply: state.base.supply,
            extensions: state.get_extension_types()?,
            confidential,
        })
    }
}
