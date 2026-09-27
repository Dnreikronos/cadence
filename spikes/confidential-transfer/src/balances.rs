//! Reading and re-encrypting a confidential balance.
//!
//! This is the arithmetic `spl_token_client::zk_proofs::confidential_transfer`
//! does, reproduced here because that crate cannot be in this build. It is
//! bookkeeping around the encryption, not cryptography: the proofs still come
//! from `spl-token-confidential-transfer-proof-generation` (ADR B18).
//!
//! Two balances live side by side in the extension. The ElGamal ciphertext is
//! what the proofs are about; the AES `decryptable_available_balance` is what
//! anyone actually reads, because decrypting ElGamal is a discrete-log solve
//! (ADR B3).

use {
    anyhow::{anyhow, Result},
    solana_zk_sdk::encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalKeypair, ElGamalPubkey, ElGamalSecretKey},
    },
    spl_token_2022_interface::extension::confidential_transfer::{
        ConfidentialTransferAccount, PENDING_BALANCE_LO_BIT_LENGTH,
    },
    spl_token_confidential_transfer_proof_generation::transfer::{
        transfer_split_proof_data, TransferProofData,
    },
};

/// The parts of a confidential account this spike needs.
pub struct Balances {
    /// How many `Deposit` and `Transfer` instructions have credited the
    /// pending balance. `ApplyPendingBalance` names this number, but naming it
    /// does not protect anything — the program does not compare it. It folds in
    /// whatever pending balance exists at execution time, stores the AES
    /// balance it was handed, and writes the expected and actual counters into
    /// separate fields for the caller to compare afterwards.
    ///
    /// So a credit landing between the read and the apply produces a
    /// transaction that succeeds with an AES balance that no longer matches the
    /// ElGamal one, and the next proof built from it fails. `applied_cleanly`
    /// is how you find out.
    pub pending_balance_credit_counter: u64,
    expected_pending_balance_credit_counter: u64,
    actual_pending_balance_credit_counter: u64,
    pending_balance_lo: solana_zk_sdk_pod::encryption::elgamal::PodElGamalCiphertext,
    pending_balance_hi: solana_zk_sdk_pod::encryption::elgamal::PodElGamalCiphertext,
    available_balance: solana_zk_sdk_pod::encryption::elgamal::PodElGamalCiphertext,
    decryptable_available_balance: solana_zk_sdk_pod::encryption::auth_encryption::PodAeCiphertext,
}

impl Balances {
    pub fn read(account: &ConfidentialTransferAccount) -> Self {
        Self {
            pending_balance_credit_counter: account.pending_balance_credit_counter.into(),
            expected_pending_balance_credit_counter: account
                .expected_pending_balance_credit_counter
                .into(),
            actual_pending_balance_credit_counter: account
                .actual_pending_balance_credit_counter
                .into(),
            pending_balance_lo: account.pending_balance_lo,
            pending_balance_hi: account.pending_balance_hi,
            available_balance: account.available_balance,
            decryptable_available_balance: account.decryptable_available_balance,
        }
    }

    /// Whether the last `ApplyPendingBalance` folded in exactly what its caller
    /// thought it would.
    ///
    /// Read this after every apply. False means a credit arrived in flight, the
    /// AES and ElGamal balances have diverged, and the AES one has to be
    /// rewritten from the real total before anything else is built on it.
    pub fn applied_cleanly(&self) -> bool {
        self.expected_pending_balance_credit_counter == self.actual_pending_balance_credit_counter
    }

    /// The spendable balance, read the cheap way.
    pub fn available(&self, aes_key: &AeKey) -> Result<u64> {
        let ciphertext = self
            .decryptable_available_balance
            .try_into()
            .map_err(|_| anyhow!("malformed decryptable available balance"))?;
        aes_key
            .decrypt(&ciphertext)
            .ok_or_else(|| anyhow!("could not decrypt the available balance"))
    }

    /// The balance credited but not yet applied. Split in two on chain so each
    /// half stays inside the 32-bit window `decrypt_u32` can search.
    pub fn pending(&self, elgamal_secret_key: &ElGamalSecretKey) -> Result<u64> {
        let lo = self.decrypt_pending(&self.pending_balance_lo, elgamal_secret_key)?;
        let hi = self.decrypt_pending(&self.pending_balance_hi, elgamal_secret_key)?;
        hi.checked_shl(PENDING_BALANCE_LO_BIT_LENGTH)
            .and_then(|high| high.checked_add(lo))
            .ok_or_else(|| anyhow!("pending balance overflows u64"))
    }

    fn decrypt_pending(
        &self,
        ciphertext: &solana_zk_sdk_pod::encryption::elgamal::PodElGamalCiphertext,
        elgamal_secret_key: &ElGamalSecretKey,
    ) -> Result<u64> {
        let ciphertext = (*ciphertext)
            .try_into()
            .map_err(|_| anyhow!("malformed pending balance ciphertext"))?;
        elgamal_secret_key
            .decrypt_u32(&ciphertext)
            .ok_or_else(|| anyhow!("could not decrypt the pending balance"))
    }

    /// The AES balance to write when folding the pending balance in.
    pub fn after_applying_pending(
        &self,
        elgamal_secret_key: &ElGamalSecretKey,
        aes_key: &AeKey,
    ) -> Result<AeCiphertext> {
        let total = self
            .available(aes_key)?
            .checked_add(self.pending(elgamal_secret_key)?)
            .ok_or_else(|| anyhow!("balance overflows u64"))?;
        Ok(aes_key.encrypt(total))
    }

    /// The AES balance to write when sending `amount`.
    pub fn after_sending(&self, amount: u64, aes_key: &AeKey) -> Result<AeCiphertext> {
        let remaining = self
            .available(aes_key)?
            .checked_sub(amount)
            .ok_or_else(|| anyhow!("insufficient confidential balance for {amount}"))?;
        Ok(aes_key.encrypt(remaining))
    }

    /// Equality, ciphertext validity and range proofs for a transfer, split so
    /// each fits its own instruction.
    pub fn transfer_proofs(
        &self,
        amount: u64,
        source_elgamal_keypair: &ElGamalKeypair,
        aes_key: &AeKey,
        destination_elgamal_pubkey: &ElGamalPubkey,
        auditor_elgamal_pubkey: Option<&ElGamalPubkey>,
    ) -> Result<TransferProofData> {
        let available_balance = self
            .available_balance
            .try_into()
            .map_err(|_| anyhow!("malformed available balance ciphertext"))?;
        let decryptable_available_balance = self
            .decryptable_available_balance
            .try_into()
            .map_err(|_| anyhow!("malformed decryptable available balance"))?;

        transfer_split_proof_data(
            &available_balance,
            &decryptable_available_balance,
            amount,
            source_elgamal_keypair,
            aes_key,
            destination_elgamal_pubkey,
            auditor_elgamal_pubkey,
        )
        .map_err(|e| anyhow!("failed to generate transfer proofs: {e}"))
    }
}
