use solana_address::Address;
use solana_signature::Signature;
use solana_zk_sdk::encryption::{
    derivation::{confidential_derivation_message, derive_confidential_keys_from_signature},
    elgamal::{ElGamalKeypair, ElGamalPubkey, ElGamalSecretKey},
};
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
#[error("invalid viewing-key derivation signature")]
pub struct DerivationError;

/// Contains secret material. Intentionally has no formatting or serialization traits.
/// The SDK keypair and this wrapper both zeroize their contents on drop.
pub struct ViewingKey(Zeroizing<ElGamalKeypair>);

impl ViewingKey {
    /// The caller must authorize this wallet for the token account separately.
    /// The signature is secret material: never log it or persist it.
    pub fn derive(
        wallet: &Address,
        token_account: &Address,
        signature: &Signature,
    ) -> Result<Self, DerivationError> {
        if !signature.verify(wallet.as_ref(), &Self::signing_message(token_account)) {
            return Err(DerivationError);
        }
        let (keypair, _balance_key) =
            derive_confidential_keys_from_signature(signature).map_err(|_| DerivationError)?;
        Ok(Self(Zeroizing::new(keypair)))
    }

    pub fn signing_message(token_account: &Address) -> Vec<u8> {
        confidential_derivation_message(token_account.as_ref())
    }

    pub fn public_key(&self) -> ElGamalPubkey {
        self.0.pubkey_owned()
    }

    pub(super) fn secret_bytes(&self) -> &[u8; 32] {
        self.0.secret().as_bytes()
    }

    pub(super) fn from_secret_bytes(bytes: &[u8]) -> Result<Self, DerivationError> {
        let secret = ElGamalSecretKey::try_from(bytes).map_err(|_| DerivationError)?;
        Ok(Self(Zeroizing::new(ElGamalKeypair::new(secret))))
    }

    /// Trusted proof code must not copy, log, or serialize the borrowed SDK keypair.
    pub fn with_keypair<R>(&self, use_key: impl FnOnce(&ElGamalKeypair) -> R) -> R {
        use_key(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    use solana_zk_sdk::encryption::derivation::derive_confidential_keys;
    use static_assertions::assert_not_impl_any;

    assert_not_impl_any!(ViewingKey: std::fmt::Debug, std::fmt::Display, serde::Serialize, Clone, Copy);

    #[test]
    fn same_signature_recovers_the_sdk_keypair() {
        let wallet = Keypair::new();
        let account = Address::new_from_array([7; 32]);
        let signature = wallet.sign_message(&ViewingKey::signing_message(&account));
        let first = ViewingKey::derive(&wallet.pubkey(), &account, &signature).unwrap();
        let second = ViewingKey::derive(&wallet.pubkey(), &account, &signature).unwrap();
        let (expected, _) = derive_confidential_keys(&wallet, account.as_ref()).unwrap();
        assert_eq!(first.public_key(), second.public_key());
        assert_eq!(first.public_key(), expected.pubkey_owned());
        first.with_keypair(|key| {
            // Boolean comparisons avoid printing secret bytes on assertion failure.
            assert!(key.secret().as_bytes() == expected.secret().as_bytes());
            second.with_keypair(|other| assert!(key.secret() == other.secret()));
        });
    }

    #[test]
    fn signature_is_bound_to_wallet_account_and_message() {
        let wallet = Keypair::new();
        let account = Address::new_from_array([7; 32]);
        let other = Address::new_from_array([8; 32]);
        let signature = wallet.sign_message(&ViewingKey::signing_message(&account));
        assert!(ViewingKey::derive(&wallet.pubkey(), &other, &signature).is_err());
        assert!(ViewingKey::derive(&Keypair::new().pubkey(), &account, &signature).is_err());
        assert!(ViewingKey::derive(&wallet.pubkey(), &account, &Signature::default()).is_err());
        let wrong_message = wallet.sign_message(b"login");
        assert!(ViewingKey::derive(&wallet.pubkey(), &account, &wrong_message).is_err());
        let other_signature = wallet.sign_message(&ViewingKey::signing_message(&other));
        let first = ViewingKey::derive(&wallet.pubkey(), &account, &signature).unwrap();
        let second = ViewingKey::derive(&wallet.pubkey(), &other, &other_signature).unwrap();
        assert_ne!(first.public_key(), second.public_key());
    }
}
