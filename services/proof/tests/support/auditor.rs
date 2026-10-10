#[path = "confidential.rs"]
#[allow(dead_code)]
pub mod fixture;

use axum::{
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    auth::SupabaseAuth,
    database::{Database, Session},
    keys::{elgamal::ViewingKey, vault},
    routes::audit::Service,
    solana::{confidential, token_wrap::Addresses, v1},
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_signer::Signer;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::Account,
};
use std::sync::Arc;
use tokio_postgres::{Client, NoTls};

pub const COMPANY_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
pub const COMPANY_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
pub const ADMIN_A: &str = "11111111-1111-4111-8111-111111111111";
pub const ADMIN_B: &str = "22222222-2222-4222-8222-222222222222";
pub const AUDITOR_A: &str = "33333333-3333-4333-8333-333333333333";
pub const AUDITOR_B: &str = "44444444-4444-4444-8444-444444444444";
pub const UNGRANTED: &str = "55555555-5555-4555-8555-555555555555";

async fn user(headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    assert_eq!(headers["apikey"], "public-test-key");
    let id = match headers
        .get("authorization")
        .and_then(|header| header.to_str().ok())
    {
        Some("Bearer admin-a") => ADMIN_A,
        Some("Bearer admin-b") => ADMIN_B,
        Some("Bearer auditor-a") => AUDITOR_A,
        Some("Bearer auditor-b") => AUDITOR_B,
        Some("Bearer ungranted") => UNGRANTED,
        _ => return Err(StatusCode::UNAUTHORIZED),
    };
    Ok(Json(json!({"id": id})))
}

pub struct Harness {
    pub admin: Client,
    pub app: Router,
    url: reqwest::Url,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Harness {
    pub async fn new() -> Self {
        let url = std::env::var("AUDITOR_TEST_DATABASE_URL").unwrap();
        let (admin, driver) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let task = tokio::spawn(async move { driver.await.unwrap() });
        let guarded: bool = admin.query_one("SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname='require_vault_ciphertext' AND tgenabled='O')", &[]).await.unwrap().get(0);
        assert!(
            guarded,
            "apply vault.sql to an empty disposable Supabase instance"
        );
        for migration in [
            include_str!("../../../../supabase/migrations/20260928000000_decryption_audit_log.sql"),
            include_str!(
                "../../../../supabase/migrations/20260929000000_encrypted_viewing_keys.sql"
            ),
            include_str!("../../../../supabase/migrations/20260929000001_wrap_requests.sql"),
            include_str!("../../../../supabase/migrations/20260930000001_wrap_cleanup.sql"),
            include_str!("../../../../supabase/migrations/20261001000000_tenancy.sql"),
            include_str!("../../../../supabase/migrations/20261002000000_accept_invite_hints.sql"),
            include_str!("../../../../supabase/migrations/20261003000000_transfer_requests.sql"),
            include_str!("../../../../supabase/migrations/20261003000001_runs.sql"),
            include_str!("../../../../supabase/migrations/20261004000000_unwrap_requests.sql"),
            include_str!("../../../../supabase/migrations/20261010000000_chain_indexer.sql"),
            include_str!("../../../../supabase/migrations/20261010000001_indexer_scan_checkpoints.sql"),
            include_str!("../../../../supabase/migrations/20261010000002_auditor_grants.sql"),
        ] {
            admin.batch_execute(migration).await.unwrap();
        }
        admin.batch_execute("ALTER ROLE cadence_audit_service LOGIN PASSWORD 'audit59-test-only'; ALTER ROLE cadence_key_service LOGIN PASSWORD 'audit59-test-only';").await.unwrap();
        for id in [ADMIN_A, ADMIN_B, AUDITOR_A, AUDITOR_B, UNGRANTED] {
            admin
                .execute(
                    "INSERT INTO auth.users (id) VALUES ($1::text::uuid)",
                    &[&id],
                )
                .await
                .unwrap();
        }
        for (id, name) in [(COMPANY_A, "Solaris"), (COMPANY_B, "Other company")] {
            admin
                .execute(
                    "INSERT INTO public.companies (id, name) VALUES ($1::text::uuid, $2)",
                    &[&id, &name],
                )
                .await
                .unwrap();
        }
        for (id, company, role) in [
            (ADMIN_A, COMPANY_A, "admin"),
            (ADMIN_B, COMPANY_B, "admin"),
            (AUDITOR_A, COMPANY_A, "auditor"),
            (AUDITOR_B, COMPANY_B, "auditor"),
            (UNGRANTED, COMPANY_A, "auditor"),
        ] {
            admin.execute("INSERT INTO public.memberships (user_id, company_id, role) VALUES ($1::text::uuid, $2::text::uuid, $3::text::public.membership_role)", &[&id, &company, &role]).await.unwrap();
        }
        admin
            .execute(
                "DELETE FROM public.auditor_grants WHERE user_id=$1::text::uuid",
                &[&UNGRANTED],
            )
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = Router::new().route("/auth/v1/user", get(user));
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let mut url: reqwest::Url = url.parse().unwrap();
        url.set_query(Some("sslmode=disable"));
        let mut audit = url.clone();
        audit.set_username("cadence_audit_service").unwrap();
        audit.set_password(Some("audit59-test-only")).unwrap();
        let service = Service::new(
            SupabaseAuth::new(origin.parse().unwrap(), "public-test-key").unwrap(),
            audit.as_str(),
        )
        .unwrap();
        Self {
            admin,
            app: cadence_proof::routes::audit::router(Some(Arc::new(service))),
            url,
            tasks: vec![task, server_task],
        }
    }

    pub async fn auditor(&self, user: &str) -> Session {
        let mut url = self.url.clone();
        url.set_username("cadence_audit_service").unwrap();
        url.set_password(Some("audit59-test-only")).unwrap();
        let session = Database::new(url.as_str(), "cadence_audit_service")
            .unwrap()
            .connect()
            .await
            .unwrap();
        session
            .query_one(
                "SELECT set_config('request.jwt.claim.sub', $1, false)",
                &[&user],
            )
            .await
            .unwrap();
        session
    }

    pub async fn receipt(&self, user: &str, index: u8, run: bool, status: &str) -> String {
        let mut f = fixture::Fixture::new();
        let sender = Address::new_from_array([index; 32]);
        let signature = f.wallet.sign_message(&ViewingKey::signing_message(&sender));
        f.key = ViewingKey::derive(&f.wallet.pubkey(), &sender, &signature).unwrap();
        for account in [&mut f.sender, &mut f.recipient] {
            let mut state = StateWithExtensionsMut::<Account>::unpack(&mut account.data).unwrap();
            state.base.mint = Addresses::for_usdc().wrapped_mint;
            state.pack_base();
        }
        let mut state = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
        let config = state
            .get_extension_mut::<ConfidentialTransferAccount>()
            .unwrap();
        config.elgamal_pubkey = f.key.public_key().into();
        config.available_balance = f.key.public_key().encrypt(fixture::BALANCE).into();
        let mut keys = self.url.clone();
        keys.set_username("cadence_key_service").unwrap();
        keys.set_password(Some("audit59-test-only")).unwrap();
        let key_session = Database::new(keys.as_str(), "cadence_key_service")
            .unwrap()
            .connect()
            .await
            .unwrap();
        vault::enroll(&key_session, &f.wallet.pubkey(), &sender, &signature)
            .await
            .unwrap();
        let mut transfer = f.transfer();
        transfer.mint = Addresses::for_usdc().wrapped_mint;
        transfer.sender = sender;
        let tx = confidential::build(&transfer, &f.key).unwrap();
        let encoded = STANDARD.encode(v1::serialize(&tx).unwrap());
        let chain_signature = f.wallet.sign_message(&tx.message.serialize()).to_string();
        let id = format!("{index:064x}");
        let payment_id = format!("10000000-0000-4000-8000-{index:012}");
        let wallet = f.wallet.pubkey().to_string();
        let source = sender.to_string();
        let destination = transfer.recipient.to_string();
        self.admin
            .execute(
                "INSERT INTO public.proof_wallets (wallet, user_id) VALUES ($1, $2::text::uuid)",
                &[&wallet, &user],
            )
            .await
            .unwrap();
        let signature = (status != "prepared").then_some(chain_signature);
        let slot = signature.as_ref().map(|_| 42_i64);
        if run {
            let run_id: String = self.admin.query_one("INSERT INTO public.runs (user_id, company_wallet, sender) VALUES ($1::text::uuid, $2, $3) RETURNING id::text", &[&user, &wallet, &source]).await.unwrap().get(0);
            self.admin.execute("INSERT INTO public.payments (run_id,position,destination,request_id,transaction,last_valid_block_height,status,signature,slot,payment_id) VALUES ($1::text::uuid,0,$2,$3,$4,500,$5,$6,$7,$8::text::uuid)", &[&run_id, &destination, &id, &encoded, &status, &signature, &slot, &payment_id]).await.unwrap();
        } else {
            self.admin.execute("INSERT INTO public.transfer_requests (id,user_id,company_wallet,sender,destination,transaction,last_valid_block_height,status,signature,slot,payment_id) VALUES ($1,$2::text::uuid,$3,$4,$5,$6,500,$7,$8,$9,$10::text::uuid)", &[&id, &user, &wallet, &source, &destination, &encoded, &status, &signature, &slot, &payment_id]).await.unwrap();
        }
        payment_id
    }

    pub async fn audit_count(&self) -> i64 {
        self.admin
            .query_one("SELECT count(*) FROM public.decryption_audit_log", &[])
            .await
            .unwrap()
            .get(0)
    }
}
