use cadence_proof::{
    config::Config, error::AppError, router_with_wrap, solana::client::RpcClient,
    wrap_store::WrapStore, AppState,
};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), AppError> {
    let config = Config::from_env()?;
    let rpc = Arc::new(RpcClient::new(config.rpc_url, config.rpc_timeout)?);
    let wrap_store = WrapStore::from_env()?.map(Arc::new);

    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let shutdown = async move {
        #[cfg(unix)]
        let terminate = async {
            terminate.recv().await;
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<()>();
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result { eprintln!("cannot listen for SIGINT: {error}"); }
            }
            _ = terminate => {}
        }
        eprintln!("draining active requests");
    };

    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    eprintln!(
        "cadence-proof {} listening on {}",
        config.build_sha,
        listener.local_addr()?
    );
    axum::serve(
        listener,
        router_with_wrap(
            AppState {
                rpc,
                build_sha: config.build_sha,
            },
            wrap_store,
        ),
    )
    .with_graceful_shutdown(shutdown)
    .await?;
    Ok(())
}
