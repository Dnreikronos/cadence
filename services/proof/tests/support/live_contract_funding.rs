use super::{json, read_keypair_file, Live, Signer};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_proof::solana::token_wrap::{self, Addresses, TOKEN};
impl Live {
    pub async fn fund_recipient(&self) {
        let admin = self.fixture.admin.wallet();
        let recipient = self.fixture.recipient.wallet();
        let balance = self
            .rpc(
                "getBalance",
                json!([recipient.pubkey().to_string(),{"commitment":"finalized"}]),
            )
            .await;
        assert_eq!(balance["value"], 0, "requires fresh disposable recipient");
        self.send(
            "recipient-sol-funding",
            &admin,
            &[solana_system_interface::instruction::transfer(
                &admin.pubkey(),
                &recipient.pubkey(),
                30_000_000,
            )],
        )
        .await;
    }
    pub async fn fund_public(&self) {
        let funder = read_keypair_file(&self.fixture.funder_file).unwrap();
        let admin = self.fixture.admin.wallet();
        let addresses = Addresses::for_usdc();
        let source = token_wrap::associated_token_address(
            &funder.pubkey(),
            &addresses.unwrapped_mint,
            &TOKEN,
        );
        let destination = token_wrap::associated_token_address(
            &admin.pubkey(),
            &addresses.unwrapped_mint,
            &TOKEN,
        );
        let funding_receipt = self.output.join("public-usdc-funding-chain.json");
        if funding_receipt.exists() {
            let receipt: serde_json::Value =
                serde_json::from_slice(&std::fs::read(funding_receipt).unwrap()).unwrap();
            let submitted: serde_json::Value = serde_json::from_slice(
                &std::fs::read(self.output.join("public-usdc-funding-submission.json")).unwrap(),
            )
            .unwrap();
            let chain = self
                .rpc(
                    "getTransaction",
                    json!([receipt["signature"], {"encoding":"base64","commitment":"finalized","maxSupportedTransactionVersion":1}]),
                )
                .await;
            assert!(!chain.is_null(), "retain unresolved original funding");
            assert!(chain["meta"]["err"].is_null());
            assert_eq!(
                cadence_proof::wrap_store::request_id(
                    &STANDARD
                        .decode(chain["transaction"][0].as_str().unwrap())
                        .unwrap()
                ),
                submitted["wire_sha256"]
            );
            self.record("public-funding-reused", receipt);
        } else {
            self.send(
                "public-usdc-funding",
                &funder,
                &[
                    token_wrap::create_associated_token_account_idempotent(
                        &funder.pubkey(),
                        &admin.pubkey(),
                        &addresses.unwrapped_mint,
                        &TOKEN,
                    ),
                    spl_token_2022_interface::instruction::transfer_checked(
                        &TOKEN,
                        &source,
                        &addresses.unwrapped_mint,
                        &destination,
                        &funder.pubkey(),
                        &[],
                        10_000,
                        6,
                    )
                    .unwrap(),
                ],
            )
            .await;
        }
        let wrapped = self.output.join("public-wrap-confirmed.json");
        if wrapped.exists() {
            let receipt: serde_json::Value =
                serde_json::from_slice(&std::fs::read(wrapped).unwrap()).unwrap();
            let stored = self
                .ok(
                    &self.fixture.admin,
                    "/wrap/confirm",
                    Some(json!({"request_id":receipt["request_id"],"signature":receipt["signature"]})),
                )
                .await;
            assert_eq!(stored, receipt, "reuse the original finalized wrap");
            self.record("public-wrap-reused", stored);
            return;
        }
        let p = self.ok(&self.fixture.admin,"/wrap",Some(json!({"company_wallet":admin.pubkey().to_string(),"amount":"10000","mode":"public"}))).await;
        assert_eq!(p["transaction_version"], 0);
        let (signature, slot) = self.execute("public-wrap", &self.signed(&admin, &p)).await;
        let receipt = self
            .ok(
                &self.fixture.admin,
                "/wrap/confirm",
                Some(json!({"request_id":p["request_id"],"signature":signature})),
            )
            .await;
        assert_eq!(receipt["slot"], slot);
        self.record("public-wrap-confirmed", receipt);
    }
}
