use super::*;
use crate::{auth::SupabaseAuth, routes::wrap_limits::Limits, solana::client::RpcClient};
use axum::{routing::post, Router};
use serde_json::{json, Value};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferMint, BaseStateWithExtensionsMut, ExtensionType,
        StateWithExtensionsMut,
    },
    state::{AccountState, Mint},
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

struct Backend {
    mint: Value,
    sender: Value,
    active: AtomicUsize,
    peak: AtomicUsize,
    completed: AtomicUsize,
}

fn encoded(data: Vec<u8>) -> Value {
    json!({"owner":spl_token_2022_interface::ID.to_string(),"data":[STANDARD.encode(data),"base64"],"lamports":1000000,"executable":false,"rentEpoch":0})
}

async fn rpc(State(backend): State<Arc<Backend>>, Json(request): Json<Value>) -> Json<Value> {
    let result = match request["method"].as_str().unwrap() {
        "getGenesisHash" => json!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
        "getAccountInfo" => {
            let value = if request["params"][0] == Addresses::for_usdc().wrapped_mint.to_string() {
                backend.mint.clone()
            } else if request["params"][0] == Address::new_from_array([3; 32]).to_string() {
                backend.sender.clone()
            } else {
                let active = backend.active.fetch_add(1, Ordering::SeqCst) + 1;
                backend.peak.fetch_max(active, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
                backend.active.fetch_sub(1, Ordering::SeqCst);
                backend.completed.fetch_add(1, Ordering::SeqCst);
                Value::Null
            };
            json!({"value":value})
        }
        "getMinimumBalanceForRentExemption" => json!(3062400),
        "getLatestBlockhash" => {
            json!({"value":{"blockhash":solana_hash::Hash::new_from_array([5;32]).to_string(),"lastValidBlockHeight":500}})
        }
        method => panic!("unexpected RPC {method}"),
    };
    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
}

#[tokio::test]
async fn recipient_reads_are_bounded_and_do_not_need_a_proof_slot() {
    let wallet = Address::new_from_array([6; 32]);
    let mut mint = vec![
        0;
        ExtensionType::try_calculate_account_len::<Mint>(&[
            ExtensionType::ConfidentialTransferMint,
        ])
        .unwrap()
    ];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut mint).unwrap();
    state
        .init_extension::<ConfidentialTransferMint>(true)
        .unwrap()
        .auto_approve_new_accounts = true.into();
    state.base = Mint {
        mint_authority: Some(Addresses::for_usdc().authority).into(),
        decimals: 6,
        is_initialized: true,
        ..Mint::default()
    };
    state.pack_base();
    state.init_account_type().unwrap();
    let mut sender = vec![0; ExtensionType::try_calculate_account_len::<Account>(&[]).unwrap()];
    let mut state = StateWithExtensionsMut::<Account>::unpack_uninitialized(&mut sender).unwrap();
    state.base = Account {
        mint: Addresses::for_usdc().wrapped_mint,
        owner: wallet,
        state: AccountState::Initialized,
        ..Account::default()
    };
    state.pack_base();
    let backend = Arc::new(Backend {
        mint: encoded(mint),
        sender: encoded(sender),
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        completed: AtomicUsize::new(0),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/", post(rpc))
        .with_state(backend.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let service = Arc::new(
        super::super::transfer::Service::new(
            SupabaseAuth::new(origin.parse().unwrap(), "test").unwrap(),
            "postgres://cadence_transfer_service:test@127.0.0.1:1/db?sslmode=disable",
            "postgres://cadence_key_service:test@127.0.0.1:1/db?sslmode=disable",
        )
        .unwrap(),
    );
    let _busy = service
        .proof_slots
        .clone()
        .try_acquire_many_owned(4)
        .unwrap();
    let state = RunState {
        rpc: Arc::new(RpcClient::new(origin.parse().unwrap(), Duration::from_secs(2)).unwrap()),
        service: Some(service),
        limits: Arc::new(Limits::new()),
    };
    let entries = (0..100)
        .map(|i| Entry {
            position: i,
            recipient: Address::new_from_array([20 + i as u8; 32]),
            amount: 1,
            attempt: 0,
        })
        .collect();
    let result = build(
        &state,
        "test",
        wallet,
        Address::new_from_array([3; 32]),
        Zeroizing::new(AeKey::new_rand()),
        entries,
    )
    .await;
    server.abort();
    assert!(matches!(result, Err(AppError::TransferRateLimited)));
    assert_eq!(backend.completed.load(Ordering::SeqCst), 100);
    let peak = backend.peak.load(Ordering::SeqCst);
    assert!(peak > 1 && peak <= 8, "recipient concurrency was {peak}");
}
