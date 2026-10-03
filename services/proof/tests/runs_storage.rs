use cadence_proof::{
    error::AppError,
    run_store::{Payment, RunStore, Status},
};
use tokio_postgres::NoTls;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

#[tokio::test]
#[ignore = "requires RUNS_TEST_DATABASE_URL for an empty disposable PostgreSQL database"]
async fn run_storage_is_private_atomic_and_preserves_attempts() {
    let url = std::env::var("RUNS_TEST_DATABASE_URL").unwrap();
    let (db, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    let task = tokio::spawn(async move { connection.await.unwrap() });
    db.batch_execute("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$; GRANT USAGE ON SCHEMA public, auth TO authenticated; INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');").await.unwrap();
    db.batch_execute(include_str!(
        "../../../supabase/migrations/20261003000000_transfer_requests.sql"
    ))
    .await
    .unwrap();
    db.batch_execute(include_str!(
        "../../../supabase/migrations/20261003000001_runs.sql"
    ))
    .await
    .unwrap();
    db.batch_execute("ALTER ROLE cadence_transfer_service LOGIN PASSWORD 'runs-test-only'; INSERT INTO public.proof_wallets (wallet,user_id) VALUES (repeat('1',32),'11111111-1111-4111-8111-111111111111');").await.unwrap();
    let mut receipts: reqwest::Url = url.parse().unwrap();
    receipts.set_username("cadence_transfer_service").unwrap();
    receipts.set_password(Some("runs-test-only")).unwrap();
    receipts.set_query(Some("sslmode=disable"));
    let store = RunStore::new(receipts.as_str()).unwrap();
    let mut p = Payment {
        position: 0,
        destination: "2".repeat(32),
        attempt: 0,
        request_id: Some("a".repeat(64)),
        transaction: Some("AA==".into()),
        last_valid_block_height: Some(500),
        status: Status::Prepared,
        signature: None,
        slot: None,
        error: None,
    };
    let run = store
        .prepare(
            USER,
            &"1".repeat(32),
            &"3".repeat(32),
            std::slice::from_ref(&p),
        )
        .await
        .unwrap();
    assert!(matches!(
        store.get(OTHER, &run.id).await,
        Err(AppError::RunNotFound)
    ));
    assert!(store
        .retry(USER, &run.id, std::slice::from_ref(&p))
        .await
        .is_err());
    p.status = Status::Failed;
    p.signature = Some("4".repeat(88));
    p.slot = Some(12);
    p.error = Some("transaction_failed".into());
    let (a, b) = tokio::join!(
        store.finish(USER, &run.id, &p),
        store.finish(USER, &run.id, &p)
    );
    a.unwrap();
    b.unwrap();
    p.status = Status::Prepared;
    p.request_id = Some("b".repeat(64));
    p.transaction = Some("AQ==".into());
    p.signature = None;
    p.slot = None;
    p.error = None;
    let (a, b) = tokio::join!(
        store.retry(USER, &run.id, std::slice::from_ref(&p)),
        store.retry(USER, &run.id, std::slice::from_ref(&p))
    );
    assert!(a.is_ok() ^ b.is_ok());
    let history = db
        .query_one("SELECT status, signature FROM public.payment_attempts", &[])
        .await
        .unwrap();
    assert_eq!(history.get::<_, String>(0), "failed");
    assert_eq!(history.get::<_, String>(1), "4".repeat(88));
    p.attempt = 1;
    p.status = Status::Finalized;
    p.signature = Some("5".repeat(88));
    p.slot = Some(14);
    store.finish(USER, &run.id, &p).await.unwrap();
    assert!(store
        .retry(USER, &run.id, std::slice::from_ref(&p))
        .await
        .is_err());
    p.signature = Some("6".repeat(88));
    assert!(store.finish(USER, &run.id, &p).await.is_err());
    let before: i64 = db
        .query_one("SELECT count(*) FROM public.runs", &[])
        .await
        .unwrap()
        .get(0);
    let fresh = |position, id| Payment {
        position,
        destination: "7".repeat(32),
        attempt: 0,
        request_id: Some(id),
        transaction: Some("AA==".into()),
        last_valid_block_height: Some(500),
        status: Status::Prepared,
        signature: None,
        slot: None,
        error: None,
    };
    assert!(store
        .prepare(
            USER,
            &"1".repeat(32),
            &"3".repeat(32),
            &[fresh(0, "d".repeat(64)), fresh(100, "e".repeat(64))]
        )
        .await
        .is_err());
    assert_eq!(
        db.query_one("SELECT count(*) FROM public.runs", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        before
    );
    assert_eq!(db.query_one("SELECT count(*) FROM pg_class WHERE relname IN ('runs','payments','payment_attempts') AND relrowsecurity",&[]).await.unwrap().get::<_,i64>(0),3);
    for role in ["anon", "service_role"] {
        db.batch_execute(&format!("SET ROLE {role}")).await.unwrap();
        for table in ["runs", "payments", "payment_attempts"] {
            assert!(db
                .batch_execute(&format!("SELECT * FROM public.{table}"))
                .await
                .is_err());
        }
        db.batch_execute("RESET ROLE").await.unwrap();
    }
    db.batch_execute(
        "SET ROLE authenticated; SET request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'",
    )
    .await
    .unwrap();
    for table in ["runs", "payments"] {
        let row = db
            .query_one(&format!("SELECT count(*) FROM public.{table}"), &[])
            .await
            .unwrap();
        assert_eq!(row.get::<_, i64>(0), 0);
        assert!(db
            .batch_execute(&format!("DELETE FROM public.{table}"))
            .await
            .is_err());
    }
    db.batch_execute("SET request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'")
        .await
        .unwrap();
    assert_eq!(
        db.query_one("SELECT count(*) FROM public.payments", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    db.batch_execute("RESET ROLE; SET ROLE cadence_transfer_service")
        .await
        .unwrap();
    for sql in [
        "DELETE FROM public.payments",
        "UPDATE public.payments SET transaction='tampered'",
        "UPDATE public.payments SET signature=repeat('7',88)",
        "DELETE FROM public.payment_attempts",
    ] {
        assert!(db.batch_execute(sql).await.is_err());
    }
    db.batch_execute("RESET ROLE").await.unwrap();
    let rows = db.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('runs','payments','payment_attempts')",&[]).await.unwrap();
    for row in rows {
        let column: String = row.get(0);
        assert!(!["amount", "aes_key", "wallet_signature", "secret"].contains(&column.as_str()));
    }
    drop(db);
    task.await.unwrap();
}
