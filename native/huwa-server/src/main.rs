//! `huwa-server`: configuration from `HUWA_*` (docs/SELF_HOSTING.md), then serve until
//! SIGINT / SIGTERM (tini forwards them in the image). SIGHUP is forwarded to the Node children.
//!
//! - `huwa-server --version`
//! - `huwa-server --healthcheck`: exit 0 when `GET /health` on `127.0.0.1:$HUWA_PORT` answers
//!   200 (the image's HEALTHCHECK; with built-in TLS, a TCP connect only).

use std::net::SocketAddr;

use anyhow::Result;
use huwa_server::{App, ServerConfig};
use tracing::info;

fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    let port: u16 = std::env::var("HUWA_PORT").ok().and_then(|p| p.trim().parse().ok()).unwrap_or(8080);
    let tls = std::env::var("HUWA_TLS_CERT").is_ok_and(|v| !v.trim().is_empty());
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut c) = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(3)) else { return 1 };
    if tls {
        return 0;
    }
    let _ = c.set_read_timeout(Some(std::time::Duration::from_secs(4)));
    if c.write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n").is_err() {
        return 1;
    }
    let mut buf = [0u8; 64];
    match c.read(&mut buf) {
        Ok(n) if buf[..n].starts_with(b"HTTP/1.0 200") || buf[..n].starts_with(b"HTTP/1.1 200") => 0,
        _ => 1,
    }
}

fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("--version" | "-V") => {
            println!("huwa-server {} ({})", huwa_server::VERSION, if cfg!(feature = "engine") { "engine" } else { "web" });
            return Ok(());
        }
        Some("--healthcheck") => std::process::exit(healthcheck()),
        _ => {}
    }
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
