//! Node children (D9, D18) and the `/p2p` front door.
//!
//! - **Supervisor.** `huwa-server` starts the P2P gateway (`services/huwa-gateway/relay.js`,
//!   owned by the browser-P2P work: non-custodial dht-relay over WebSocket) when
//!   `HUWA_P2P_GATEWAY=1`, and the blind-peer relay (`services/blind-peer/server.js` with its
//!   `policy.js`) when `HUWA_RELAY=1`. A child that exits is restarted with an exponential backoff
//!   (1 s → 60 s, reset after a minute up). On shutdown each child gets `SIGTERM`, then `SIGKILL`
//!   after 10 s. Their stdout / stderr go to the server's (the container log).
//! - **`/p2p` proxy.** One public port: `/p2p` and `/p2p/…` (HTTP and WebSocket upgrades) are
//!   relayed to the gateway on `127.0.0.1:HUWA_GATEWAY_PORT`, at most `HUWA_MAX_WS` WebSockets at
//!   a time. The gateway sees the browser's `Origin` and an `X-Forwarded-For` with its address.

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{header, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use tracing::{info, warn};

use crate::{error::ApiError, metrics::inc, AppState};

pub struct ChildSpec {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

struct ChildState {
    spec: ChildSpec,
    up: AtomicBool,
    restarts: AtomicU64,
    pid: AtomicU32,
}

pub struct Supervisor {
    children: Mutex<Vec<Arc<ChildState>>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    stop: tokio::sync::watch::Sender<bool>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self { children: Default::default(), tasks: Default::default(), stop: tokio::sync::watch::channel(false).0 }
    }
}

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
const HEALTHY_AFTER: Duration = Duration::from_secs(60);
const STOP_GRACE: Duration = Duration::from_secs(10);

#[cfg(unix)]
fn signal(pid: u32, sig: i32) {
    if pid > 0 {
        // SAFETY: plain kill(2) on a child we spawned.
        unsafe {
            libc::kill(pid as i32, sig);
        }
    }
}

impl Supervisor {
    /// Starts `spec` and keeps it running until `stop`. Must be called inside the runtime.
    pub fn spawn(&self, spec: ChildSpec) {
        let state = Arc::new(ChildState { spec, up: AtomicBool::new(false), restarts: AtomicU64::new(0), pid: AtomicU32::new(0) });
        self.children.lock().push(state.clone());
        let mut stop = self.stop.subscribe();
        let task = tokio::spawn(async move {
            let mut backoff = BACKOFF_MIN;
            loop {
                if *stop.borrow() {
                    return;
                }
                let s = &state.spec;
                let mut cmd = tokio::process::Command::new(&s.program);
                cmd.args(&s.args).envs(s.env.iter().map(|(k, v)| (k.as_str(), v.as_str()))).stdin(std::process::Stdio::null()).kill_on_drop(true);
                if let Some(d) = &s.cwd {
                    cmd.current_dir(d);
                }
                let started = Instant::now();
                match cmd.spawn() {
                    Ok(mut child) => {
                        let pid = child.id().unwrap_or(0);
                        state.pid.store(pid, Ordering::Relaxed);
                        state.up.store(true, Ordering::Relaxed);
                        info!(child = %s.name, pid, "child started");
                        tokio::select! {
                            status = child.wait() => {
                                state.up.store(false, Ordering::Relaxed);
                                warn!(child = %s.name, ?status, "child exited");
                            }
                            _ = stop.changed() => {
                                #[cfg(unix)]
                                signal(pid, libc::SIGTERM);
                                #[cfg(not(unix))]
                                let _ = child.start_kill();
                                if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_err() {
                                    warn!(child = %s.name, "no exit after SIGTERM, killing");
                                    let _ = child.kill().await;
                                }
                                state.up.store(false, Ordering::Relaxed);
                                info!(child = %s.name, "child stopped");
                                return;
                            }
                        }
                    }
                    Err(e) => warn!(child = %s.name, program = %s.program.display(), "cannot start child: {e}"),
                }
                backoff = if started.elapsed() >= HEALTHY_AFTER { BACKOFF_MIN } else { (backoff * 2).min(BACKOFF_MAX) };
                state.restarts.fetch_add(1, Ordering::Relaxed);
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = stop.changed() => return,
                }
            }
        });
        self.tasks.lock().push(task);
    }

    /// `(name, up, restarts)` per child, for `/metrics`.
    pub fn status(&self) -> Vec<(String, bool, u64)> {
        self.children.lock().iter().map(|c| (c.spec.name.clone(), c.up.load(Ordering::Relaxed), c.restarts.load(Ordering::Relaxed))).collect()
    }

    /// SIGTERM to every child, SIGKILL after the grace period; waits for them.
    pub async fn stop(&self) {
        let _ = self.stop.send(true);
        let tasks: Vec<_> = std::mem::take(&mut *self.tasks.lock());
        for t in tasks {
            let _ = tokio::time::timeout(STOP_GRACE + Duration::from_secs(2), t).await;
        }
    }

    /// Forwards a signal (e.g. SIGHUP) to the running children.
    #[cfg(unix)]
    pub fn forward(&self, sig: i32) {
        for c in self.children.lock().iter() {
            if c.up.load(Ordering::Relaxed) {
                signal(c.pid.load(Ordering::Relaxed), sig);
            }
        }
    }
}

/// The children this configuration asks for (scripts that are missing are skipped with a warning).
pub fn child_specs(cfg: &crate::ServerConfig) -> Vec<ChildSpec> {
    let mut out = Vec::new();
    let node = cfg.node.clone();
    if cfg.p2p_gateway {
        if cfg.gateway_script.exists() {
            let mut args = vec![cfg.gateway_script.display().to_string(), "--port".into(), cfg.gateway_port.to_string(), "--host".into(), "127.0.0.1".into()];
            if let Some(b) = &cfg.bootstrap {
                args.push("--bootstrap".into());
                args.push(b.clone());
            }
            out.push(ChildSpec {
                name: "gateway".into(),
                program: node.clone(),
                args,
                env: vec![("NODE_ENV".into(), "production".into())],
                cwd: cfg.gateway_script.parent().map(PathBuf::from),
            });
        } else {
            warn!(script = %cfg.gateway_script.display(), "HUWA_P2P_GATEWAY=1 but the gateway is not installed: /p2p answers 503");
        }
    }
    if cfg.relay {
        if cfg.relay_script.exists() {
            let storage = cfg.data_dir.clone().unwrap_or_else(|| cfg.cache_dir.clone()).join("relay");
            let mut env = vec![
                ("NODE_ENV".to_string(), "production".to_string()),
                ("STORAGE".to_string(), storage.display().to_string()),
                ("PORT".to_string(), cfg.dht_port.to_string()),
                ("MAX_STORAGE_MB".to_string(), cfg.relay_max_storage_mb.to_string()),
                // No health listener of its own: huwa-server is the only public port.
                ("HEALTH_PORT".to_string(), String::new()),
            ];
            if let Some(b) = &cfg.bootstrap {
                env.push(("BOOTSTRAP".into(), b.clone()));
            }
            out.push(ChildSpec {
                name: "relay".into(),
                program: node,
                args: vec![cfg.relay_script.display().to_string()],
                env,
                cwd: cfg.relay_script.parent().map(PathBuf::from),
            });
        } else {
            warn!(script = %cfg.relay_script.display(), "HUWA_RELAY=1 but the blind-peer relay is not installed");
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------
// /p2p reverse proxy (HTTP + WebSocket)
// ------------------------------------------------------------------------------------------------

struct WsSlot(Arc<AppState>);

impl Drop for WsSlot {
    fn drop(&mut self) {
        self.0.ws_open.fetch_sub(1, Ordering::Relaxed);
    }
}

const HOP_BY_HOP: &[&str] = &["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

pub async fn proxy_p2p(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request<Body>) -> Response {
    if !st.gateway_running() {
        return ApiError::unavailable("p2p_unavailable", "the P2P gateway is not running on this server").into_response();
    }
    let upgrade = req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).map(|v| v.to_ascii_lowercase());
    let slot = if upgrade.is_some() {
        let open = st.ws_open.fetch_add(1, Ordering::Relaxed);
        let slot = WsSlot(st.clone());
        if st.cfg.max_ws > 0 && open >= st.cfg.max_ws {
            inc(&st.metrics.ws_refused);
            return ApiError::unavailable("too_many_connections", "too many P2P connections on this server").into_response();
        }
        inc(&st.metrics.ws_connections);
        Some(slot)
    } else {
        None
    };
    let client_upgrade = upgrade.as_ref().map(|_| hyper::upgrade::on(&mut req));

    let client_ip = crate::net::client_ip(st.cfg.trust_proxy, req.headers(), Some(peer));
    let (mut parts, body) = req.into_parts();
    let path = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/p2p".into());
    parts.uri = match path.parse() {
        Ok(u) => u,
        Err(_) => return ApiError::bad_request("bad path").into_response(),
    };
    let headers = &mut parts.headers;
    for h in HOP_BY_HOP {
        if upgrade.is_some() && (*h == "connection" || *h == "upgrade") {
            continue;
        }
        headers.remove(*h);
    }
    if let Some(ip) = client_ip {
        if let Ok(v) = HeaderValue::from_str(&ip.to_string()) {
            headers.insert("x-forwarded-for", v);
        }
    }
    headers.insert("x-forwarded-proto", HeaderValue::from_static(if st.tls { "https" } else { "http" }));
    let upstream_req = Request::from_parts(parts, body);

    let stream = match tokio::net::TcpStream::connect(("127.0.0.1", st.cfg.gateway_port)).await {
        Ok(s) => s,
        Err(e) => {
            warn!("p2p gateway unreachable: {e}");
            return ApiError::unavailable("p2p_unavailable", "the P2P gateway is not reachable").into_response();
        }
    };
    let _ = stream.set_nodelay(true);
    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
        Ok(x) => x,
        Err(e) => return ApiError::new(StatusCode::BAD_GATEWAY, "bad_gateway", format!("p2p gateway: {e}")).into_response(),
    };
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let mut resp = match sender.send_request(upstream_req).await {
        Ok(r) => r,
        Err(e) => return ApiError::new(StatusCode::BAD_GATEWAY, "bad_gateway", format!("p2p gateway: {e}")).into_response(),
    };
    if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        let (Some(client_upgrade), Some(slot)) = (client_upgrade, slot) else {
            return ApiError::new(StatusCode::BAD_GATEWAY, "bad_gateway", "unexpected upgrade").into_response();
        };
        let upstream_upgrade = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            let _slot = slot;
            match tokio::try_join!(client_upgrade, upstream_upgrade) {
                Ok((client, upstream)) => {
                    let (mut a, mut b) = (TokioIo::new(client), TokioIo::new(upstream));
                    let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
                }
                Err(e) => warn!("p2p upgrade failed: {e}"),
            }
        });
        let (parts, _) = resp.into_parts();
        return Response::from_parts(parts, Body::empty());
    }
    let (parts, body) = resp.into_parts();
    let mut out = Response::from_parts(parts, Body::new(body));
    for h in HOP_BY_HOP {
        out.headers_mut().remove(*h);
    }
    out
}

/// Number of open `/p2p` WebSockets.
pub fn ws_open(st: &AppState) -> usize {
    st.ws_open.load(Ordering::Relaxed)
}

pub type WsCounter = AtomicUsize;
