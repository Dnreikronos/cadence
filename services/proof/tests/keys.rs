use cadence_proof::keys::{
    elgamal::ViewingKey,
    vault::{enroll, load, KeyStoreError},
};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tokio_postgres::{Client, NoTls};

async fn count(client: &Client, table: &str) -> i64 {
    client
        .query_one(&format!("SELECT count(*) FROM {table}"), &[])
        .await
        .unwrap()
        .get(0)
}

// Requires an EMPTY database with the real Vault extension (Supabase Postgres).
#[tokio::test]
#[ignore = "requires VAULT_TEST_DATABASE_URL pointing to disposable Supabase PostgreSQL"]
async fn vault_storage_requires_durable_audited_access() {
    let url = std::env::var("VAULT_TEST_DATABASE_URL").unwrap();
    let (admin, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    let guarded: bool = admin.query_one("SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'require_vault_ciphertext' AND tgenabled = 'O')", &[]).await.unwrap().get(0);
    assert!(
        guarded,
        "apply tests/support/vault.sql to the disposable instance first"
    );
    // Apply with the hosted-compatible postgres role, not the extension superuser.
    admin.batch_execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;").await.unwrap();
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
        .batch_execute("ALTER ROLE cadence_key_service LOGIN PASSWORD 'vault-test-only'")
        .await
        .unwrap();
    let mut config: tokio_postgres::Config = url.parse().unwrap();
    config
        .user("cadence_key_service")
        .password("vault-test-only");
    let (client, connection) = config.connect(NoTls).await.unwrap();
    let client_task = tokio::spawn(async move { connection.await.unwrap() });
    let wallet = Keypair::new();
    let account = Address::new_from_array([7; 32]);
    let second_account = Address::new_from_array([8; 32]);
    let signature = wallet.sign_message(&ViewingKey::signing_message(&account));
    let expected = ViewingKey::derive(&wallet.pubkey(), &account, &signature).unwrap();

    // Unsafe logging fails before any key transmission/storage.
    admin
        .batch_execute("ALTER ROLE cadence_key_service SET log_parameter_max_length_on_error = -1")
        .await
        .unwrap();
    let (unsafe_client, connection) = config.connect(NoTls).await.unwrap();
    let unsafe_task = tokio::spawn(async move { connection.await.unwrap() });
    assert!(matches!(
        enroll(&unsafe_client, &wallet.pubkey(), &account, &signature).await,
        Err(KeyStoreError::UnsafeLogging)
    ));
    assert_eq!(count(&admin, "cadence_private.viewing_keys").await, 0);
    drop(unsafe_client);
    unsafe_task.await.unwrap();
    admin
        .batch_execute("ALTER ROLE cadence_key_service SET log_parameter_max_length_on_error = 0")
        .await
        .unwrap();

    let public = enroll(&client, &wallet.pubkey(), &account, &signature)
        .await
        .unwrap();
    assert_eq!(public, expected.public_key().to_bytes());
    assert!(enroll(&client, &wallet.pubkey(), &account, &signature)
        .await
        .is_err());
    assert_eq!(
        count(&admin, "vault.secrets").await,
        1,
        "duplicate must not orphan a secret"
    );
    let second_signature = wallet.sign_message(&ViewingKey::signing_message(&second_account));
    enroll(
        &client,
        &wallet.pubkey(),
        &second_account,
        &second_signature,
    )
    .await
    .unwrap();
    for _ in 0..2 {
        let restored = load(
            &client,
            &wallet.pubkey(),
            &account,
            "user:alice",
            "generate proof",
        )
        .await
        .unwrap();
        assert_eq!(restored.public_key(), expected.public_key());
        restored.with_keypair(|key| {
            expected.with_keypair(|other| assert!(key.secret() == other.secret()))
        });
    }
    assert_eq!(count(&admin, "public.decryption_audit_log").await, 2);
    assert_eq!(count(&admin, "cadence_private.key_read_permits").await, 0);
    let audit = admin
        .query_one(
            "SELECT actor, reason, target_account FROM public.decryption_audit_log LIMIT 1",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(audit.get::<_, String>(0), "user:alice");
    assert_eq!(audit.get::<_, String>(1), "generate proof");
    assert_eq!(audit.get::<_, String>(2), account.to_string());
    assert!(load(&client, &wallet.pubkey(), &account, "", "proof")
        .await
        .is_err());
    assert_eq!(count(&admin, "public.decryption_audit_log").await, 2);

    for sql in [
        "SELECT * FROM vault.decrypted_secrets",
        "SELECT * FROM vault.secrets",
        "SELECT vault.create_secret('forbidden')",
        "SELECT vault._crypto_aead_det_decrypt(''::bytea, ''::bytea, 0)",
        "SELECT * FROM cadence_private.viewing_keys",
        "SELECT * FROM cadence_private.key_read_permits",
        "TRUNCATE cadence_private.viewing_keys",
        "DELETE FROM public.decryption_audit_log",
    ] {
        assert!(client.batch_execute(sql).await.is_err(), "{sql}");
    }
    let read_sql = "SELECT * FROM cadence_private.read_viewing_key($1, $2, $3)";
    let wallet_text = wallet.pubkey().to_string();
    let account_text = account.to_string();
    let fake_permit = "00000000-0000-0000-0000-000000000000";
    assert!(client
        .query(read_sql, &[&wallet_text, &account_text, &fake_permit])
        .await
        .is_err());
    // A permit is account-bound and can be consumed once in autocommit.
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_key_read('user:alice', 'proof', $1)",
            &[&account_text],
        )
        .await
        .unwrap()
        .get(0);
    assert!(client
        .query(
            read_sql,
            &[&wallet_text, &second_account.to_string(), &permit]
        )
        .await
        .is_err());
    client
        .query(read_sql, &[&wallet_text, &account_text, &permit])
        .await
        .unwrap();
    assert!(client
        .query(read_sql, &[&wallet_text, &account_text, &permit])
        .await
        .is_err());
    // A read in an enclosing transaction fails; rolling it back exposes no key.
    client.batch_execute("BEGIN").await.unwrap();
    assert!(
        load(&client, &wallet.pubkey(), &account, "user:alice", "proof")
            .await
            .is_err()
    );
    client.batch_execute("ROLLBACK").await.unwrap();
    assert_eq!(count(&admin, "public.decryption_audit_log").await, 3);
    // Advance the global transaction counter while a permit is uncommitted.
    // Checking the row's xmin (a subtransaction ID) would be unsafe here.
    client.batch_execute("BEGIN").await.unwrap();
    let uncommitted: String = client
        .query_one(
            "SELECT cadence_private.audit_key_read('user:alice', 'proof', $1)",
            &[&account_text],
        )
        .await
        .unwrap()
        .get(0);
    admin
        .query_one("SELECT pg_current_xact_id()::text", &[])
        .await
        .unwrap();
    assert!(client
        .query(read_sql, &[&wallet_text, &account_text, &uncommitted])
        .await
        .is_err());
    client.batch_execute("ROLLBACK").await.unwrap();

    // Failed lookups retain their already committed audit records.
    assert!(load(
        &client,
        &Address::new_from_array([9; 32]),
        &account,
        "user:alice",
        "proof"
    )
    .await
    .is_err());
    assert!(load(
        &client,
        &wallet.pubkey(),
        &Address::new_from_array([9; 32]),
        "user:alice",
        "proof"
    )
    .await
    .is_err());
    assert_eq!(count(&admin, "public.decryption_audit_log").await, 5);
    // Audit failure must stop before the Vault reader is reached.
    admin.batch_execute("ALTER TABLE public.decryption_audit_log ADD CONSTRAINT reject_test_actor CHECK (actor <> 'blocked')").await.unwrap();
    assert!(matches!(
        load(&client, &wallet.pubkey(), &account, "blocked", "proof").await,
        Err(KeyStoreError::Audit(_))
    ));
    assert_eq!(count(&admin, "public.decryption_audit_log").await, 5);

    // Swap public metadata without altering valid Vault ciphertext: payload binding catches it.
    admin.execute("UPDATE cadence_private.viewing_keys SET public_key = decode(repeat('00',32),'hex') WHERE token_account = $1", &[&account_text]).await.unwrap();
    assert!(
        load(&client, &wallet.pubkey(), &account, "user:alice", "proof")
            .await
            .is_err()
    );
    admin
        .execute(
            "UPDATE cadence_private.viewing_keys SET public_key = $1 WHERE token_account = $2",
            &[&&public[..], &account_text],
        )
        .await
        .unwrap();
    // Replace with a valid encrypted payload for another context: binding rejects it.
    admin.execute("SELECT vault.update_secret((SELECT secret_id FROM cadence_private.viewing_keys WHERE token_account = $1), 'wrong-context')", &[&account_text]).await.unwrap();
    assert!(
        load(&client, &wallet.pubkey(), &account, "user:alice", "proof")
            .await
            .is_err()
    );
    assert_eq!(count(&admin, "public.decryption_audit_log").await, 7);

    for role in ["anon", "authenticated"] {
        admin
            .batch_execute(&format!("SET ROLE {role}"))
            .await
            .unwrap();
        for sql in ["SELECT * FROM vault.decrypted_secrets", "SELECT * FROM cadence_private.viewing_keys", "SELECT cadence_private.audit_key_read('alice','proof','11111111111111111111111111111111')"] {
            assert!(admin.batch_execute(sql).await.is_err(), "{role}: {sql}");
        }
        admin.batch_execute("RESET ROLE").await.unwrap();
    }
    let rls: bool = admin.query_one("SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('cadence_private.viewing_keys'::regclass, 'cadence_private.key_read_permits'::regclass)", &[]).await.unwrap().get(0);
    assert!(rls);
    // Inspect stored rows without printing key material on failure.
    let rows = admin
        .query("SELECT secret FROM vault.secrets", &[])
        .await
        .unwrap();
    expected.with_keypair(|key| {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let encoded = STANDARD.encode(key.secret().as_bytes());
        for row in rows {
            assert!(!row.get::<_, String>(0).contains(&encoded));
        }
    });
    drop(client);
    client_task.await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
}
