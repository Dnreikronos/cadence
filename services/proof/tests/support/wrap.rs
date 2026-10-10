use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    router_with_wrap,
    solana::{
        client::RpcClient,
        token_wrap::{self, Addresses, TOKEN, TOKEN_2022},
        wrap,
    },
    wrap_store::{PreparedWrap, WrapStore},
    AppState,
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_zk_sdk::{
    encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
    zk_elgamal_proof_program::build_pubkey_validity_proof_data,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{ConfidentialTransferAccount, ConfidentialTransferMint},
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    },
    state::{Account, AccountState, Mint},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle};

#[derive(Default)]
pub struct Backend {
    pub accounts: Mutex<HashMap<String, Value>>,
    pub records: Mutex<HashMap<String, PreparedWrap>>,
    pub transaction: Mutex<Value>,
    pub calls: Mutex<Vec<Value>>,
    pub fail_storage: AtomicBool,
    pub wrong_cluster: AtomicBool,
}

pub struct Harness {
    pub app: Router,
    pub wallet: Keypair,
    pub backend: Arc<Backend>,
    task: JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn encoded_account(owner: Address, data: Vec<u8>) -> Value {
    json!({"owner": owner.to_string(), "data": [STANDARD.encode(data), "base64"], "lamports": 1_000_000, "executable": false, "rentEpoch": 0})
}

fn token_account(wallet: Address, mint: Address, confidential: bool) -> Vec<u8> {
    let extensions = if confidential {
        vec![ExtensionType::ConfidentialTransferAccount]
    } else {
        vec![]
    };
    let mut data =
        vec![0; ExtensionType::try_calculate_account_len::<Account>(&extensions).unwrap()];
    let mut state = StateWithExtensionsMut::<Account>::unpack_uninitialized(&mut data).unwrap();
    if confidential {
        let config = state
            .init_extension::<ConfidentialTransferAccount>(true)
            .unwrap();
        config.approved = true.into();
        config.allow_confidential_credits = true.into();
        config.maximum_pending_balance_credit_counter = 65_536.into();
    }
    state.base = Account {
        owner: wallet,
        mint,
        amount: 20_000_000,
        state: AccountState::Initialized,
        ..Account::default()
    };
    state.pack_base();
    state.init_account_type().unwrap();
    data
}

async fn rpc(State(state): State<Arc<Backend>>, Json(request): Json<Value>) -> Json<Value> {
    state.calls.lock().unwrap().push(request.clone());
    let result = match request["method"].as_str().unwrap() {
        "getHealth" => json!("ok"),
        "getGenesisHash" => {
            if state.wrong_cluster.load(Ordering::SeqCst) {
                json!("mainnet")
            } else {
                json!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
            }
        }
        "getLatestBlockhash" => {
            json!({"value": {"blockhash": Hash::new_from_array([8;32]).to_string(), "lastValidBlockHeight": 500}})
        }
        "getAccountInfo" => {
            json!({"value": state.accounts.lock().unwrap().get(request["params"][0].as_str().unwrap()).cloned().unwrap_or(Value::Null)})
        }
        "getTransaction" => state.transaction.lock().unwrap().clone(),
        other => panic!("unexpected RPC: {other}"),
    };
    Json(json!({"jsonrpc": "2.0", "id": 1, "result": result}))
}

fn authorize(headers: &HeaderMap, state: &Backend) -> Result<(), StatusCode> {
    assert_eq!(headers["authorization"], "Bearer test-service-key");
    assert_eq!(headers["apikey"], "test-public-key");
    if state.fail_storage.load(Ordering::SeqCst) {
        Err(StatusCode::SERVICE_UNAVAILABLE)
    } else {
        Ok(())
    }
}

async fn insert(
    State(state): State<Arc<Backend>>,
    headers: HeaderMap,
    Json(record): Json<PreparedWrap>,
) -> Result<StatusCode, StatusCode> {
    authorize(&headers, &state)?;
    assert_eq!(headers["prefer"], "resolution=ignore-duplicates");
    state
        .records
        .lock()
        .unwrap()
        .entry(record.id.clone())
        .or_insert(record);
    Ok(StatusCode::CREATED)
}

async fn select(
    State(state): State<Arc<Backend>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, StatusCode> {
    authorize(&headers, &state)?;
    let id = query["id"].strip_prefix("eq.").unwrap();
    Ok(Json(json!(state
        .records
        .lock()
        .unwrap()
        .get(id)
        .into_iter()
        .collect::<Vec<_>>())))
}

async fn update(
    State(state): State<Arc<Backend>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    authorize(&headers, &state)?;
    assert_eq!(query["signature"], "is.null");
    let mut records = state.records.lock().unwrap();
    let record = records
        .get_mut(query["id"].strip_prefix("eq.").unwrap())
        .unwrap();
    if record.signature.is_some() {
        return Ok(Json(json!([])));
    }
    if body.get("submitted_signature").is_some() {
        return Ok(Json(json!([record])));
    }
    record.signature = Some(body["signature"].as_str().unwrap().into());
    record.slot = body["slot"].as_u64();
    Ok(Json(json!([record])))
}

impl Harness {
    pub async fn new(existing: bool) -> Self {
        let wallet = Keypair::new();
        let addresses = Addresses::for_usdc();
        let mut mint_data = vec![
            0;
            ExtensionType::try_calculate_account_len::<Mint>(&[
                ExtensionType::ConfidentialTransferMint
            ])
            .unwrap()
        ];
        let mut mint =
            StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut mint_data).unwrap();
        mint.init_extension::<ConfidentialTransferMint>(true)
            .unwrap()
            .auto_approve_new_accounts = true.into();
        mint.base = Mint {
            mint_authority: Some(addresses.authority).into(),
            decimals: 6,
            is_initialized: true,
            ..Mint::default()
        };
        mint.pack_base();
        mint.init_account_type().unwrap();
        let backend = Arc::new(Backend::default());
        {
            let mut accounts = backend.accounts.lock().unwrap();
            accounts.insert(
                addresses.wrapped_mint.to_string(),
                encoded_account(TOKEN_2022, mint_data),
            );
            accounts.insert(
                token_wrap::associated_token_address(
                    &wallet.pubkey(),
                    &addresses.unwrapped_mint,
                    &TOKEN,
                )
                .to_string(),
                encoded_account(
                    TOKEN,
                    token_account(wallet.pubkey(), addresses.unwrapped_mint, false),
                ),
            );
            if existing {
                accounts.insert(
                    wrap::destination(&wallet.pubkey()).to_string(),
                    encoded_account(
                        TOKEN_2022,
                        token_account(wallet.pubkey(), addresses.wrapped_mint, true),
                    ),
                );
            }
        }
        let server = Router::new()
            .route("/", post(rpc))
            .route(
                "/rest/v1/wrap_requests",
                post(insert).get(select).patch(update),
            )
            .with_state(backend.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let rpc = Arc::new(RpcClient::new(url.parse().unwrap(), Duration::from_secs(2)).unwrap());
        let store = Arc::new(
            WrapStore::new(url.parse().unwrap(), "test-public-key", "test-service-key").unwrap(),
        );
        Self {
            app: router_with_wrap(
                AppState {
                    rpc,
                    build_sha: "a".repeat(40),
                },
                Some(store),
            ),
            wallet,
            backend,
            task,
        }
    }

    pub fn request(&self, setup: bool) -> Value {
        let mut request =
            json!({"company_wallet": self.wallet.pubkey().to_string(), "amount": "1000000"});
        if setup {
            let proof = build_pubkey_validity_proof_data(&ElGamalKeypair::new_rand()).unwrap();
            let zero: solana_zk_sdk_pod::encryption::auth_encryption::PodAeCiphertext =
                AeKey::new_rand().encrypt(0).into();
            request["setup"] = json!({"pubkey_validity_proof": STANDARD.encode(bytemuck::bytes_of(&proof)), "decryptable_zero_balance": STANDARD.encode(bytemuck::bytes_of(&zero))});
        }
        request
    }
}
