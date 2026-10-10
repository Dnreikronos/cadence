use crate::{
    request,
    support::{Harness, ADMIN_A, ADMIN_B, AUDITOR_A, AUDITOR_B, COMPANY_A, COMPANY_B},
};
use axum::http::StatusCode;
use serde_json::{json, Value};

/// Exercise SQL permits directly so HTTP validation cannot mask commit, replay or grant failures.
pub async fn permits(h: &Harness) {
    let auditor = h.auditor(AUDITOR_A).await;
    let permit: String = auditor
        .query_one(
            "SELECT cadence_private.audit_company_read($1,20,NULL)",
            &[&COMPANY_A],
        )
        .await
        .unwrap()
        .get(0);
    let other = h.auditor(AUDITOR_B).await;
    assert!(other
        .query(
            "SELECT * FROM cadence_private.read_company_payments($1,$2)",
            &[&COMPANY_A, &permit]
        )
        .await
        .is_err());
    auditor
        .query(
            "SELECT * FROM cadence_private.read_company_payments($1,$2)",
            &[&COMPANY_A, &permit],
        )
        .await
        .unwrap();
    assert!(
        auditor
            .query(
                "SELECT * FROM cadence_private.read_company_payments($1,$2)",
                &[&COMPANY_A, &permit]
            )
            .await
            .is_err(),
        "permit is single use"
    );
    let expired: String = auditor
        .query_one(
            "SELECT cadence_private.audit_company_read($1,20,NULL)",
            &[&COMPANY_A],
        )
        .await
        .unwrap()
        .get(0);
    h.admin.execute("UPDATE cadence_private.company_read_permits SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::text::uuid", &[&expired]).await.unwrap();
    assert!(
        auditor
            .query(
                "SELECT * FROM cadence_private.read_company_payments($1,$2)",
                &[&COMPANY_A, &expired]
            )
            .await
            .is_err(),
        "expired permits cannot decrypt"
    );
    auditor.batch_execute("BEGIN").await.unwrap();
    let uncommitted: String = auditor
        .query_one(
            "SELECT cadence_private.audit_company_read($1,20,NULL)",
            &[&COMPANY_A],
        )
        .await
        .unwrap()
        .get(0);
    assert!(auditor
        .query(
            "SELECT * FROM cadence_private.read_company_payments($1,$2)",
            &[&COMPANY_A, &uncommitted]
        )
        .await
        .is_err());
    auditor.batch_execute("ROLLBACK").await.unwrap();
    let permit: String = auditor
        .query_one(
            "SELECT cadence_private.audit_company_read($1,20,NULL)",
            &[&COMPANY_A],
        )
        .await
        .unwrap()
        .get(0);
    h.admin
        .execute(
            "DELETE FROM public.auditor_grants WHERE user_id=$1::text::uuid",
            &[&AUDITOR_A],
        )
        .await
        .unwrap();
    assert!(
        auditor
            .query(
                "SELECT * FROM cadence_private.read_company_payments($1,$2)",
                &[&COMPANY_A, &permit]
            )
            .await
            .is_err(),
        "recheck a revoked grant before Vault access"
    );
    request(
        h,
        "POST",
        "/company/auditor-grants",
        "admin-a",
        json!({"auditor_id": AUDITOR_A}),
    )
    .await;
}

/// Move memberships to test historical scope, then force failures on either side of audit commit.
pub async fn attribution_and_failures(h: &Harness) {
    let path = format!("/audit/{COMPANY_A}/payments");
    // Moving the payer's membership cannot move already attributed receipts.
    h.admin
        .execute(
            "DELETE FROM public.memberships WHERE user_id=$1::text::uuid",
            &[&ADMIN_B],
        )
        .await
        .unwrap();
    h.admin
        .execute(
            "UPDATE public.memberships SET company_id=$2::text::uuid WHERE user_id=$1::text::uuid",
            &[&ADMIN_A, &COMPANY_B],
        )
        .await
        .unwrap();
    assert!(h
        .admin
        .execute(
            "UPDATE public.runs SET company_id=$1::text::uuid WHERE user_id=$2::text::uuid",
            &[&COMPANY_B, &ADMIN_A]
        )
        .await
        .is_err());
    assert_eq!(
        request(h, "GET", &path, "auditor-a", Value::Null).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let (_, other_page) = request(
        h,
        "GET",
        &format!("/audit/{COMPANY_B}/payments"),
        "auditor-b",
        Value::Null,
    )
    .await;
    assert_eq!(other_page["items"].as_array().unwrap().len(), 1);

    // A failed read retains its committed log; a failed audit decrypts nothing.
    h.admin.batch_execute("ALTER TABLE public.decryption_audit_log ADD CONSTRAINT reject_auditor_reads CHECK (reason <> 'read company payments') NOT VALID").await.unwrap();
    let before = h.audit_count().await;
    assert_eq!(
        request(h, "GET", &path, "auditor-a", Value::Null).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(h.audit_count().await, before);
    h.admin.batch_execute("ALTER TABLE public.decryption_audit_log DROP CONSTRAINT reject_auditor_reads; DELETE FROM cadence_private.viewing_keys;").await.unwrap();
    assert_eq!(
        request(h, "GET", &path, "auditor-a", Value::Null).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(h.audit_count().await, before + 1);
}
