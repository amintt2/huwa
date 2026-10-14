//! Optional built-in HTTPS (`HUWA_TLS_CERT` / `HUWA_TLS_KEY`, PEM). Most deployments terminate
//! TLS in a reverse proxy (Coolify / Traefik, Caddy) instead; this is for a bare `docker run` with
//! a certificate at hand. HTTP/1.1 only (WebSocket upgrades for `/p2p` included).

use std::{net::SocketAddr, path::Path, sync::Arc};

use anyhow::{anyhow, Context, Result};
use axum::{extract::ConnectInfo, Router};
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, warn};

pub fn acceptor(cert: &Path, key: &Path) -> Result<TlsAcceptor> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .with_context(|| format!("reading {}", cert.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| anyhow!("{}: {e}", cert.display()))?;
    if certs.is_empty() {
        return Err(anyhow!("{}: no certificate", cert.display()));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| anyhow!("{}: {e}", key.display()))?;
    let mut cfg = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key).context("TLS certificate / key")?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

/// Accept loop: TLS handshake, then hyper HTTP/1.1 with upgrades, the peer address as
/// `ConnectInfo` (per-IP limits).
pub async fn serve(listener: tokio::net::TcpListener, acceptor: TlsAcceptor, app: Router, mut stop: tokio::sync::oneshot::Receiver<()>) {
    loop {
        let (tcp, peer) = tokio::select! {
            r = listener.accept() => match r {
                Ok(x) => x,
                Err(e) => {
                    warn!("accept failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            },
            _ = &mut stop => return,
        };
        let (acceptor, app) = (acceptor.clone(), app.clone());
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            let tls = match tokio::time::timeout(std::time::Duration::from_secs(15), acceptor.accept(tcp)).await {
                Ok(Ok(t)) => t,
                Ok(Err(e)) => {
                    debug!(%peer, "TLS handshake failed: {e}");
                    return;
                }
                Err(_) => return,
            };
            let svc = TowerToHyperService::new(app.layer(axum::Extension(ConnectInfo::<SocketAddr>(peer))));
            let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), svc).with_upgrades();
            if let Err(e) = conn.await {
                debug!(%peer, "connection: {e}");
            }
        });
    }
}
