//! The parts of token-wrap this tool calls, written out by hand.
//!
//! Mirrors upstream `program@v1.0.0`: the PDA seeds in `lib.rs` and the account
//! lists in `instruction.rs`. The one difference is the program ID, which is
//! Cadence's own deployment (ops/token-wrap) because the canonical one is not
//! on any cluster.

use {
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
};

/// Cadence's deployment of upstream token-wrap on devnet.
pub const PROGRAM: Address =
    Address::from_str_const("8vc29A8ztm3pE5qJ43paHTMGtBTnf5jXvyqcPQcTjJZc");

/// Circle's USDC on devnet, an SPL Token mint.
pub const DEVNET_USDC: Address =
    Address::from_str_const("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

pub const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Address = spl_token_2022_interface::ID;
pub const ASSOCIATED_TOKEN: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Address = solana_system_interface::program::ID;

/// Every address a wrapped mint involves, derived the way the program derives
/// them. All of it follows from the unwrapped mint and the two token programs,
/// which is why there is exactly one wrapped mint per deployment.
pub struct Addresses {
    pub program: Address,
    pub unwrapped_mint: Address,
    pub unwrapped_token_program: Address,
    pub wrapped_mint: Address,
    pub authority: Address,
    pub backpointer: Address,
    /// Holds the real USDC behind every wrapped token.
    pub escrow: Address,
}

impl Addresses {
    pub fn for_usdc() -> Self {
        Self::derive(PROGRAM, DEVNET_USDC, TOKEN)
    }

    pub fn derive(
        program: Address,
        unwrapped_mint: Address,
        unwrapped_token_program: Address,
    ) -> Self {
        let (wrapped_mint, _) = Address::find_program_address(
            &[b"mint", unwrapped_mint.as_ref(), TOKEN_2022.as_ref()],
            &program,
        );
        let (authority, _) =
            Address::find_program_address(&[b"authority", wrapped_mint.as_ref()], &program);
        let (backpointer, _) =
            Address::find_program_address(&[b"backpointer", wrapped_mint.as_ref()], &program);
        let escrow =
            associated_token_address(&authority, &unwrapped_mint, &unwrapped_token_program);

        Self {
            program,
            unwrapped_mint,
            unwrapped_token_program,
            wrapped_mint,
            authority,
            backpointer,
            escrow,
        }
    }
}

pub fn associated_token_address(
    owner: &Address,
    mint: &Address,
    token_program: &Address,
) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN,
    )
    .0
}

/// `CreateIdempotent` on the associated token account program. Written out
/// because the interface crate is on a different `solana-pubkey` major from
/// the rest of this tree.
pub fn create_associated_token_account_idempotent(
    payer: &Address,
    owner: &Address,
    mint: &Address,
    token_program: &Address,
) -> Instruction {
    Instruction {
        program_id: ASSOCIATED_TOKEN,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(associated_token_address(owner, mint, token_program), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1],
    }
}

/// `CreateMint`. The program does not create the two accounts itself, it
/// allocates them, so both have to hold their rent before this runs.
pub fn create_mint(addresses: &Addresses, idempotent: bool) -> Instruction {
    Instruction {
        program_id: addresses.program,
        accounts: vec![
            AccountMeta::new(addresses.wrapped_mint, false),
            AccountMeta::new(addresses.backpointer, false),
            AccountMeta::new_readonly(addresses.unwrapped_mint, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![0, idempotent.into()],
    }
}

/// `Wrap`: moves `amount` of the unwrapped token into escrow and mints the same
/// amount of the wrapped one.
pub fn wrap(
    addresses: &Addresses,
    recipient: &Address,
    unwrapped_token_account: &Address,
    transfer_authority: &Address,
    amount: u64,
) -> Instruction {
    let mut data = vec![1];
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: addresses.program,
        accounts: vec![
            AccountMeta::new(*recipient, false),
            AccountMeta::new(addresses.wrapped_mint, false),
            AccountMeta::new_readonly(addresses.authority, false),
            AccountMeta::new_readonly(addresses.unwrapped_token_program, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new(*unwrapped_token_account, false),
            AccountMeta::new_readonly(addresses.unwrapped_mint, false),
            AccountMeta::new(addresses.escrow, false),
            AccountMeta::new_readonly(*transfer_authority, true),
        ],
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Upstream's own CLI output, quoted in solana-program/token-wrap issue
    /// 248: wrapping mainnet USDC into Token-2022 under the canonical program
    /// ID. If the seeds here drift from upstream's, this stops matching.
    #[test]
    fn the_seeds_match_upstream() {
        let canonical = Address::from_str_const("TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR");
        let mainnet_usdc = Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

        let addresses = Addresses::derive(canonical, mainnet_usdc, TOKEN);

        assert_eq!(
            addresses.wrapped_mint.to_string(),
            "4gaM1o816Ma3utkudekQAZRJQc1fmTyMxnBoYJh6jRpG"
        );
        assert_eq!(
            addresses.backpointer.to_string(),
            "BVcLeCXEL489krW1VGL7n4NJJo4b4FuJ731anfawhFB8"
        );
    }

    /// One wrapped mint per deployment: the same USDC under a different
    /// program ID is a different mint.
    #[test]
    fn each_deployment_has_its_own_wrapped_mint() {
        let canonical = Address::from_str_const("TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR");
        assert_ne!(
            Addresses::derive(canonical, DEVNET_USDC, TOKEN).wrapped_mint,
            Addresses::for_usdc().wrapped_mint
        );
    }
}
