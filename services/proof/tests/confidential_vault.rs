#[path = "support/confidential.rs"]
mod fixture;

use cadence_proof::{
    keys::{elgamal::ViewingKey, vault},
    solana::confidential::{load_and_build, TransferError},
};
use fixture::{Fixture, AMOUNT};
use solana_signer::Signer;
use solana_zk_elgamal_proof_interface::proof_data::BatchedGroupedCiphertext3HandlesValidityProofData;
use solana_zk_sdk::{
    encryption::{auth_encryption::AeKey, elgamal::ElGamalCiphertext},
    zk_elgamal_proof_program::VerifyZkProof,
};
use tokio_postgres::NoTls;

// Requires a fresh disposable Vault database with tests/support/vault.sql applied.
#[tokio::test]
#[ignore = "requires CONFIDENTIAL_VAULT_TEST_DATABASE_URL for disposable Supabase PostgreSQL"]
async fn builds_only_after_a_durable_audited_key_read() {
    let url = std::env::var("CONFIDENTIAL_VAULT_TEST_DATABASE_URL").unwrap();
    let (admin, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    let guarded: bool = admin
        .query_one(
            "SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'require_vault_ciphertext' AND tgenabled = 'O')",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        guarded,
        "apply tests/support/vault.sql to the disposable instance first"
    );
    admin
        .batch_execute(include_str!(
            "../../../supabase/migrations/20260928000000_decryption_audit_log.sql"
        ))
        .await
        .unwrap();
    admin
        .batch_execute(include_str!(
            "../../../supabase/migrations/20260929000000_encrypted_viewing_keys.sql"
        ))
        .await
        .unwrap();
    admin
        .batch_execute("ALTER ROLE cadence_key_service LOGIN PASSWORD 'proof53-test-only'")
        .await
        .unwrap();
    let mut config: tokio_postgres::Config = url.parse().unwrap();
    config
        .user("cadence_key_service")
        .password("proof53-test-only");
    let (client, connection) = config.connect(NoTls).await.unwrap();
    let client_task = tokio::spawn(async move { connection.await.unwrap() });
    let fixture = Fixture::new();
    let request = fixture.transfer();
    let signature = fixture
        .wallet
        .sign_message(&ViewingKey::signing_message(&request.sender));
    let public = vault::enroll(&client, &request.wallet, &request.sender, &signature)
        .await
        .unwrap();
    assert_eq!(public, fixture.key.public_key().to_bytes());

    let transaction = load_and_build(&client, &request, "proof53-test")
        .await
        .unwrap();
    let solana_message::VersionedMessage::V1(message) = transaction.message else {
        panic!("expected v1")
    };
    let proof: BatchedGroupedCiphertext3HandlesValidityProofData =
        bytemuck::pod_read_unaligned(&message.instructions[3].data[1..]);
    proof.verify_proof().unwrap();
    let lo: ElGamalCiphertext = proof
        .context
        .grouped_ciphertext_lo
        .try_extract_ciphertext(1)
        .unwrap()
        .try_into()
        .unwrap();
    let hi: ElGamalCiphertext = proof
        .context
        .grouped_ciphertext_hi
        .try_extract_ciphertext(1)
        .unwrap()
        .try_into()
        .unwrap();
    assert!(
        lo.decrypt_u32(fixture.recipient_key.secret()).unwrap()
            + (hi.decrypt_u32(fixture.recipient_key.secret()).unwrap() << 16)
            == AMOUNT
    );
    let row = admin
        .query_one(
            "SELECT actor, reason, target_account FROM public.decryption_audit_log",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, &str>(0), "proof53-test");
    assert_eq!(
        row.get::<_, &str>(1),
        "generate confidential transfer proofs"
    );
    assert_eq!(row.get::<_, String>(2), request.sender.to_string());
    assert!(load_and_build(&client, &request, "").await.is_err());

    let wrong_aes = AeKey::new_rand();
    let mut wrong_balance = fixture.transfer();
    wrong_balance.aes_key = &wrong_aes;
    assert!(matches!(
        load_and_build(&client, &wrong_balance, "proof53-test").await,
        Err(TransferError::ProofGeneration)
    ));
    let count: i64 = admin
        .query_one("SELECT count(*) FROM public.decryption_audit_log", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 2);

    admin
        .batch_execute("ALTER TABLE public.decryption_audit_log RENAME TO unavailable_audit_log")
        .await
        .unwrap();
    assert!(matches!(
        load_and_build(&client, &request, "proof53-test").await,
        Err(TransferError::KeyStore(vault::KeyStoreError::Audit(_)))
    ));
    admin
        .batch_execute("ALTER TABLE public.unavailable_audit_log RENAME TO decryption_audit_log")
        .await
        .unwrap();
    let count: i64 = admin
        .query_one("SELECT count(*) FROM public.decryption_audit_log", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 2);
    drop(client);
    client_task.await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
}
