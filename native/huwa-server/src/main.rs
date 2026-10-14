//! `huwa-server`: configuration from `HUWA_*` (docs/server-api.md), then serve until SIGINT/SIGTERM.

use std::net::SocketAddr;

use anyhow::Result;
use huwa_server::{App, ServerConfig};
use tracing::info;

fn main() -> Result<()> {
    let filter = std::env::var("HUWA_LOG").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_new(&filter).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();

    let cfg = ServerConfig::from_env()?;
    info!(?cfg, "huwa-server {} starting", huwa_server::VERSION);
    let addr = SocketAddr::new(cfg.bind, cfg.port);
    let app = App::new(cfg)?;
    let bound = app.spawn(addr)?;
    info!(%bound, "listening");

    app.engine().runtime.block_on(async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            tokio::select! {
                _ = ctrl_c => {}
                _ = term.recv() => {}
            }
        }
        #[cfg(not(unix))]
        ctrl_c.await?;
        anyhow::Ok(())
    })?;
    info!("shutting down");
    app.shutdown();
    Ok(())
}
