use super::{request, signed, support};
use axum::http::StatusCode;
use cadence_proof::indexer::store::Store;
use serde_json::json;
use solana_account::Account as RpcAccount;
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        StateWithExtensionsMut,
    },
    state::Account,
};

pub async fn mismatch_is_durable(h: &support::Harness, wallet: &Keypair, chain: &mut RpcAccount) {
    let app = h.app();
    let account = cadence_proof::solana::wrap::destination(&wallet.pubkey()).to_string();
    for (counter, indexed) in [(2_u64, false), (3, true)] {
        {
            let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
            state
                .get_extension_mut::<ConfidentialTransferAccount>()
                .unwrap()
                .pending_balance_credit_counter = counter.into();
        }
        h.backend
            .accounts
            .lock()
            .unwrap()
            .insert(account.clone(), support::encoded(chain));
        let (status, prepared) = request(
            &app,
            "/accounts/apply-pending",
            "other-user",
            Some(json!({"wallet":wallet.pubkey().to_string()})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{prepared}");
        let (signature, result) = signed(wallet, &prepared);
        h.backend
            .transactions
            .lock()
            .unwrap()
            .insert(signature.clone(), result);
        if indexed {
            let mut url: reqwest::Url = std::env::var("TRANSFER_TEST_DATABASE_URL")
                .unwrap()
                .parse()
                .unwrap();
            url.set_username("cadence_indexer").unwrap();
            url.set_password(Some("cr163-indexer-test-only")).unwrap();
            url.set_query(Some("sslmode=disable"));
            let store = Store::new(url.as_str()).unwrap();
            let record = store
                .pending()
                .await
                .unwrap()
                .into_iter()
                .find(|r| r.id == prepared["request_id"].as_str().unwrap())
                .unwrap();
            store.finish(&record, &signature, 42, false).await.unwrap();
        }
        {
            let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
            let config = state
                .get_extension_mut::<ConfidentialTransferAccount>()
                .unwrap();
            config.pending_balance_credit_counter = 0.into();
            config.expected_pending_balance_credit_counter = counter.into();
            config.actual_pending_balance_credit_counter = (counter + 1).into();
        }
        h.backend
            .accounts
            .lock()
            .unwrap()
            .insert(account.clone(), support::encoded(chain));
        let confirm = json!({"request_id":prepared["request_id"],"signature":signature});
        let (a, b) = tokio::join!(
            request(
                &app,
                "/accounts/apply-pending/confirm",
                "other-user",
                Some(confirm.clone())
            ),
            request(
                &app,
                "/accounts/apply-pending/confirm",
                "other-user",
                Some(confirm.clone())
            )
        );
        for (status, body) in [a, b] {
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body, json!({"error":"credit_counter_mismatch"}));
        }
        let id = prepared["request_id"].as_str().unwrap();
        let row = h
            .admin
            .query_one(
                "SELECT status,counter_match FROM public.account_requests WHERE id=$1",
                &[&id],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "finalized");
        assert_eq!(row.get::<_, Option<bool>>(1), Some(false));
        assert!(h
            .admin
            .execute(
                "UPDATE public.account_requests SET counter_match=true WHERE id=$1",
                &[&id]
            )
            .await
            .is_err());
        assert!(h
            .admin
            .execute(
                "UPDATE public.account_requests SET counter_match=NULL WHERE id=$1",
                &[&id]
            )
            .await
            .is_err());
        assert_eq!(
            request(&app, "/me/balance", "other-user", None).await.1["error"],
            "credit_counter_mismatch"
        );
        {
            let mut state = StateWithExtensionsMut::<Account>::unpack(&mut chain.data).unwrap();
            state
                .get_extension_mut::<ConfidentialTransferAccount>()
                .unwrap()
                .actual_pending_balance_credit_counter = counter.into();
        }
        h.backend
            .accounts
            .lock()
            .unwrap()
            .insert(account.clone(), support::encoded(chain));
        let (status, body) = request(
            &app,
            "/accounts/apply-pending/confirm",
            "other-user",
            Some(confirm),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body, json!({"error":"credit_counter_mismatch"}));
    }
}
