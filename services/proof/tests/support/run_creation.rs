use cadence_proof::run_store::{Run, RunStore};
use std::{sync::Arc, time::Duration};
use tokio_postgres::Client;

fn same_payload(actual: Run, expected: Run) {
    assert_eq!(actual.id, expected.id);
    assert_eq!(actual.company_wallet, expected.company_wallet);
    assert_eq!(actual.sender, expected.sender);
    assert_eq!(actual.payments.len(), expected.payments.len());
    for (actual, expected) in actual.payments.iter().zip(&expected.payments) {
        assert_eq!(actual.position, expected.position);
        assert_eq!(actual.destination, expected.destination);
        assert_eq!(actual.attempt, expected.attempt);
        assert_eq!(actual.request_id, expected.request_id);
        assert_eq!(actual.transaction, expected.transaction);
        assert_eq!(
            actual.last_valid_block_height,
            expected.last_valid_block_height
        );
    }
}

async fn wait_for_lock(admin: &Client) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: bool = admin
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted \
                     AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            if waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the duplicate creation must wait for the owner's lock");
}

pub async fn slow_owner(admin: &Client, key: &str) {
    let mut url: reqwest::Url = std::env::var("TRANSFER_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap();
    url.set_username("cadence_transfer_service").unwrap();
    url.set_password(Some("transfer54-test-only")).unwrap();
    url.set_query(Some("sslmode=disable"));
    let store = Arc::new(RunStore::new(url.as_str()).unwrap());
    let user = super::support::USER;
    let (owner, original) = store.creation(user, key).await.unwrap();
    let original = original.unwrap();
    let waiting_store = store.clone();
    let waiting_key = key.to_owned();
    let waiter = tokio::spawn(async move { waiting_store.creation(user, &waiting_key).await });
    wait_for_lock(admin).await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert!(
        !waiter.is_finished(),
        "slow proof generation must not time out recovery"
    );
    owner.batch_execute("COMMIT").await.unwrap();
    let (recovery, run) = waiter.await.unwrap().unwrap();
    same_payload(run.unwrap(), original);
    let settings = recovery
        .query_one(
            "SELECT current_setting('statement_timeout'), current_setting('lock_timeout')",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(settings.get::<_, &str>(0), "5s");
    assert_eq!(settings.get::<_, &str>(1), "5s");
    recovery.batch_execute("COMMIT").await.unwrap();

    let (owner, _) = store.creation(user, key).await.unwrap();
    let waiting_store = store.clone();
    let waiting_key = key.to_owned();
    let waiter = tokio::spawn(async move { waiting_store.creation(user, &waiting_key).await });
    wait_for_lock(admin).await;
    waiter.abort();
    assert!(matches!(waiter.await, Err(error) if error.is_cancelled()));
    owner.batch_execute("COMMIT").await.unwrap();
    let (recovery, _) = tokio::time::timeout(Duration::from_secs(3), store.creation(user, key))
        .await
        .expect("cancelled recovery must release its connection and transaction")
        .unwrap();
    recovery.batch_execute("COMMIT").await.unwrap();
    assert_eq!(
        admin
            .query_one("SELECT count(*) FROM public.runs", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
}
