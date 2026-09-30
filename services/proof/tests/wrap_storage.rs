use cadence_proof::wrap_store::WrapStore;
use tokio_postgres::NoTls;

#[test]
fn storage_configuration_requires_credentials_and_secure_transport() {
    assert!(WrapStore::parse(|_| None).unwrap().is_none());
    assert!(WrapStore::parse(
        |name| (name == "PROOF_SUPABASE_URL").then(|| "https://example.com".into())
    )
    .is_err());
    for url in [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com/?token=secret",
    ] {
        assert!(WrapStore::new(url.parse().unwrap(), "test-public-key", "test-key").is_err());
    }
    assert!(WrapStore::new(
        "http://127.0.0.1:54321".parse().unwrap(),
        "test-public-key",
        "test-key"
    )
    .is_ok());
    assert!(WrapStore::new(
        "https://example.com".parse().unwrap(),
        "test-public-key",
        ""
    )
    .is_err());
}

#[tokio::test]
#[ignore = "requires WRAP_TEST_DATABASE_URL pointing to an empty disposable database"]
async fn wrap_records_are_private_and_confirmations_are_immutable() {
    let url = std::env::var("WRAP_TEST_DATABASE_URL").unwrap();
    let (db, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    let task = tokio::spawn(async move { connection.await.unwrap() });
    db.batch_execute("CREATE ROLE authenticator NOINHERIT; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;").await.unwrap();
    db.batch_execute(include_str!(
        "../../../supabase/migrations/20260929000001_wrap_requests.sql"
    ))
    .await
    .unwrap();
    db.batch_execute("SET ROLE cadence_wrap_service")
        .await
        .unwrap();
    let id = "a".repeat(64);
    db.execute("INSERT INTO public.wrap_requests (id, company_wallet, destination, transaction, last_valid_block_height) VALUES ($1, $2, $2, 'AA==', 100)", &[&id, &"11111111111111111111111111111111"]).await.unwrap();
    for sql in [
        "UPDATE public.wrap_requests SET transaction = 'tampered'",
        "UPDATE public.wrap_requests SET company_wallet = '11111111111111111111111111111112'",
        "DELETE FROM public.wrap_requests",
        "TRUNCATE public.wrap_requests",
        "UPDATE public.wrap_requests SET signature = repeat('2', 88)",
    ] {
        assert!(db.batch_execute(sql).await.is_err(), "{sql}");
    }
    db.batch_execute("UPDATE public.wrap_requests SET signature = repeat('2', 88), slot = 7")
        .await
        .unwrap();
    db.batch_execute("UPDATE public.wrap_requests SET signature = repeat('2', 88), slot = 7")
        .await
        .unwrap();
    assert!(db
        .batch_execute("UPDATE public.wrap_requests SET signature = repeat('3', 88), slot = 8")
        .await
        .is_err());
    assert!(db
        .batch_execute("UPDATE public.wrap_requests SET signature = NULL, slot = NULL")
        .await
        .is_err());
    for role in ["anon", "authenticated", "service_role"] {
        db.batch_execute(&format!("RESET ROLE; SET ROLE {role}"))
            .await
            .unwrap();
        for sql in [
            "SELECT * FROM public.wrap_requests",
            "UPDATE public.wrap_requests SET slot = 9",
            "DELETE FROM public.wrap_requests",
            "INSERT INTO public.wrap_requests DEFAULT VALUES",
        ] {
            assert!(db.batch_execute(sql).await.is_err(), "{role}: {sql}");
        }
    }
    db.batch_execute("RESET ROLE").await.unwrap();
    let row = db.query_one("SELECT signature, slot, relrowsecurity FROM public.wrap_requests, pg_class WHERE oid = 'public.wrap_requests'::regclass", &[]).await.unwrap();
    assert_eq!(row.get::<_, String>(0), "2".repeat(88));
    assert_eq!(row.get::<_, i64>(1), 7);
    assert!(row.get::<_, bool>(2));
    drop(db);
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "requires WRAP_TEST_SUPABASE_URL, WRAP_TEST_API_KEY and WRAP_TEST_SERVICE_JWT for a disposable migrated PostgREST"]
async fn postgrest_persists_requests_and_serializes_confirmation_races() {
    use cadence_proof::wrap_store::{request_id, PreparedWrap};
    use solana_signer::Signer;
    let wallet = solana_keypair::Keypair::new();
    let store = WrapStore::new(
        std::env::var("WRAP_TEST_SUPABASE_URL")
            .unwrap()
            .parse()
            .unwrap(),
        &std::env::var("WRAP_TEST_API_KEY").unwrap(),
        &std::env::var("WRAP_TEST_SERVICE_JWT").unwrap(),
    )
    .unwrap();
    let record = PreparedWrap {
        id: request_id(wallet.pubkey().as_ref()),
        company_wallet: wallet.pubkey().to_string(),
        destination: wallet.pubkey().to_string(),
        transaction: "AA==".into(),
        last_valid_block_height: 123,
        signature: None,
        slot: None,
    };
    store.prepare(&record).await.unwrap();
    assert_eq!(store.get(&record.id).await.unwrap().transaction, "AA==");
    let first = wallet.sign_message(b"first").to_string();
    let second = wallet.sign_message(b"second").to_string();
    let (a, b) = tokio::join!(
        store.confirm(&record.id, &first, 42),
        store.confirm(&record.id, &second, 43)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let stored = store.get(&record.id).await.unwrap();
    let winner = stored.signature.unwrap();
    let slot = stored.slot.unwrap();
    store.confirm(&record.id, &winner, slot).await.unwrap();
    store.prepare(&record).await.unwrap();
    assert_eq!(
        store.get(&record.id).await.unwrap().signature.as_deref(),
        Some(winner.as_str())
    );
}
