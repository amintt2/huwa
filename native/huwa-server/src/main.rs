//! `huwa-server`: configuration from `HUWA_*` (docs/SELF_HOSTING.md), then serve until
//! SIGINT / SIGTERM (tini forwards them in the image). SIGHUP is forwarded to the Node children.

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
    if cfg.public_url.as_deref().is_some_and(|u| u.starts_with("http://")) && cfg.tls_cert.is_none() {
        tracing::warn!("HUWA_PUBLIC_URL is plain http: browsers give no secure context (no PWA install, no service worker, no passkeys)");
    }
    let addr = SocketAddr::new(cfg.bind, cfg.port);
    let app = App::new(cfg)?;
    let bound = app.spawn(addr)?;
    info!(%bound, "listening");

    let st = app.state.clone();
    app.handle().block_on(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate())?;
            let mut hup = signal(SignalKind::hangup())?;
            loop {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => break,
                    _ = term.recv() => break,
                    _ = hup.recv() => st.supervisor.forward(libc::SIGHUP),
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = &st;
            tokio::signal::ctrl_c().await?;
        }
        anyhow::Ok(())
    })?;
    info!("shutting down");
    app.shutdown();
    Ok(())
}
