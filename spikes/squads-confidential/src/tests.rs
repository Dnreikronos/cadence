use super::*;
use chain::encode;
use solana_zk_sdk::{encryption::elgamal::ElGamalKeypair, zk_elgamal_proof_program::VerifyZkProof};
use spl_token_confidential_transfer_proof_generation::transfer::transfer_split_proof_data;

#[test]
fn independent_keys_configure_a_pda_owned_account_without_a_pda_signing_key() -> Result<()> {
    let creator = Keypair::new();
    let partner = Keypair::new();
    let create_key = Keypair::new();
    let program = Address::from_str_const("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
    let (multisig, _) = Address::find_program_address(
        &[b"multisig", b"multisig", create_key.pubkey().as_ref()],
        &program,
    );
    // Resolve the real SDK's vault through its offline proposal constructor.
    let request = json!({"op": "propose", "rpc_url": "https://api.devnet.solana.com",
        "creator": creator.pubkey().to_string(), "partner": partner.pubkey().to_string(),
        "create_key": create_key.pubkey().to_string(), "instructions": [], "index": 1});
    let response = bridge(request.clone())?;
    let vault = address(&response, "vault")?;
    let account = ConfidentialAccount::new(vault);
    let mint = token_wrap::Addresses::for_usdc().wrapped_mint;
    let validity = build_pubkey_validity_proof_data(&account.elgamal)?;
    validity.verify_proof()?;
    let configure = configure(&account, &mint)?;
    assert_eq!(configure.len(), 2);
    assert!(configure[0]
        .accounts
        .iter()
        .any(|meta| meta.pubkey == vault && meta.is_signer));
    let mut proposal = request;
    proposal["instructions"] = json!([encode(&configure[0])]);
    let stored = decode(&bridge(proposal)?)?;
    assert!(stored
        .iter()
        .flat_map(|ix| &ix.accounts)
        .all(|meta| meta.pubkey != vault || !meta.is_signer));
    let outer = v1::compile_and_sign(
        &stored,
        &creator,
        &[],
        solana_hash::Hash::default(),
        solana_message::v1::TransactionConfig::empty(),
    )?;
    assert_eq!(outer.signatures.len(), 1);
    // PDA authority and account encryption are separate even before any network call.
    assert_ne!(multisig, vault);
    Ok(())
}

#[test]
fn independent_keys_generate_valid_transfer_proofs_and_detect_changed_context() -> Result<()> {
    let source = ElGamalKeypair::new_rand();
    let destination = ElGamalKeypair::new_rand();
    let aes = solana_zk_sdk::encryption::auth_encryption::AeKey::new_rand();
    let balance = source.pubkey().encrypt(FUND - ORDINARY);
    let encrypted = aes.encrypt(FUND - ORDINARY);
    let mut proofs = transfer_split_proof_data(
        &balance,
        &encrypted,
        PAYMENT,
        &source,
        &aes,
        destination.pubkey(),
        None,
    )?;
    proofs.equality_proof_data.verify_proof()?;
    proofs
        .ciphertext_validity_proof_data_with_ciphertext
        .proof_data
        .verify_proof()?;
    proofs.range_proof_data.verify_proof()?;
    proofs.equality_proof_data.context.ciphertext = source.pubkey().encrypt(1u64).into();
    assert!(proofs.equality_proof_data.verify_proof().is_err());
    Ok(())
}
