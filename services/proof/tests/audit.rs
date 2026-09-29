use cadence_proof::audit::log::{append, AuditEntry, AuditError};
use tokio_postgres::{error::SqlState, NoTls};

const TARGET: &str = "11111111111111111111111111111111";

#[test]
fn requires_attribution_and_a_valid_target() {
    for blank in ["", " ", "\t\r\n", "\u{2003}"] {
        assert!(matches!(
            AuditEntry::new(blank, "balance view", TARGET),
            Err(AuditError::MissingActor)
        ));
        assert!(matches!(
            AuditEntry::new("user:alice", blank, TARGET),
            Err(AuditError::MissingReason)
        ));
    }
    for invalid in ["", "not-a-key", "111111111111111111111111111111111"] {
        assert!(matches!(
            AuditEntry::new("user:alice", "balance view", invalid),
            Err(AuditError::InvalidTarget)
        ));
    }
    assert!(AuditEntry::new("service:proof", "generate transfer proof", TARGET).is_ok());
}

// Explicitly opt in: this test creates roles and a table in an EMPTY disposable DB.
#[tokio::test]
#[ignore = "requires AUDIT_TEST_DATABASE_URL pointing to an empty disposable Postgres database"]
async fn postgres_enforces_append_only_attributed_access() {
    let url =
        std::env::var("AUDIT_TEST_DATABASE_URL").expect("AUDIT_TEST_DATABASE_URL is required");
    let (client, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    let task = tokio::spawn(async move { connection.await.unwrap() });
    client.batch_execute("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;").await.unwrap();
    // Model Supabase's permissive defaults: the migration must remove them.
    client.batch_execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;").await.unwrap();
    client
        .batch_execute(include_str!(
            "../../../supabase/migrations/20260928000000_decryption_audit_log.sql"
        ))
        .await
        .unwrap();
    client.batch_execute("SET ROLE service_role").await.unwrap();
    let entry = AuditEntry::new("user:alice", "balance view", TARGET).unwrap();
    append(&client, &entry).await.unwrap();

    for sql in [
        "SELECT * FROM public.decryption_audit_log",
        "UPDATE public.decryption_audit_log SET reason = 'tampered'",
        "DELETE FROM public.decryption_audit_log",
        "TRUNCATE public.decryption_audit_log",
        "ALTER TABLE public.decryption_audit_log DISABLE ROW LEVEL SECURITY",
        "DROP TABLE public.decryption_audit_log",
        "INSERT INTO public.decryption_audit_log (actor, reason, target_account, recorded_at) VALUES ('alice', 'view', '11111111111111111111111111111111', '2000-01-01')",
    ] {
        let error = client.batch_execute(sql).await.expect_err(sql);
        assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE), "{sql}");
    }
    for (actor, reason) in [
        (Some("alice"), Some(" \t\n")),
        (Some(""), Some("view")),
        (None, Some("view")),
        (Some("alice"), None),
    ] {
        let error = client.execute("INSERT INTO public.decryption_audit_log (actor, reason, target_account) VALUES ($1, $2, $3)", &[&actor, &reason, &TARGET]).await.unwrap_err();
        assert!(matches!(
            error.code(),
            Some(&SqlState::CHECK_VIOLATION) | Some(&SqlState::NOT_NULL_VIOLATION)
        ));
    }
    for role in ["anon", "authenticated"] {
        client
            .batch_execute(&format!("RESET ROLE; SET ROLE {role}"))
            .await
            .unwrap();
        let error = client
            .query("SELECT * FROM public.decryption_audit_log", &[])
            .await
            .unwrap_err();
        assert_eq!(error.code(), Some(&SqlState::INSUFFICIENT_PRIVILEGE));
        assert!(matches!(
            append(&client, &entry).await,
            Err(AuditError::Unavailable)
        ));
    }
    client.batch_execute("RESET ROLE").await.unwrap();
    let rows = client.query("SELECT actor, reason, target_account, recorded_at BETWEEN now() - interval '1 minute' AND clock_timestamp() FROM public.decryption_audit_log", &[]).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, String>(0), "user:alice");
    assert_eq!(rows[0].get::<_, String>(1), "balance view");
    assert_eq!(rows[0].get::<_, String>(2), TARGET);
    assert!(rows[0].get::<_, bool>(3));
    drop(client);
    task.await.unwrap();
}
