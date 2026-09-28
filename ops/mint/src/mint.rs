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

/// Whether the wrapped mint has actually been created at this address.
///
/// Anyone can send lamports to the mint's address before it exists, which
/// leaves a system-owned account with no data there. The program is built for
/// that, since it expects callers to pre-fund, so an account existing at the
/// address is not the mint existing.
pub fn is_created(owner: &Address, data: &[u8]) -> bool {
    *owner == spl_token_2022_interface::ID && !data.is_empty()
}

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

    /// Everything that is not what stock token-wrap produces. Empty means the
    /// mint is fit to use.
    ///
    /// The two that decide ADR O1 are the auditor and the authority: both
    /// `None` means nobody can ever read amounts on this mint, and nobody can
    /// ever change that.
    pub fn problems(&self, expected_mint_authority: &Address) -> Vec<String> {
        let mut problems = vec![];

        if self.owner != spl_token_2022_interface::ID {
            problems.push(format!("owned by {}, not Token-2022", self.owner));
        }
        if self.mint_authority != Some(*expected_mint_authority) {
            problems.push(format!(
                "mint authority is {:?}, expected the wrap program's PDA {expected_mint_authority}",
                self.mint_authority
            ));
        }
        if self.decimals != USDC_DECIMALS {
            problems.push(format!(
                "{} decimals, USDC has {USDC_DECIMALS}",
                self.decimals
            ));
        }

        match &self.confidential {
            None => problems.push("no ConfidentialTransferMint extension".into()),
            Some(config) => {
                if let Some(authority) = config.authority {
                    problems.push(format!(
                        "confidential transfer authority is {authority}, so the config can change"
                    ));
                }
                if let Some(auditor) = config.auditor_elgamal_pubkey {
                    problems.push(format!("an auditor key is set: {auditor}"));
                }
                if !config.auto_approve_new_accounts {
                    problems.push(
                        "new accounts need approval, and with no authority nobody can give it"
                            .into(),
                    );
                }
            }
        }

        problems
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        spl_token_2022_interface::extension::{
            metadata_pointer::MetadataPointer, BaseStateWithExtensionsMut,
            StateWithExtensionsMut,
        },
        std::str::FromStr,
    };

    const AUTHORITY: Address = Address::from_str_const("5oAMC4VEuA1rx5KUy9w9iBJ1gQMrPtTEFnXweTNSdSGQ");

    /// A mint laid out the way `DefaultToken2022Customizer` leaves one, with
    /// the confidential config supplied by the test.
    fn mint_with(configure: impl FnOnce(&mut ConfidentialTransferMint)) -> Vec<u8> {
        let space = ExtensionType::try_calculate_account_len::<Mint>(&[
            ExtensionType::ConfidentialTransferMint,
            ExtensionType::MetadataPointer,
        ])
        .unwrap();
        let mut data = vec![0; space];
        let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();

        let confidential = state
            .init_extension::<ConfidentialTransferMint>(true)
            .unwrap();
        confidential.auto_approve_new_accounts = true.into();
        configure(confidential);
        state.init_extension::<MetadataPointer>(true).unwrap();

        state.base = Mint {
            mint_authority: Some(AUTHORITY).into(),
            supply: 0,
            decimals: USDC_DECIMALS,
            is_initialized: true,
            freeze_authority: None.into(),
        };
        state.pack_base();
        state.init_account_type().unwrap();
        data
    }

    fn problems(data: Vec<u8>) -> Vec<String> {
        WrappedMint::read(spl_token_2022_interface::ID, data)
            .unwrap()
            .problems(&AUTHORITY)
    }

    #[test]
    fn a_pre_funded_address_is_not_a_created_mint() {
        let system = Address::from_str_const("11111111111111111111111111111111");
        assert!(!is_created(&system, &[]));
        assert!(is_created(&spl_token_2022_interface::ID, &mint_with(|_| {})));
    }

    #[test]
    fn a_stock_wrapped_mint_passes() {
        assert_eq!(problems(mint_with(|_| {})), Vec::<String>::new());
    }

    #[test]
    fn an_auditor_is_reported() {
        let auditor =
            PodElGamalPubkey::from_str("yonKhqkoXNvMbN/tU6fjHFhfZuNPpvMj8L55aP2bBG4=").unwrap();
        let found = problems(mint_with(|c| c.auditor_elgamal_pubkey = Some(auditor).try_into().unwrap()));
        assert!(found.iter().any(|p| p.contains("auditor")), "{found:?}");
    }

    #[test]
    fn a_config_authority_is_reported() {
        let found = problems(mint_with(|c| c.authority = Some(AUTHORITY).try_into().unwrap()));
        assert!(found.iter().any(|p| p.contains("can change")), "{found:?}");
    }

    #[test]
    fn a_mint_from_another_program_is_reported() {
        let other = Address::from_str_const("TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR");
        let found = WrappedMint::read(spl_token_2022_interface::ID, mint_with(|_| {}))
            .unwrap()
            .problems(&other);
        assert!(found.iter().any(|p| p.contains("mint authority")), "{found:?}");
    }

    #[test]
    fn a_mint_without_the_extension_is_reported() {
        let space = ExtensionType::try_calculate_account_len::<Mint>(&[]).unwrap();
        let mut data = vec![0; space];
        let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
        state.base = Mint {
            mint_authority: Some(AUTHORITY).into(),
            decimals: USDC_DECIMALS,
            is_initialized: true,
            ..Mint::default()
        };
        state.pack_base();

        let found = problems(data);
        assert!(found.iter().any(|p| p.contains("no ConfidentialTransferMint")), "{found:?}");
    }
}
