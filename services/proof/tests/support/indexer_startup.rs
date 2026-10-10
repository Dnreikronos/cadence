use super::support::{payment, Harness};
use cadence_proof::indexer::store::Kind;
use std::{
    process::{Command, Stdio},
    sync::atomic::Ordering,
    time::Duration,
};

pub async fn verify(h: &Harness) {
    let (p, signature, result) = payment(&h.wallet, Kind::Run, 50, true, false);
    h.insert(&p, 50).await;
    h.backend
        .transactions
        .lock()
        .unwrap()
        .insert(signature, result);
    h.backend.delay.store(true, Ordering::SeqCst);
    h.backend.calls.lock().unwrap().clear();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut child = Command::new(env!("CARGO_BIN_EXE_cadence-proof"))
        .env_clear()
        .env("BUILD_SHA", "a".repeat(40))
        .env("PROOF_RPC_URL", &h.origin)
        .env("PROOF_RPC_WS_URL", "ws://127.0.0.1:1")
        .env("PROOF_INDEXER_DATABASE_URL", &h.receipts_url)
        .env("PROOF_BIND_ADDR", address.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let outcome = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if !h.backend.calls.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        // The first RPC is deliberately delayed, so startup has not reconciled yet.
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if tokio::net::TcpStream::connect(address).await.is_ok() {
                    break;
                }
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "service exited before readiness"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        h.assert_status(&p, "finalized").await;
    };
    // Always terminate the local service, including an assertion failure.
    let result = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(outcome)).await;
    child.kill().unwrap();
    child.wait().unwrap();
    h.backend.delay.store(false, Ordering::SeqCst);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
