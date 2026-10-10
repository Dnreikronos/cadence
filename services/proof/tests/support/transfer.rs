#[path = "confidential.rs"]
pub mod fixture;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    auth::{wallet_link_message, SupabaseAuth},
    database::Database,
    keys::{elgamal::ViewingKey, vault},
    router_with_payments,
    routes::transfer::Service,
    solana::{client::RpcClient, token_wrap::Addresses},
    AppState,
};
use fixture::Fixture;
use serde_json::{json, Value};
use solana_account::Account as RpcAccount;
use solana_signer::Signer;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferMint, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::{Account, Mint},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_postgres::{Client, NoTls};

pub const USER: &str = "11111111-1111-4111-8111-111111111111";
pub const OTHER: &str = "22222222-2222-4222-8222-222222222222";

#[derive(Default)]
pub struct Backend {
    pub accounts: Mutex<HashMap<String, Value>>,
    pub transaction: Mutex<Value>,
    pub transactions: Mutex<HashMap<String, Value>>,
    pub finalized_height: AtomicU64,
    pub unavailable_accounts: Mutex<HashSet<String>>,
    pub delayed_accounts: Mutex<HashMap<String, Duration>>,
    pub active_account_reads: AtomicUsize,
    pub peak_account_reads: AtomicUsize,
    pub calls: Mutex<Vec<Value>>,
    pub wrong_cluster: AtomicBool,
}
pub struct Harness {
    pub fixture: Fixture,
    pub backend: Arc<Backend>,
    pub admin: Client,
    rpc: Arc<RpcClient>,
    service: Arc<Service>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
pub fn encoded(account: &RpcAccount) -> Value {
    json!({"owner": account.owner.to_string(), "data": [STANDARD.encode(&account.data), "base64"], "lamports": account.lamports, "executable": account.executable, "rentEpoch": 0})
}
async fn user(headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    assert_eq!(headers["apikey"], "test-public-key");
    let id = match headers["authorization"].to_str().unwrap() {
        "Bearer test-user" => USER,
        "Bearer other-user" => OTHER,
        _ => return Err(StatusCode::UNAUTHORIZED),
    };
    Ok(Json(json!({"id": id})))
}
async fn rpc(State(state): State<Arc<Backend>>, Json(request): Json<Value>) -> Json<Value> {
    state.calls.lock().unwrap().push(request.clone());
    let delay = if request["method"] == "getAccountInfo" {
        state
            .delayed_accounts
            .lock()
            .unwrap()
            .get(request["params"][0].as_str().unwrap())
            .copied()
    } else {
        None
    };
    if let Some(delay) = delay {
        let active = state.active_account_reads.fetch_add(1, Ordering::SeqCst) + 1;
        state.peak_account_reads.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(delay).await;
        state.active_account_reads.fetch_sub(1, Ordering::SeqCst);
    }
    if request["method"] == "getAccountInfo"
        && state
            .unavailable_accounts
            .lock()
            .unwrap()
            .contains(request["params"][0].as_str().unwrap())
    {
        return Json(
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"sensitive-value"}}),
        );
    }
    let result = match request["method"].as_str().unwrap() {
        "getGenesisHash" => {
            if state.wrong_cluster.load(Ordering::SeqCst) {
                json!("mainnet")
            } else {
                json!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
            }
        }
        "getLatestBlockhash" => {
            json!({"value": {"blockhash": solana_hash::Hash::new_from_array([5;32]).to_string(), "lastValidBlockHeight": 500}})
        }
        "getMinimumBalanceForRentExemption" => json!(3_062_400),
        "getAccountInfo" => {
            json!({"value": state.accounts.lock().unwrap().get(request["params"][0].as_str().unwrap()).cloned().unwrap_or(Value::Null)})
        }
        "getBlockHeight" => json!(state.finalized_height.load(Ordering::SeqCst)),
        "getTransaction" => state
            .transactions
            .lock()
            .unwrap()
            .get(request["params"][0].as_str().unwrap())
            .cloned()
            .unwrap_or_else(|| state.transaction.lock().unwrap().clone()),
        other => panic!("unexpected RPC: {other}"),
    };
    Json(json!({"jsonrpc": "2.0", "id": 1, "result": result}))
}

impl Harness {
    pub async fn new() -> Self {
        let url = std::env::var("TRANSFER_TEST_DATABASE_URL").unwrap();
        let (admin, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let admin_task = tokio::spawn(async move { connection.await.unwrap() });
        let guarded: bool = admin.query_one("SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'require_vault_ciphertext' AND tgenabled = 'O')", &[]).await.unwrap().get(0);
        assert!(
            guarded,
            "apply tests/support/vault.sql to an empty disposable Supabase instance"
        );
        admin
            .batch_execute(include_str!(
                "../../../../supabase/migrations/20260928000000_decryption_audit_log.sql"
            ))
            .await
            .unwrap();
        admin
            .batch_execute(include_str!(
                "../../../../supabase/migrations/20260929000000_encrypted_viewing_keys.sql"
            ))
            .await
            .unwrap();
        admin
            .batch_execute(include_str!(
                "../../../../supabase/migrations/20261003000000_transfer_requests.sql"
            ))
            .await
            .unwrap();
        for migration in [
            include_str!("../../../../supabase/migrations/20260929000001_wrap_requests.sql"),
            include_str!("../../../../supabase/migrations/20260930000001_wrap_cleanup.sql"),
            include_str!("../../../../supabase/migrations/20261003000001_runs.sql"),
            include_str!("../../../../supabase/migrations/20261004000000_unwrap_requests.sql"),
            include_str!("../../../../supabase/migrations/20261010000000_chain_indexer.sql"),
        ] {
            admin.batch_execute(migration).await.unwrap();
        }
        admin.batch_execute("ALTER ROLE cadence_key_service LOGIN PASSWORD 'transfer54-test-only'; ALTER ROLE cadence_transfer_service LOGIN PASSWORD 'transfer54-test-only'; INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');").await.unwrap();
        let mut keys: reqwest::Url = url.parse().unwrap();
        keys.set_username("cadence_key_service").unwrap();
        keys.set_password(Some("transfer54-test-only")).unwrap();
        keys.set_query(Some("sslmode=disable"));
        let mut receipts = keys.clone();
        receipts.set_username("cadence_transfer_service").unwrap();
        let fixture = Fixture::new();
        let key_db = Database::new(keys.as_str(), "cadence_key_service").unwrap();
        let client = key_db.connect().await.unwrap();
        let sender = fixture.transfer().sender;
        let signature = fixture
            .wallet
            .sign_message(&ViewingKey::signing_message(&sender));
        let public = vault::enroll(&client, &fixture.wallet.pubkey(), &sender, &signature)
            .await
            .unwrap();
        assert_eq!(public, fixture.key.public_key().to_bytes());
        drop(client);
        let backend = Arc::new(Backend::default());
        let mut mint = fixture.mint.clone();
        let addresses = Addresses::for_usdc();
        {
            let mut state = StateWithExtensionsMut::<Mint>::unpack(&mut mint.data).unwrap();
            state.base.mint_authority = Some(addresses.authority).into();
            state
                .get_extension_mut::<ConfidentialTransferMint>()
                .unwrap()
                .auto_approve_new_accounts = true.into();
            state.pack_base();
        }
        let mut source = fixture.sender.clone();
        let mut destination = fixture.recipient.clone();
        for account in [&mut source, &mut destination] {
            let mut state = StateWithExtensionsMut::<Account>::unpack(&mut account.data).unwrap();
            state.base.mint = addresses.wrapped_mint;
            state.pack_base();
        }
        {
            let mut accounts = backend.accounts.lock().unwrap();
            accounts.insert(addresses.wrapped_mint.to_string(), encoded(&mint));
            accounts.insert(sender.to_string(), encoded(&source));
            accounts.insert(
                fixture.transfer().recipient.to_string(),
                encoded(&destination),
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = Router::new()
            .route("/", post(rpc))
            .route("/auth/v1/user", get(user))
            .with_state(backend.clone());
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let rpc =
            Arc::new(RpcClient::new(origin.parse().unwrap(), Duration::from_secs(2)).unwrap());
        let service = Arc::new(
            Service::new(
                SupabaseAuth::new(origin.parse().unwrap(), "test-public-key").unwrap(),
                receipts.as_str(),
                keys.as_str(),
            )
            .unwrap(),
        );
        Self {
            fixture,
            backend,
            admin,
            rpc,
            service,
            tasks: vec![admin_task, server_task],
        }
    }
    pub fn app(&self) -> Router {
        router_with_payments(
            AppState {
                rpc: self.rpc.clone(),
                build_sha: "a".repeat(40),
            },
            None,
            Some(self.service.clone()),
        )
    }
    pub fn request(&self) -> Value {
        let transfer = self.fixture.transfer();
        let key: [u8; 16] = (&self.fixture.aes).into();
        json!({"company_wallet": transfer.wallet.to_string(), "sender": transfer.sender.to_string(), "recipient": transfer.recipient.to_string(), "amount": fixture::AMOUNT.to_string(), "aes_key": STANDARD.encode(key), "wallet_signature": self.fixture.wallet.sign_message(&wallet_link_message(USER, &transfer.wallet)).to_string()})
    }
    pub async fn audit_count(&self) -> i64 {
        self.admin
            .query_one("SELECT count(*) FROM public.decryption_audit_log", &[])
            .await
            .unwrap()
            .get(0)
    }
}
