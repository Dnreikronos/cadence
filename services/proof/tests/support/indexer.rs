use axum::{extract::State, routing::post, Json, Router};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    indexer::{
        store::{Kind, Pending},
        Indexer,
    },
    solana::{client::RpcClient, v0, v1},
    wrap_store::request_id,
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_postgres::{Client, NoTls};

pub const USER: &str = "11111111-1111-4111-8111-111111111111";
pub const RUN: &str = "22222222-2222-4222-8222-222222222222";

#[derive(Default)]
pub struct Backend {
    pub transactions: Mutex<HashMap<String, Value>>,
    pub history: Mutex<Vec<String>>,
    pub wallet_history: Mutex<HashMap<String, Vec<String>>>,
    pub slots: Mutex<HashMap<String, u64>>,
    pub blocks: Mutex<HashMap<u64, Value>>,
    pub first_available: AtomicU64,
    pub height: AtomicU64,
    pub calls: Mutex<Vec<Value>>,
    pub unavailable: AtomicBool,
    pub delay: AtomicBool,
    pub history_delay: AtomicBool,
    pub history_waiting: AtomicBool,
}
async fn rpc(State(state): State<Arc<Backend>>, Json(request): Json<Value>) -> Json<Value> {
    state.calls.lock().unwrap().push(request.clone());
    if state.delay.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    if request["method"] == "getSignaturesForAddress" && state.history_delay.load(Ordering::SeqCst)
    {
        state.history_waiting.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(2)).await;
        state.history_waiting.store(false, Ordering::SeqCst);
    }
    if state.unavailable.load(Ordering::SeqCst) {
        return Json(
            json!({"jsonrpc":"2.0","id":1,"error":{"message":"secret-provider-url-and-amount"}}),
        );
    }
    let result = match request["method"].as_str().unwrap() {
        "getHealth" => json!("ok"),
        "getGenesisHash" => json!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
        "getBlockHeight" => json!(state.height.load(Ordering::SeqCst)),
        "getFirstAvailableBlock" => json!(state.first_available.load(Ordering::SeqCst)),
        "getBlock" => {
            assert_eq!(request["params"][1]["commitment"], "finalized");
            assert_eq!(request["params"][1]["transactionDetails"], "none");
            let block = state
                .blocks
                .lock()
                .unwrap()
                .get(&request["params"][0].as_u64().unwrap())
                .cloned()
                .unwrap_or(json!({"blockHeight":42}));
            if block.get("error").is_some() {
                return Json(json!({"jsonrpc":"2.0","id":1,"error":block["error"]}));
            }
            block
        }
        "getTransaction" => state
            .transactions
            .lock()
            .unwrap()
            .get(request["params"][0].as_str().unwrap())
            .cloned()
            .unwrap_or(Value::Null),
        "getSignaturesForAddress" => {
            assert_eq!(request["params"][1]["commitment"], "finalized");
            let history = state
                .wallet_history
                .lock()
                .unwrap()
                .get(request["params"][0].as_str().unwrap())
                .cloned()
                .unwrap_or_else(|| state.history.lock().unwrap().clone());
            let slots = state.slots.lock().unwrap();
            let start = request["params"][1]["before"]
                .as_str()
                .map(|s| history.iter().position(|h| h == s).unwrap() + 1)
                .unwrap_or(0);
            let end = request["params"][1]["until"]
                .as_str()
                .and_then(|s| history.iter().position(|h| h == s))
                .unwrap_or(history.len());
            // Short pages exercise pagination independently of the requested limit.
            json!(history[start..end.max(start)]
                .iter()
                .take(2)
                .map(
                    |s| json!({"signature":s,"slot":slots.get(s).copied().unwrap_or(42),"err":null,"confirmationStatus":"finalized"})
                )
                .collect::<Vec<_>>())
        }
        other => panic!("unexpected RPC {other}"),
    };
    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
}

pub fn payment(
    wallet: &Keypair,
    kind: Kind,
    nonce: u8,
    tracked: bool,
    failed: bool,
) -> (Pending, String, Value) {
    let hash = Hash::new_from_array([nonce; 32]);
    let mut tx = if kind == Kind::Wrap {
        v0::compile_unsigned(&[], &wallet.pubkey(), hash).unwrap()
    } else {
        v1::compile_unsigned(&[], &wallet.pubkey(), hash).unwrap()
    };
    let bytes = v1::serialize(&tx).unwrap();
    let id = request_id(&bytes);
    tx.signatures[0] = wallet.sign_message(&tx.message.serialize());
    let signature = tx.signatures[0].to_string();
    let receipt = json!({"slot":42,"meta":{"err":if failed { json!({"InstructionError":[0,"amount-and-secret"]}) } else { Value::Null }},"transaction":[STANDARD.encode(v1::serialize(&tx).unwrap()),"base64"]});
    (
        Pending {
            kind,
            id,
            wallet: wallet.pubkey().to_string(),
            transaction: STANDARD.encode(bytes),
            signature: tracked.then(|| signature.clone()),
            last_valid_block_height: 1,
        },
        signature,
        receipt,
    )
}

pub struct Harness {
    pub db: Client,
    pub indexer: Arc<Indexer>,
    pub backend: Arc<Backend>,
    pub wallet: Keypair,
    pub origin: String,
    pub receipts_url: String,
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
    pub async fn new(websocket: reqwest::Url) -> Self {
        let url = std::env::var("INDEXER_TEST_DATABASE_URL").unwrap();
        let (db, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let driver = tokio::spawn(async move { connection.await.unwrap() });
        assert!(
            db.query_one("SELECT to_regclass('public.payments') IS NULL", &[])
                .await
                .unwrap()
                .get::<_, bool>(0),
            "use an empty disposable database"
        );
        for migration in [
            include_str!("../../../../supabase/migrations/20260929000001_wrap_requests.sql"),
            include_str!("../../../../supabase/migrations/20260930000001_wrap_cleanup.sql"),
            include_str!("../../../../supabase/migrations/20261003000000_transfer_requests.sql"),
            include_str!("../../../../supabase/migrations/20261003000001_runs.sql"),
            include_str!("../../../../supabase/migrations/20261004000000_unwrap_requests.sql"),
            include_str!("../../../../supabase/migrations/20261010000000_chain_indexer.sql"),
            include_str!(
                "../../../../supabase/migrations/20261010000001_indexer_scan_checkpoints.sql"
            ),
        ] {
            db.batch_execute(migration).await.unwrap();
        }
        db.batch_execute("ALTER ROLE cadence_indexer LOGIN PASSWORD 'indexer-test-only'; ALTER ROLE cadence_transfer_service LOGIN PASSWORD 'indexer-test-only'; INSERT INTO auth.users(id) VALUES ('11111111-1111-4111-8111-111111111111')").await.unwrap();
        let mut receipts: reqwest::Url = url.parse().unwrap();
        receipts.set_username("cadence_indexer").unwrap();
        receipts.set_password(Some("indexer-test-only")).unwrap();
        receipts.set_query(Some("sslmode=disable"));
        let backend = Arc::new(Backend::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/", post(rpc))
            .with_state(backend.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let rpc =
            Arc::new(RpcClient::new(origin.parse().unwrap(), Duration::from_secs(3)).unwrap());
        let indexer = Arc::new(Indexer::new(rpc, receipts.as_str(), websocket).unwrap());
        let wallet = Keypair::new();
        db.execute(
            "INSERT INTO public.proof_wallets(wallet,user_id) VALUES ($1,$2::text::uuid)",
            &[&wallet.pubkey().to_string(), &USER],
        )
        .await
        .unwrap();
        db.execute("INSERT INTO public.runs(id,user_id,company_wallet,sender) VALUES ($1::text::uuid,$2::text::uuid,$3,$4)",&[&RUN,&USER,&wallet.pubkey().to_string(),&Address::new_from_array([7;32]).to_string()]).await.unwrap();
        Self {
            db,
            indexer,
            backend,
            wallet,
            origin,
            receipts_url: receipts.to_string(),
            tasks: vec![driver, server],
        }
    }
    pub async fn insert(&self, p: &Pending, position: i16) {
        let destination = Address::new_from_array([position as u8 + 20; 32]).to_string();
        let expiry = i64::try_from(p.last_valid_block_height).unwrap();
        match p.kind {
            Kind::Run => {
                self.db.execute("INSERT INTO public.payments(run_id,position,destination,request_id,transaction,last_valid_block_height,status,submitted_signature) VALUES ($1::text::uuid,$2,$3,$4,$5,$7,'prepared',$6)",&[&RUN,&position,&destination,&p.id,&p.transaction,&p.signature,&expiry]).await.unwrap();
            }
            Kind::Wrap => {
                self.db.execute("INSERT INTO public.wrap_requests(id,company_wallet,destination,transaction,last_valid_block_height,submitted_signature) VALUES ($1,$2,$3,$4,$6,$5)",&[&p.id,&p.wallet,&destination,&p.transaction,&p.signature,&expiry]).await.unwrap();
            }
            kind => {
                let (table, wallet, source) = if kind == Kind::Transfer {
                    ("transfer_requests", "company_wallet", "sender")
                } else {
                    ("unwrap_requests", "wallet", "source")
                };
                self.db.execute(&format!("INSERT INTO public.{table}(id,user_id,{wallet},{source},destination,transaction,last_valid_block_height,submitted_signature) VALUES ($1,$2::text::uuid,$3,$4,$4,$5,$7,$6)"),&[&p.id,&USER,&p.wallet,&destination,&p.transaction,&p.signature,&expiry]).await.unwrap();
            }
        }
    }
    pub async fn events(&self) -> i64 {
        self.db
            .query_one("SELECT count(*) FROM public.payment_events", &[])
            .await
            .unwrap()
            .get(0)
    }
    pub async fn assert_status(&self, p: &Pending, status: &str) {
        let (table, id) = match p.kind {
            Kind::Run => ("payments", "request_id"),
            Kind::Wrap => ("wrap_requests", "id"),
            Kind::Transfer => ("transfer_requests", "id"),
            Kind::Unwrap => ("unwrap_requests", "id"),
        };
        let row = self
            .db
            .query_one(
                &format!("SELECT status FROM public.{table} WHERE {id}=$1"),
                &[&p.id],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), status);
    }
}
