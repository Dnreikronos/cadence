use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::{
    auth::wallet_link_message,
    keys::elgamal::ViewingKey,
    solana::{v0, v1, wrap},
};
use serde::Deserialize;
use serde_json::{json, Value};
use solana_hash::Hash;
use solana_instruction::Instruction;
#[path = "live_contract_funding.rs"]
mod funding;
use solana_keypair::{read_keypair_file, write_keypair_file, Keypair};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_sdk::encryption::derivation::derive_confidential_keys;
use std::{path::PathBuf, str::FromStr, time::Duration};

#[derive(Deserialize)]
pub struct Actor {
    pub user_id: String,
    pub token: String,
    pub wallet_file: PathBuf,
}
impl Actor {
    pub fn wallet(&self) -> Keypair {
        read_keypair_file(&self.wallet_file).expect("read private devnet fixture wallet")
    }
}
#[derive(Deserialize)]
pub struct Fixture {
    pub admin: Actor,
    pub recipient: Actor,
    pub company_id: String,
    pub person_id: String,
    pub funder_file: PathBuf,
    pub supabase_url: String,
    pub anon_key: String,
}
pub struct Live {
    pub fixture: Fixture,
    pub api: String,
    pub outage: String,
    rpc: String,
    output: PathBuf,
    client: reqwest::Client,
}

impl Live {
    pub fn creation_key() -> String {
        let mut bytes: [u8; 16] = Keypair::new().pubkey().as_ref()[..16].try_into().unwrap();
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        uuid::Uuid::from_bytes(bytes).to_string()
    }
    pub async fn new() -> Self {
        let fixture: Fixture = serde_json::from_slice(
            &std::fs::read(std::env::var("LIVE63_FIXTURE").expect("LIVE63_FIXTURE")).unwrap(),
        )
        .unwrap();
        if !fixture.recipient.wallet_file.exists() {
            write_keypair_file(&Keypair::new(), &fixture.recipient.wallet_file).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    &fixture.recipient.wallet_file,
                    std::fs::Permissions::from_mode(0o600),
                )
                .unwrap();
            }
        }
        let api = std::env::var("LIVE63_API").expect("LIVE63_API");
        let outage = std::env::var("LIVE63_OUTAGE_API").expect("LIVE63_OUTAGE_API");
        for url in [&api, &outage, &fixture.supabase_url] {
            assert_eq!(
                reqwest::Url::parse(url).unwrap().host_str(),
                Some("127.0.0.1"),
                "only disposable loopback services are supported"
            );
        }
        let output = PathBuf::from(std::env::var("LIVE63_OUTPUT").expect("LIVE63_OUTPUT"));
        std::fs::create_dir_all(&output).unwrap();
        let live = Self {
            fixture,
            api,
            outage,
            rpc: std::env::var("LIVE63_RPC").expect("LIVE63_RPC"),
            output,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap(),
        };
        assert_eq!(
            live.rpc("getGenesisHash", json!([])).await,
            "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
            "devnet genesis guard"
        );
        live
    }
    pub fn record(&self, name: &str, value: Value) {
        assert!(!name.contains('/'));
        std::fs::write(
            self.output.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
        println!("LIVE63 evidence: {name}");
    }
    pub async fn rpc(&self, method: &str, params: Value) -> Value {
        for attempt in 0..6 {
            let response = self
                .client
                .post(&self.rpc)
                .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
                .send()
                .await;
            if let Ok(response) = response {
                if response.status().is_success() {
                    let body: Value = response.json().await.expect("RPC JSON");
                    if body.get("error").is_none() {
                        return body["result"].clone();
                    }
                    assert!(attempt < 5, "RPC {method} error: {}", body["error"]["code"]);
                } else {
                    assert!(attempt < 5, "RPC {method} HTTP {}", response.status());
                }
            } else {
                assert!(attempt < 5, "RPC {method} unavailable");
            }
            tokio::time::sleep(Duration::from_secs(2 + attempt)).await;
        }
        unreachable!()
    }
    pub async fn call(
        &self,
        origin: &str,
        actor: &Actor,
        path: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let request = match body {
            Some(body) => self.client.post(format!("{origin}{path}")).json(&body),
            None => self.client.get(format!("{origin}{path}")),
        };
        let response = request
            .bearer_auth(&actor.token)
            .send()
            .await
            .expect("local API response");
        let status = response.status().as_u16();
        if path.starts_with("/me/") || path.starts_with("/accounts/") || path.starts_with("/runs") {
            assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        }
        (status, response.json().await.expect("API JSON"))
    }
    pub async fn ok(&self, actor: &Actor, path: &str, body: Option<Value>) -> Value {
        let (status, value) = self.call(&self.api, actor, path, body).await;
        assert_eq!(status, 200, "{path}: {}", value["error"]);
        value
    }
    pub async fn person(&self) -> Value {
        let response = self
            .client
            .get(format!(
                "{}/rest/v1/people?select=id,user_id,status&id=eq.{}",
                self.fixture.supabase_url, self.fixture.person_id
            ))
            .header("apikey", &self.fixture.anon_key)
            .bearer_auth(&self.fixture.admin.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        response.json::<Value>().await.unwrap()[0].clone()
    }
    pub fn signed(&self, wallet: &Keypair, prepared: &Value) -> VersionedTransaction {
        let mut tx: VersionedTransaction = wincode::deserialize(
            &STANDARD
                .decode(prepared["transaction"].as_str().expect("prepared wire"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(tx.message.static_account_keys()[0], wallet.pubkey());
        assert_eq!(tx.message.header().num_required_signatures, 1);
        assert_eq!(tx.signatures, vec![solana_signature::Signature::default()]);
        if let Some(version) = prepared["transaction_version"].as_u64() {
            assert_eq!(
                version,
                match tx.message {
                    solana_message::VersionedMessage::V1(_) => 1,
                    solana_message::VersionedMessage::V0(_) => 0,
                    _ => panic!("unexpected transaction version"),
                }
            );
        }
        tx.signatures[0] = wallet.sign_message(&tx.message.serialize());
        tx
    }
    pub async fn execute(&self, name: &str, tx: &VersionedTransaction) -> (String, u64) {
        let encoded = STANDARD.encode(v1::serialize(tx).unwrap());
        let signature = tx.signatures[0].to_string();
        // Retain the exact intended signature before sending; retries never change the message.
        self.record(&format!("{name}-submission"), json!({"signature":signature,"wire_sha256":cadence_proof::wrap_store::request_id(&v1::serialize(tx).unwrap())}));
        assert_eq!(self.rpc("sendTransaction", json!([encoded,{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":3}])).await, signature);
        for _ in 0..90 {
            let result = self.rpc("getTransaction", json!([signature,{"encoding":"base64","commitment":"finalized","maxSupportedTransactionVersion":1}])).await;
            if !result.is_null() {
                self.record(&format!("{name}-chain"), json!({"signature":signature,"slot":result["slot"],"meta_error":result["meta"]["err"],"commitment":"finalized","exact_wire":result["transaction"][0]==encoded,"version":result["version"]}));
                assert!(
                    result["meta"]["err"].is_null(),
                    "finalized {name} failed: {}",
                    result["meta"]["err"]
                );
                assert_eq!(result["transaction"][0], encoded, "exact submitted bytes");
                return (signature, result["slot"].as_u64().unwrap());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        panic!("{name}: unresolved finality; retain original signature, do not replace");
    }
    pub async fn send(&self, name: &str, payer: &Keypair, instructions: &[Instruction]) {
        let hash = self
            .rpc("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
            .await;
        let mut tx = v0::compile_unsigned(
            instructions,
            &payer.pubkey(),
            Hash::from_str(hash["value"]["blockhash"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        tx.signatures[0] = payer.sign_message(&tx.message.serialize());
        self.execute(name, &tx).await;
    }
    pub async fn enroll(&self, actor: &Actor) {
        let wallet = actor.wallet();
        let account = wrap::destination(&wallet.pubkey());
        let discovered = self.ok(actor,"/accounts/discover",Some(json!({"wallet":wallet.pubkey().to_string(),"wallet_signature":wallet.sign_message(&wallet_link_message(&actor.user_id,&wallet.pubkey())).to_string()}))).await;
        assert_eq!(discovered["token_account"], account.to_string());
        let message = STANDARD
            .decode(discovered["derivation_message"].as_str().unwrap())
            .unwrap();
        assert_eq!(message, ViewingKey::signing_message(&account));
        let enrollment = json!({"wallet":wallet.pubkey().to_string(),"token_account":account.to_string(),"signature":wallet.sign_message(&message).to_string()});
        assert_eq!(
            self.ok(actor, "/keys/enroll", Some(enrollment.clone()))
                .await["status"],
            "enrolled"
        );
        assert_eq!(
            self.ok(actor, "/keys/enroll", Some(enrollment)).await["status"],
            "enrolled"
        );
    }
    pub fn aes(&self) -> String {
        let wallet = self.fixture.admin.wallet();
        let (_, aes) =
            derive_confidential_keys(&wallet, wrap::destination(&wallet.pubkey()).as_ref())
                .unwrap();
        let bytes: [u8; 16] = (&aes).into();
        STANDARD.encode(bytes)
    }
    pub fn run_body(&self, key: &str, amount: &str) -> Value {
        let wallet = self.fixture.admin.wallet();
        let recipient = self.fixture.recipient.wallet();
        json!({"company_wallet":wallet.pubkey().to_string(),"sender":wrap::destination(&wallet.pubkey()).to_string(),"aes_key":self.aes(),"idempotency_key":key,"payments":[{"recipient":wrap::destination(&recipient.pubkey()).to_string(),"amount":amount}]})
    }
    pub async fn public_balance(&self) -> u64 {
        let wallet = self.fixture.recipient.wallet();
        self.rpc(
            "getTokenAccountBalance",
            json!([wrap::destination(&wallet.pubkey()).to_string(),{"commitment":"finalized"}]),
        )
        .await["value"]["amount"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }
}
