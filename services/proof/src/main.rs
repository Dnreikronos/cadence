use cadence_proof::{
    config::Config, error::AppError, indexer::Indexer, router_with_payments,
    routes::transfer::Service, solana::client::RpcClient, wrap_store::WrapStore, AppState,
};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), AppError> {
    let config = Config::from_env()?;
    let rpc = Arc::new(RpcClient::new(config.rpc_url.clone(), config.rpc_timeout)?);
    let wrap_store = WrapStore::from_env()?.map(Arc::new);
    let transfer = Service::from_env()?.map(Arc::new);
    let cors = cadence_proof::cors::from_env()?;
    let indexer = Indexer::from_env(
        rpc.clone(),
        &config.rpc_url,
        wrap_store.is_some() || transfer.is_some(),
    )?
    .map(Arc::new);
    if let Some(indexer) = &indexer {
        eprintln!("reconciling payment status before accepting requests");
        indexer.backfill().await?;
    }

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
    let cleanup = wrap_store
        .as_ref()
        .map(|store| store.clone().spawn_cleanup(rpc.clone()));
    let indexer = indexer.map(|indexer| indexer.spawn());
    let result = axum::serve(
        listener,
        router_with_payments(
            AppState {
                rpc,
                build_sha: config.build_sha,
            },
            wrap_store,
            transfer,
        )
        .layer(cors)
        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await;
    if let Some(cleanup) = cleanup {
        cleanup.abort();
    }
    if let Some(indexer) = indexer {
        indexer.abort();
    }
    result?;
    Ok(())
}
