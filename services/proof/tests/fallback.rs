#[path = "support/confidential.rs"]
#[allow(dead_code)]
mod fixture;

use axum::{extract::State, routing::post, Json, Router};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    error::AppError,
    solana::{batch, client::RpcClient, fallback, v1},
};
use serde_json::{json, Value};
use solana_address::Address;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::{Account, AccountState},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

fn funded() -> fixture::Fixture {
    let mut f = fixture::Fixture::new();
    let mut source = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
    source.base.amount = 5_000_000;
    source.pack_base();
    let mut recipient = StateWithExtensionsMut::<Account>::unpack(&mut f.recipient.data).unwrap();
    recipient
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .allow_non_confidential_credits = true.into();
    f
}
fn transfer(f: &fixture::Fixture) -> fallback::Transfer<'_> {
    let t = f.transfer();
    fallback::Transfer {
        mint: t.mint,
        sender: t.sender,
        recipient: t.recipient,
        wallet: t.wallet,
        sender_account: t.sender_account,
        recipient_account: t.recipient_account,
        amount: t.amount,
        blockhash: t.blockhash,
    }
}

#[test]
fn public_transfer_spends_only_public_funds_and_checks_destination_policy() {
    let mut f = funded();
    let t = transfer(&f);
    let tx = fallback::build(&t).unwrap();
    assert!(tx
        .signatures
        .iter()
        .all(|s| *s == solana_signature::Signature::default()));
    let encoded = STANDARD.encode(v1::serialize(&tx).unwrap());
    let public = fallback::transfer(&encoded).unwrap();
    assert_eq!(public.amount, fixture::AMOUNT);
    assert_eq!(public.sender, t.sender);
    assert_eq!(public.mint, t.mint);
    assert_eq!(public.destination, t.recipient);
    assert_eq!(
        *cadence_proof::solana::reveal_risk::received_amount(
            &encoded,
            &t.recipient,
            &t.mint,
            &f.key
        )
        .unwrap(),
        fixture::AMOUNT
    );
    assert!(cadence_proof::solana::reveal_risk::received_amount(
        &encoded, &t.sender, &t.mint, &f.key
    )
    .is_err());
    assert!(!tx
        .message
        .static_account_keys()
        .contains(&solana_zk_elgamal_proof_interface::ID));
    assert!(matches!(
        fallback::build(&fallback::Transfer {
            wallet: Address::new_from_array([99; 32]),
            ..t
        }),
        Err(AppError::Forbidden)
    ));
    assert!(matches!(
        fallback::build(&fallback::Transfer {
            amount: 5_000_001,
            ..t
        }),
        Err(AppError::Conflict("insufficient_public_balance"))
    ));
    let mut recipient = StateWithExtensionsMut::<Account>::unpack(&mut f.recipient.data).unwrap();
    recipient
        .get_extension_mut::<ConfidentialTransferAccount>()
        .unwrap()
        .allow_non_confidential_credits = false.into();
    assert!(matches!(
        fallback::build(&transfer(&f)),
        Err(AppError::Conflict("non_confidential_credits_disabled"))
    ));
    let mut source = StateWithExtensionsMut::<Account>::unpack(&mut f.sender.data).unwrap();
    source.base.state = AccountState::Frozen;
    source.pack_base();
    assert!(matches!(
        fallback::build(&transfer(&f)),
        Err(AppError::Conflict("token_account_frozen"))
    ));
}

#[test]
fn batch_reserves_funds_only_for_successfully_prepared_payments() {
    let f = funded();
    let payments = [
        None,
        Some(f.recipient.clone()),
        Some(f.recipient.clone()),
        Some(f.recipient.clone()),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, account)| batch::Payment {
        recipient: Address::new_from_array([20 + i as u8; 32]),
        account,
        amount: 2_000_000,
    })
    .collect::<Vec<_>>();
    let results = fallback::build_batch(&transfer(&f), &payments);
    assert!(matches!(
        results[0],
        Err(AppError::Conflict("recipient_account_missing"))
    ));
    assert!(results[1].is_ok());
    assert!(results[2].is_ok());
    assert!(matches!(
        results[3],
        Err(AppError::Conflict("insufficient_public_balance"))
    ));
}

fn feature(slot: Option<u64>) -> Value {
    let mut bytes = vec![0; 9];
    if let Some(slot) = slot {
        bytes[0] = 1;
        bytes[1..].copy_from_slice(&slot.to_le_bytes());
    }
    json!({"owner":"Feature111111111111111111111111111111111111", "executable":false,"data":[STANDARD.encode(bytes),"base64"]})
}
async fn rpc(State(result): State<Arc<Mutex<Value>>>, Json(request): Json<Value>) -> Json<Value> {
    assert_eq!(request["method"], "getMultipleAccounts");
    assert_eq!(
        request["params"][0],
        json!([
            solana_zk_elgamal_proof_interface::ID.to_string(),
            fallback::DISABLE.to_string(),
            fallback::REENABLE.to_string()
        ])
    );
    Json(json!({"jsonrpc":"2.0","id":1,"result":result.lock().unwrap().clone()}))
}

#[tokio::test]
async fn availability_rechecks_feature_activation_and_program_presence() {
    let result = Arc::new(Mutex::new(Value::Null));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/", post(rpc))
        .with_state(result.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let rpc = RpcClient::new(url.parse().unwrap(), Duration::from_secs(2)).unwrap();
    for (program, disable, reenable, expected) in [
        (true, Value::Null, Value::Null, true),
        (true, feature(None), Value::Null, true),
        (true, feature(Some(10)), Value::Null, false),
        (true, feature(Some(101)), Value::Null, true),
        (true, feature(Some(10)), feature(Some(20)), true),
        (true, feature(Some(10)), feature(Some(101)), false),
        (false, Value::Null, Value::Null, false),
    ] {
        *result.lock().unwrap() = json!({"context":{"slot":100},"value":[if program{json!({"executable":true})}else{Value::Null},disable,reenable]});
        assert_eq!(fallback::available(&rpc).await.unwrap(), expected);
    }
    for malformed in [
        json!({"context":{"slot":100},"value":[]}),
        json!({"context":{"slot":100},"value":[{"executable":true},{"owner":"wrong"},null]}),
        json!({"context":{"slot":100},"value":[{"executable":"true"},null,null]}),
    ] {
        *result.lock().unwrap() = malformed;
        assert!(matches!(
            fallback::available(&rpc).await,
            Err(AppError::RpcUnavailable)
        ));
    }
    task.abort();
    assert!(matches!(
        fallback::available(&rpc).await,
        Err(AppError::RpcUnavailable)
    ));
}
