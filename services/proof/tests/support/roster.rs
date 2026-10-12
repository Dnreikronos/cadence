use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::database::{Database, Session};
use serde_json::Value;
use tokio_postgres::Client;
use tower::ServiceExt;

use super::support::{Harness, OTHER, USER};

pub const COMPANY: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
pub const OTHER_COMPANY: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
pub const PERSON: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
pub const UNSET_PERSON: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
pub const OTHER_PERSON: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
pub const ORIGINAL: &str = "27182818284590";
pub const UPDATED: &str = "31415926535897";
pub const OTHER_AMOUNT: &str = "16180339887498";

pub async fn seed(h: &Harness) {
    h.admin
        .execute(
            "INSERT INTO public.companies(id,name) VALUES($1::text::uuid,'Other company')",
            &[&OTHER_COMPANY],
        )
        .await
        .unwrap();
    h.admin
        .execute(
            "UPDATE public.memberships SET company_id=$1::text::uuid,role='admin' WHERE user_id=$2::text::uuid",
            &[&OTHER_COMPANY, &OTHER],
        )
        .await
        .unwrap();
    for (person, company, email) in [
        (PERSON, COMPANY, "person@example.test"),
        (UNSET_PERSON, COMPANY, "unset@example.test"),
        (OTHER_PERSON, OTHER_COMPANY, "other@example.test"),
    ] {
        h.admin
            .execute(
                "INSERT INTO public.people(id,company_id,name,email,kind) VALUES($1::text::uuid,$2::text::uuid,'Roster person',$3,'employee')",
                &[&person, &company, &email],
            )
            .await
            .unwrap();
    }
}

pub async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .header("content-type", "application/json")
                .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

pub async fn expect_write(
    app: &Router,
    person: &str,
    token: Option<&str>,
    amount: &str,
    expected: StatusCode,
) -> Value {
    let path = format!("/company/people/{person}/amount");
    let (status, body) = request(
        app,
        Method::PUT,
        &path,
        token,
        Some(serde_json::json!({"amount":amount})),
    )
    .await;
    assert_eq!(status, expected, "{body}");
    body
}

pub async fn read(h: &Harness, app: &Router, path: &str, other: bool) -> Value {
    let before = h.audit_count().await;
    let (token, actor, company) = if other {
        ("other-user", OTHER, OTHER_COMPANY)
    } else {
        ("test-user", USER, COMPANY)
    };
    let (status, page) = request(app, Method::GET, path, Some(token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(h.audit_count().await, before + 1);
    let audit = h.admin.query_one(
        "SELECT actor,reason,target_company::text FROM public.decryption_audit_log ORDER BY recorded_at DESC LIMIT 1",
        &[],
    ).await.unwrap();
    assert_eq!(audit.get::<_, String>(0), actor);
    assert_eq!(audit.get::<_, String>(1), "read company roster");
    assert_eq!(audit.get::<_, String>(2), company);
    page
}

pub async fn keys() -> Session {
    let mut url: reqwest::Url = std::env::var("TRANSFER_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap();
    url.set_username("cadence_key_service").unwrap();
    url.set_password(Some("transfer54-test-only")).unwrap();
    url.set_query(Some("sslmode=disable"));
    Database::new(url.as_str(), "cadence_key_service")
        .unwrap()
        .connect()
        .await
        .unwrap()
}

pub async fn stored(admin: &Client) -> (String, String, i64) {
    let row = admin.query_one(
        "SELECT r.secret_id::text,s.secret,(SELECT count(*) FROM vault.secrets) FROM cadence_private.roster_amounts r JOIN vault.secrets s ON s.id=r.secret_id WHERE r.person_id=$1::text::uuid",
        &[&PERSON],
    ).await.unwrap();
    (row.get(0), row.get(1), row.get(2))
}

pub async fn direct_access_is_denied(admin: &Client) {
    let rls: bool = admin.query_one(
        "SELECT relrowsecurity FROM pg_class WHERE oid='cadence_private.roster_amounts'::regclass", &[],
    ).await.unwrap().get(0);
    assert!(rls);
    cadence_proof::owner_reads::identity(admin, USER)
        .await
        .unwrap();
    for role in ["anon", "authenticated", "service_role"] {
        admin
            .batch_execute(&format!("SET ROLE {role}"))
            .await
            .unwrap();
        assert!(admin
            .query("SELECT * FROM cadence_private.roster_amounts", &[])
            .await
            .is_err());
        assert!(admin
            .query("SELECT * FROM cadence_private.owner_read_permits", &[])
            .await
            .is_err());
        if role != "service_role" {
            for table in ["vault.secrets", "vault.decrypted_secrets"] {
                assert!(admin
                    .query(&format!("SELECT * FROM {table}"), &[])
                    .await
                    .is_err());
            }
        }
        assert!(admin
            .query(
                "SELECT cadence_private.audit_owner_read('roster',20,NULL)",
                &[]
            )
            .await
            .is_err());
        assert!(admin
            .query(
                "SELECT cadence_private.store_roster_amount($1,$2)",
                &[&PERSON, &ORIGINAL]
            )
            .await
            .is_err());
        admin.batch_execute("RESET ROLE").await.unwrap();
    }
    admin
        .query_one("SELECT set_config('request.jwt.claim.sub','',false)", &[])
        .await
        .unwrap();
    let client = keys().await;
    for table in [
        "cadence_private.roster_amounts",
        "cadence_private.owner_read_permits",
        "vault.secrets",
        "vault.decrypted_secrets",
    ] {
        assert!(client
            .query(&format!("SELECT * FROM {table}"), &[])
            .await
            .is_err());
    }
}

pub fn dump_contains_no_amounts(secret_id: &str) {
    let container = std::env::var("ROSTER_TEST_DUMP_CONTAINER")
        .expect("ROSTER_TEST_DUMP_CONTAINER must name this suite's disposable Supabase container");
    let output = std::process::Command::new("docker")
        .args([
            "exec",
            &container,
            "pg_dump",
            "-U",
            "supabase_admin",
            "-d",
            "keys_test",
            "--data-only",
            "--no-owner",
            "--no-privileges",
        ])
        .output()
        .expect("run pg_dump in the disposable Supabase container");
    assert!(
        output.status.success(),
        "database dump failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let dump = String::from_utf8(output.stdout).unwrap();
    assert!(
        dump.contains(secret_id),
        "dump does not contain this suite's roster secret"
    );
    for table in [
        "cadence_private.roster_amounts",
        "vault.secrets",
        "public.decryption_audit_log",
    ] {
        assert!(
            dump.contains(&format!("COPY {table} ")),
            "dump omitted {table}"
        );
    }
    for (company, person, amount) in [
        (COMPANY, PERSON, ORIGINAL),
        (COMPANY, PERSON, UPDATED),
        (OTHER_COMPANY, OTHER_PERSON, OTHER_AMOUNT),
    ] {
        let payload = format!("roster:1:{company}:{person}:{amount}");
        assert!(
            !dump.contains(amount),
            "dump contains a plaintext roster amount"
        );
        assert!(
            !dump.contains(&STANDARD.encode(payload)),
            "dump contains an encoded plaintext roster payload"
        );
    }
}
