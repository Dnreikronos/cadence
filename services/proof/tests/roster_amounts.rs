#[path = "support/roster.rs"]
mod roster;
#[path = "support/transfer.rs"]
#[allow(dead_code)]
mod support;

use axum::http::{Method, StatusCode};
use cadence_proof::owner_reads;
use roster::*;
use serde_json::json;

/// Verify encrypted writes, attributed reads and access denial in a fresh Vault fixture.
///
/// Requires an empty disposable database and its dump container; the harness applies
/// migrations and this scenario changes roles, grants and audit constraints.
#[tokio::test]
#[ignore = "requires a fresh TRANSFER_TEST_DATABASE_URL with vault.sql and ROSTER_TEST_DUMP_CONTAINER"]
async fn roster_amounts_remain_encrypted_and_require_attributed_company_access() {
    let h = support::Harness::new().await;
    seed(&h).await;
    let app = h.app();
    let roster_path = "/company/people/amounts";

    for token in [None, Some("invalid-token")] {
        let before = h.audit_count().await;
        assert_eq!(
            request(&app, Method::GET, roster_path, token, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        expect_write(&app, PERSON, token, ORIGINAL, StatusCode::UNAUTHORIZED).await;
        assert_eq!(h.audit_count().await, before);
    }
    for amount in ["0", "-1", "1.5", "281474976710656"] {
        expect_write(
            &app,
            PERSON,
            Some("test-user"),
            amount,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
    let page = read(&h, &app, roster_path, false).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["amount"].is_null()));
    expect_write(&app, PERSON, Some("test-user"), ORIGINAL, StatusCode::OK).await;
    let (secret_id, ciphertext, secrets) = stored(&h.admin).await;
    assert!(!ciphertext.contains(ORIGINAL));
    expect_write(&app, PERSON, Some("test-user"), UPDATED, StatusCode::OK).await;
    let before = h.audit_count().await;
    let (status, saved) = request(
        &app,
        Method::POST,
        &format!("/company/people/{}/amount", PERSON.to_uppercase()),
        Some("test-user"),
        Some(json!({"amount":format!("0{UPDATED}")})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved, json!({"person_id":PERSON,"amount":UPDATED}));
    assert_eq!(
        h.audit_count().await,
        before,
        "writes must not decrypt stored amounts"
    );
    let (updated_id, updated_ciphertext, updated_secrets) = stored(&h.admin).await;
    assert_eq!(secret_id, updated_id);
    assert_eq!(
        secrets, updated_secrets,
        "updates must not orphan Vault secrets"
    );
    assert!(ciphertext != updated_ciphertext);

    let first = read(&h, &app, "/company/people/amounts?limit=1", false).await;
    assert_eq!(first["items"][0]["person_id"], PERSON);
    assert_eq!(first["items"][0]["amount"], UPDATED);
    assert!(first["items"][0]["token_account"].is_null());
    assert_eq!(first["next_cursor"], PERSON);
    let second = read(
        &h,
        &app,
        &format!("/company/people/amounts?limit=1&cursor={PERSON}"),
        false,
    )
    .await;
    assert_eq!(second["items"][0]["person_id"], UNSET_PERSON);
    assert!(second["items"][0]["amount"].is_null());
    assert!(second["next_cursor"].is_null());
    let empty = read(
        &h,
        &app,
        &format!("/company/people/amounts?cursor={UNSET_PERSON}"),
        false,
    )
    .await;
    assert_eq!(empty["items"], json!([]));

    expect_write(
        &app,
        OTHER_PERSON,
        Some("test-user"),
        ORIGINAL,
        StatusCode::NOT_FOUND,
    )
    .await;
    expect_write(
        &app,
        PERSON,
        Some("other-user"),
        OTHER_AMOUNT,
        StatusCode::NOT_FOUND,
    )
    .await;
    expect_write(
        &app,
        OTHER_PERSON,
        Some("other-user"),
        OTHER_AMOUNT,
        StatusCode::OK,
    )
    .await;
    let other = read(&h, &app, roster_path, true).await;
    assert_eq!(other["items"].as_array().unwrap().len(), 1);
    assert_eq!(other["items"][0]["person_id"], OTHER_PERSON);
    assert_eq!(other["items"][0]["amount"], OTHER_AMOUNT);
    let own = read(&h, &app, roster_path, false).await;
    assert_eq!(own["items"][0]["amount"], UPDATED);
    assert!(!own.to_string().contains(OTHER_AMOUNT));

    for role in ["recipient", "auditor"] {
        h.admin.execute("UPDATE public.memberships SET role=$1::text::public.membership_role WHERE user_id=$2::text::uuid", &[&role, &support::OTHER]).await.unwrap();
        let before = h.audit_count().await;
        assert_eq!(
            request(&app, Method::GET, roster_path, Some("other-user"), None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        expect_write(
            &app,
            OTHER_PERSON,
            Some("other-user"),
            ORIGINAL,
            StatusCode::FORBIDDEN,
        )
        .await;
        assert_eq!(h.audit_count().await, before);
    }
    h.admin
        .execute(
            "UPDATE public.memberships SET role='admin' WHERE user_id=$1::text::uuid",
            &[&support::OTHER],
        )
        .await
        .unwrap();
    h.admin
        .execute(
            "UPDATE public.people SET status='removed' WHERE id=$1::text::uuid",
            &[&UNSET_PERSON],
        )
        .await
        .unwrap();
    expect_write(
        &app,
        UNSET_PERSON,
        Some("test-user"),
        ORIGINAL,
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_eq!(
        read(&h, &app, roster_path, false).await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    direct_access_is_denied(&h.admin).await;
    dump_contains_no_amounts(&secret_id);

    // Misconfigured logging must reject the write before an amount is transmitted.
    h.admin
        .batch_execute("ALTER ROLE cadence_key_service SET log_parameter_max_length_on_error = -1")
        .await
        .unwrap();
    let error = expect_write(
        &app,
        PERSON,
        Some("test-user"),
        ORIGINAL,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    assert!(!error.to_string().contains(ORIGINAL));
    assert!(stored(&h.admin).await.1 == updated_ciphertext);
    h.admin
        .batch_execute("ALTER ROLE cadence_key_service SET log_parameter_max_length_on_error = 0")
        .await
        .unwrap();

    let client = keys().await;
    owner_reads::identity(&client, support::USER).await.unwrap();
    let read_sql = "SELECT * FROM cadence_private.read_roster_amounts($1)";
    assert!(client
        .query(read_sql, &[&"00000000-0000-0000-0000-000000000000"])
        .await
        .is_err());
    let before = h.audit_count().await;
    client.batch_execute("BEGIN").await.unwrap();
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read('roster',20,NULL)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(client.query(read_sql, &[&permit]).await.is_err());
    client.batch_execute("ROLLBACK").await.unwrap();
    assert_eq!(h.audit_count().await, before);
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read('company',20,NULL)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(client.query(read_sql, &[&permit]).await.is_err());
    let permit: String = client
        .query_one(
            "SELECT cadence_private.audit_owner_read('roster',20,NULL)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    owner_reads::identity(&client, support::OTHER)
        .await
        .unwrap();
    assert!(client.query(read_sql, &[&permit]).await.is_err());
    owner_reads::identity(&client, support::USER).await.unwrap();
    let rows = client.query(read_sql, &[&permit]).await.unwrap();
    assert_eq!(rows[0].get::<_, String>("amount"), UPDATED);
    assert!(client.query(read_sql, &[&permit]).await.is_err());

    // A failed audit must stop access, and a later failed decryption keeps its audit.
    h.admin.batch_execute("ALTER TABLE public.decryption_audit_log ADD CONSTRAINT reject_roster_audit CHECK (reason <> 'read company roster') NOT VALID").await.unwrap();
    let before = h.audit_count().await;
    let (status, error) = request(&app, Method::GET, roster_path, Some("test-user"), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(h.audit_count().await, before);
    assert!(!error.to_string().contains(UPDATED));
    h.admin
        .batch_execute(
            "ALTER TABLE public.decryption_audit_log DROP CONSTRAINT reject_roster_audit",
        )
        .await
        .unwrap();
    let wrong_payload = format!("roster:1:{OTHER_COMPANY}:{OTHER_PERSON}:{OTHER_AMOUNT}");
    h.admin
        .execute(
            "SELECT vault.update_secret($1::text::uuid,$2)",
            &[&secret_id, &wrong_payload],
        )
        .await
        .unwrap();
    let (status, error) = request(&app, Method::GET, roster_path, Some("test-user"), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(h.audit_count().await, before + 1);
    assert!(!error.to_string().contains(OTHER_AMOUNT));
    dump_contains_no_amounts(&secret_id);
}
