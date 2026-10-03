use cadence_proof::{keys::elgamal::ViewingKey, solana::confidential::Transfer};
use solana_account::Account as RpcAccount;
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_zk_sdk::encryption::{
    auth_encryption::AeKey, derivation::derive_confidential_keys, elgamal::ElGamalKeypair,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{ConfidentialTransferAccount, ConfidentialTransferMint},
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    },
    state::{Account, AccountState, Mint},
};

pub const BALANCE: u64 = 10_000_000;
pub const AMOUNT: u64 = 4_200_000;

pub struct Fixture {
    pub wallet: Keypair,
    pub key: ViewingKey,
    pub aes: AeKey,
    pub recipient_key: ElGamalKeypair,
    pub mint: RpcAccount,
    pub sender: RpcAccount,
    pub recipient: RpcAccount,
}

pub fn rpc_account(data: Vec<u8>) -> RpcAccount {
    RpcAccount {
        lamports: 1_000_000,
        data,
        owner: spl_token_2022_interface::ID,
        executable: false,
        rent_epoch: 0,
    }
}

pub fn mint(extensions: &[ExtensionType]) -> RpcAccount {
    let size = ExtensionType::try_calculate_account_len::<Mint>(extensions).unwrap();
    let mut data = vec![0; size];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
    for extension in extensions {
        match extension {
            ExtensionType::ConfidentialTransferMint => {
                state
                    .init_extension::<ConfidentialTransferMint>(true)
                    .unwrap();
            }
            ExtensionType::TransferFeeConfig => {
                state.init_extension::<spl_token_2022_interface::extension::transfer_fee::TransferFeeConfig>(true).unwrap();
            }
            ExtensionType::TransferHook => {
                state.init_extension::<spl_token_2022_interface::extension::transfer_hook::TransferHook>(true).unwrap();
            }
            _ => panic!("unsupported fixture extension"),
        }
    }
    state.base = Mint {
        decimals: 6,
        is_initialized: true,
        ..Mint::default()
    };
    state.pack_base();
    state.init_account_type().unwrap();
    rpc_account(data)
}

fn token_account(wallet: Address, config: ConfidentialTransferAccount) -> RpcAccount {
    let size = ExtensionType::try_calculate_account_len::<Account>(&[
        ExtensionType::ConfidentialTransferAccount,
    ])
    .unwrap();
    let mut data = vec![0; size];
    let mut state = StateWithExtensionsMut::<Account>::unpack_uninitialized(&mut data).unwrap();
    *state
        .init_extension::<ConfidentialTransferAccount>(true)
        .unwrap() = config;
    state.base = Account {
        mint: Address::new_from_array([2; 32]),
        owner: wallet,
        state: AccountState::Initialized,
        ..Account::default()
    };
    state.pack_base();
    state.init_account_type().unwrap();
    rpc_account(data)
}

impl Fixture {
    pub fn new() -> Self {
        let wallet = Keypair::new();
        let sender = Address::new_from_array([3; 32]);
        let signature = wallet.sign_message(&ViewingKey::signing_message(&sender));
        let key = ViewingKey::derive(&wallet.pubkey(), &sender, &signature).unwrap();
        let (_, aes) = derive_confidential_keys(&wallet, sender.as_ref()).unwrap();
        let recipient_key = ElGamalKeypair::new_rand();
        let config = |keys: &solana_zk_sdk::encryption::elgamal::ElGamalPubkey, balance| {
            ConfidentialTransferAccount {
                approved: true.into(),
                elgamal_pubkey: (*keys).into(),
                available_balance: keys.encrypt(balance).into(),
                decryptable_available_balance: aes.encrypt(balance).into(),
                allow_confidential_credits: true.into(),
                maximum_pending_balance_credit_counter: 65536.into(),
                ..ConfidentialTransferAccount::default()
            }
        };
        Self {
            sender: token_account(wallet.pubkey(), config(&key.public_key(), BALANCE)),
            recipient: token_account(
                Address::new_from_array([6; 32]),
                config(recipient_key.pubkey(), 0),
            ),
            mint: mint(&[ExtensionType::ConfidentialTransferMint]),
            wallet,
            key,
            aes,
            recipient_key,
        }
    }

    pub fn transfer(&self) -> Transfer<'_> {
        Transfer {
            mint: Address::new_from_array([2; 32]),
            sender: Address::new_from_array([3; 32]),
            recipient: Address::new_from_array([4; 32]),
            wallet: self.wallet.pubkey(),
            mint_account: &self.mint,
            sender_account: &self.sender,
            recipient_account: &self.recipient,
            amount: AMOUNT,
            aes_key: &self.aes,
            blockhash: Hash::new_from_array([5; 32]),
            context_rent: [1_788_720, 2_899_680, 3_062_400],
        }
    }
}
