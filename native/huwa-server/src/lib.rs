//! Huwa Server (docs/WEB_DOCKER_PLAN.md D9–D15, API: docs/server-api.md, operators:
//! docs/SELF_HOSTING.md): one public port in front of
//! - the web app (`HUWA_WEB_DIR`, SPA) and its runtime config `/huwa-config.json`;
//! - per-browser sessions (`POST /api/v1/session`, D11);
//! - the torrent engine and the read-ahead HTTP proxy (`/api/v1/engine/*`, `/s/<token>/t|http/…`);
//! - the media module (ffprobe, remux / transcode to fMP4 HLS, subtitle sidecars, fonts);
//! - the opt-in Stremio streaming-server surface (`HUWA_STREMIO_COMPAT=1`);
//! - the P2P gateway and blind-peer relay (supervised Node children, `/p2p`);
//! - `/health`, `/metrics`.
//!
//! The `engine` cargo feature (default) carries the engine, media and compat parts. Without it
//! (the `-web` image of huwa.mciut.fr) there is no torrent engine, no proxy and no ffmpeg:
//! `/api/v1/engine/*` is a 404. No seeding: `disable-upload` is a compile-time feature of the
//! engine and `seeding` is never enabled here.

pub mod config;
pub mod error;
pub mod gateway;
pub mod metrics;
pub mod net;
pub mod sessions;
pub mod tls;
pub mod web;

#[cfg(feature = "engine")]
pub mod compat;
#[cfg(feature = "engine")]
pub mod engine_api;
#[cfg(feature = "engine")]
pub mod media;

use std::{
    mem::ManuallyDrop,
    net::SocketAddr,
    sync::{atomic::AtomicUsize, Arc},
    time::Duration,
};

use anyhow::{Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};

pub use config::ServerConfig;
use error::{ApiError, ApiResult};
use metrics::{inc, Metrics};
use sessions::{Session, SessionRequest, Sessions};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Version of the `/api/v1` contract (docs/server-api.md).
pub const API_VERSION: u32 = 1;

pub struct AppState {
    pub cfg: ServerConfig,
    pub sessions: Sessions,
    pub metrics: Metrics,
    pub supervisor: gateway::Supervisor,
    /// Open `/p2p` WebSockets.
    pub ws_open: AtomicUsize,
    /// Served over built-in TLS.
    pub tls: bool,
    #[cfg(feature = "engine")]
    pub eng: Option<Arc<engine_api::EngineParts>>,
    #[cfg(feature = "engine")]
    pub media: Option<Arc<media::Media>>,
    #[cfg(feature = "engine")]
    pub compat: compat::Compat,
}

impl AppState {
    pub fn gateway_running(&self) -> bool {
        self.cfg.p2p_gateway
    }
}

enum Rt {
    #[cfg(feature = "engine")]
    Engine(Arc<engine_api::EngineParts>),
    Own(ManuallyDrop<tokio::runtime::Runtime>),
}

/// The server, built synchronously (the engine owns its runtime and must be created outside it).
pub struct App {
    pub state: Arc<AppState>,
    rt: Rt,
    server: Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<()>)>>,
}

impl Drop for App {
    #[allow(irrefutable_let_patterns)]
    fn drop(&mut self) {
        if let Rt::Own(rt) = &mut self.rt {
            // SAFETY: taken once, here.
            let rt = unsafe { ManuallyDrop::take(rt) };
            rt.shutdown_background();
        }
    }
}

impl App {
    pub fn new(cfg: ServerConfig) -> Result<App> {
        #[cfg(feature = "engine")]
        let eng = if cfg.engine_enabled() { Some(Arc::new(engine_api::EngineParts::new(&cfg)?)) } else { None };
        #[cfg(feature = "engine")]
        let rt = match &eng {
            Some(e) => Rt::Engine(e.clone()),
            None => Rt::Own(ManuallyDrop::new(own_runtime(&cfg)?)),
        };
        #[cfg(not(feature = "engine"))]
        let rt = Rt::Own(ManuallyDrop::new(own_runtime(&cfg)?));

        let key = cfg.data_dir.as_deref().and_then(sessions::load_or_create_key);
        if key.is_none() {
            warn!("no usable data dir for token.key: session tokens will not survive a restart");
        }
        let sessions = match key {
            Some(k) => Sessions::new(k, cfg.session_ttl),
            None => Sessions::with_random_key(cfg.session_ttl),
        }
        .with_limits(cfg.max_sessions, cfg.sessions_per_ip, cfg.stream_token_ttl);

        #[cfg(feature = "engine")]
        let media = if cfg.media_enabled() { Some(Arc::new(media::Media::new(&cfg)?)) } else { None };
        #[cfg(feature = "engine")]
        if let Some(e) = &eng {
            e.start_internal()?;
        }
        let state = Arc::new(AppState {
            tls: cfg.tls_cert.is_some(),
            cfg,
            sessions,
            metrics: Metrics::default(),
            supervisor: Default::default(),
            ws_open: AtomicUsize::new(0),
            #[cfg(feature = "engine")]
            eng,
            #[cfg(feature = "engine")]
            media,
            #[cfg(feature = "engine")]
            compat: Default::default(),
        });
        Ok(App { state, rt, server: Mutex::new(None) })
    }

    pub fn handle(&self) -> tokio::runtime::Handle {
        match &self.rt {
            #[cfg(feature = "engine")]
            Rt::Engine(e) => e.engine.runtime.handle().clone(),
            Rt::Own(rt) => rt.handle().clone(),
        }
    }

    /// The torrent engine (engine builds with `HUWA_TORRENT=1`).
    #[cfg(feature = "engine")]
    pub fn engine(&self) -> &Arc<huwa_torrent_core::engine::Engine> {
        &self.state.eng.as_ref().expect("torrent engine disabled").engine
    }

    pub fn router(&self) -> Router {
        router(self.state.clone())
    }

    /// Binds `addr` and serves in the background (plain HTTP, or TLS with `HUWA_TLS_CERT/KEY`);
    /// starts the janitor, the supervised children and the encoder probe. Returns the bound address.
    pub fn spawn(&self, addr: SocketAddr) -> Result<SocketAddr> {
        let h = self.handle();
        let listener = h.block_on(tokio::net::TcpListener::bind(addr)).with_context(|| format!("binding {addr}"))?;
        let local = listener.local_addr()?;
        #[cfg(feature = "engine")]
        if let Some(e) = &self.state.eng {
            e.engine.set_port(local.port());
        }
        let app = self.router();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let task = match (&self.state.cfg.tls_cert, &self.state.cfg.tls_key) {
            (Some(cert), Some(key)) => {
                let acceptor = tls::acceptor(cert, key)?;
                info!("built-in TLS enabled");
                h.spawn(tls::serve(listener, acceptor, app, stopped))
            }
            _ => h.spawn(async move {
                let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async move {
                    let _ = stopped.await;
                });
                if let Err(e) = serve.await {
                    warn!("server stopped: {e:#}");
                }
            }),
        };
        *self.server.lock() = Some((stop, task));
        self.spawn_janitor();
        let st = self.state.clone();
        h.spawn(async move {
            for spec in gateway::child_specs(&st.cfg) {
                st.supervisor.spawn(spec);
            }
        });
        #[cfg(feature = "engine")]
        if let Some(m) = self.state.media.clone() {
            let pref = self.state.cfg.hwaccel;
            h.spawn(async move {
                let enc = media::hwaccel::probe(&m.ffmpeg, pref).await;
                *m.encoder.write() = enc;
            });
        }
        Ok(local)
    }

    /// Expired sessions are forgotten (their torrents released, their focus dropped); idle HLS
    /// jobs, subtitle runs and media sessions are stopped.
    fn spawn_janitor(&self) {
        let weak = Arc::downgrade(&self.state);
        self.handle().spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(10));
            let mut n = 0u64;
            loop {
                tick.tick().await;
                n += 1;
                let Some(st) = weak.upgrade() else { return };
                if n % 6 == 0 {
                    let (dropped, freed) = st.sessions.sweep();
                    #[cfg(feature = "engine")]
                    if let Some(e) = &st.eng {
                        for sid in &dropped {
                            e.engine.drop_focus_owner(sid);
                        }
                        for hex in &freed {
                            let _ = e.engine.release(hex, None);
                        }
                    }
                    let _ = (&dropped, &freed);
                }
                #[cfg(feature = "engine")]
                if let Some(m) = &st.media {
                    let alive = |sid: &str| sid == compat::COMPAT_SESSION || st.sessions.get(sid).is_some();
                    m.sweep(&alive);
                    st.compat.sweep(m);
                }
            }
        });
    }

    /// Stops the children, the media jobs, the HTTP server and the engine (blocking; call it
    /// outside the runtime).
    pub fn shutdown(&self) {
        let h = self.handle();
        let st = self.state.clone();
        h.block_on(async move { st.supervisor.stop().await });
        #[cfg(feature = "engine")]
        if let Some(m) = &self.state.media {
            m.shutdown();
        }
        if let Some((stop, task)) = self.server.lock().take() {
            let _ = stop.send(());
            let _ = h.block_on(async { tokio::time::timeout(Duration::from_secs(5), task).await });
        }
        #[cfg(feature = "engine")]
        if let Some(e) = &self.state.eng {
            e.shutdown();
        }
    }
}

fn own_runtime(cfg: &ServerConfig) -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread().worker_threads(cfg.worker_threads.clamp(1, 4)).thread_name("huwa-server").enable_all().build().context("tokio runtime")
}

pub fn cors_layer(cfg: &ServerConfig) -> CorsLayer {
    let origin = if cfg.allowed_origins.iter().any(|o| o == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(cfg.allowed_origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()))
    };
    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::HEAD, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE])
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
            header::CONTENT_TYPE,
            header::RETRY_AFTER,
            header::HeaderName::from_static("x-huwa-subs-until"),
            header::HeaderName::from_static("x-huwa-subs-complete"),
        ])
        .max_age(Duration::from_secs(600))
        // Chrome Private Network Access: a public page (huwa.mciut.fr) calling a LAN server.
        .allow_private_network(true)
}

pub fn router(state: Arc<AppState>) -> Router {
    let cors = cors_layer(&state.cfg);
    #[allow(unused_mut)]
    let mut r: Router<Arc<AppState>> = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/metrics", get(metrics_route))
        .route("/huwa-config.json", get(web::huwa_config))
        .route("/robots.txt", get(web::robots))
        .route("/api/v1/info", get(info_route))
        .route("/api/v1/session", post(create_session))
        .route("/api/{*rest}", any(|| async { ApiError::not_found("no such route") }))
        .route("/p2p", any(gateway::proxy_p2p))
        .route("/p2p/{*rest}", any(gateway::proxy_p2p));
    #[cfg(feature = "engine")]
    {
        r = r
            .route("/api/v1/engine/{method}", post(engine_api::engine_call))
            .route("/api/v1/media/probe", post(media::probe_route))
            .route("/s/{token}/t/{info_hash}/{file}", get(engine_api::torrent_stream))
            .route("/s/{token}/http/{file}", get(engine_api::http_stream))
            .route("/s/{token}/hls/{mid}/{file}", get(media::hls_master_route))
            .route("/s/{token}/hls/{mid}/{variant}/{file}", get(media::hls_file_route))
            .route("/s/{token}/subs/{mid}/{file}", get(media::subs_route))
            .route("/s/{token}/fonts/{mid}", get(media::fonts_list_route))
            .route("/s/{token}/fonts/{mid}/{n}", get(media::font_route));
        if state.cfg.stremio_compat && state.cfg.engine_enabled() {
            r = r
                .route("/settings", get(compat::settings_get).post(compat::settings_post))
                .route("/stats.json", get(compat::stats_all))
                .route("/network-info", get(compat::network_info))
                .route("/device-info", get(compat::device_info))
                .route("/casting", get(compat::casting))
                .route("/create", post(compat::create_root))
                .route("/{a}/create", post(compat::create_hash))
                .route("/{a}/{b}", get(compat::two_segments))
                .route("/{a}/{b}/stats.json", get(compat::file_stats))
                .route("/hlsv2/probe", get(compat::hls_probe))
                .route("/hlsv2/{cid}/{file}", get(compat::hls_master))
                .route("/hlsv2/{cid}/{variant}/{file}", get(compat::hls_file))
                .route("/subtitles.vtt", get(compat::subtitles_vtt));
        }
    }
    r.fallback(fallback)
        .layer(middleware::from_fn_with_state(state.clone(), web::headers_layer))
        .layer(cors)
        .with_state(state)
}

/// Unknown API / media paths are JSON 404s; everything else is the web app.
async fn fallback(State(st): State<Arc<AppState>>, req: Request<Body>) -> Response {
    let p = req.uri().path();
    if p.starts_with("/api/") || p.starts_with("/s/") || p.starts_with("/i/") || p.starts_with("/hlsv2/") {
        return ApiError::not_found("no such route").into_response();
    }
    web::serve_static(st, req).await
}

// ------------------------------------------------------------------------------------------------
// Info, sessions, metrics
// ------------------------------------------------------------------------------------------------

async fn info_route(State(st): State<Arc<AppState>>) -> Response {
    let cfg = &st.cfg;
    #[cfg(feature = "engine")]
    let engine_version = cfg.engine_enabled().then_some(huwa_torrent_core::VERSION);
    #[cfg(not(feature = "engine"))]
    let engine_version: Option<&str> = None;
    #[cfg(feature = "engine")]
    let encoder = st.media.as_ref().map(|m| m.encoder.read().name());
    #[cfg(not(feature = "engine"))]
    let encoder: Option<&str> = None;
    no_store(Json(json!({
        "name": "huwa-server",
        "version": VERSION,
        "api": API_VERSION,
        "engine": engine_version,
        "publicUrl": cfg.public_url,
        "instance": { "name": cfg.instance_name, "operatorContact": cfg.operator_contact },
        "features": web::features(cfg),
        "limits": {
            "streamsPerSession": cfg.streams_per_session,
            "transcodesPerSession": cfg.transcodes_per_session,
            "transcodesMax": cfg.transcodes_max,
            "proxySessionsPerSession": cfg.proxy_sessions_per_session,
            "sessionsPerIp": cfg.sessions_per_ip,
            "cacheMaxBytes": cfg.cache_max_bytes,
            "sessionTtlSecs": cfg.session_ttl.as_secs(),
            "streamTokenTtlSecs": cfg.stream_token_ttl.as_secs(),
        },
        "transcode": { "encoder": encoder, "segmentSeconds": 4, "hls": "fmp4" },
        "session": { "identity": if cfg.require_identity { "required" } else { "optional" }, "proof": "ed25519" },
        "tls": st.tls,
    })))
}

async fn create_session(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let req: SessionRequest = if body.is_empty() {
        SessionRequest::default()
    } else {
        let v: Value = serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(format!("invalid json: {e}")))?;
        if !v.is_object() {
            return Err(ApiError::bad_request("body must be a JSON object"));
        }
        serde_json::from_value(v).map_err(|e| ApiError::bad_request(format!("invalid body: {e}")))?
    };
    let refused = |e: ApiError| {
        inc(&st.metrics.sessions_refused);
        e
    };
    let key = sessions::verify_proof(&req, sessions::now_secs()).map_err(refused)?;
    if st.cfg.require_identity && key.is_none() {
        return Err(refused(ApiError::new(StatusCode::UNAUTHORIZED, "identity_required", "this server requires an Ed25519 proof (publicKey, ts, sig)")));
    }
    let ip = net::client_ip(st.cfg.trust_proxy, &headers, Some(peer));
    let (token, s) = st.sessions.create_for(ip, key.clone()).map_err(refused)?;
    inc(&st.metrics.sessions_created);
    info!(sessions = st.sessions.count(), identity = key.is_some(), "session created");
    Ok((
        StatusCode::CREATED,
        no_store(Json(json!({
            "token": token,
            "sessionId": s.id,
            "expiresAt": s.expires_at(),
            "mediaBase": st.cfg.media_base(&token),
            "identity": key,
            "limits": {
                "streams": st.cfg.streams_per_session,
                "transcodes": st.cfg.transcodes_per_session,
                "proxySessions": st.cfg.proxy_sessions_per_session,
            },
        }))),
    )
        .into_response())
}

async fn metrics_route(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    use config::MetricsAccess;
    let allowed = match st.cfg.metrics {
        MetricsAccess::Public => true,
        MetricsAccess::Off => false,
        MetricsAccess::Loopback => net::is_local_request(&headers, Some(peer)),
    };
    if !allowed {
        return ApiError::not_found("no such route").into_response();
    }
    #[allow(unused_mut)]
    let mut g = metrics::Gauges {
        sessions: st.sessions.count(),
        sessions_active: st.sessions.active_count(),
        ws_open: gateway::ws_open(&st),
        children: st.supervisor.status(),
        ..Default::default()
    };
    #[cfg(feature = "engine")]
    {
        if let Some(e) = &st.eng {
            let stats = e.engine.stats();
            g.torrents = Some(stats.torrents.len());
            g.download_bps = Some(stats.torrents.iter().map(|t| t.download_bps).sum());
            g.cache_bytes = Some(stats.cache_used_bytes);
            g.peers = Some(stats.torrents.iter().map(|t| t.peers_live as u64).sum());
            g.proxy_sessions = Some(e.proxy.shared.session_count());
        }
        if let Some(m) = &st.media {
            let (jobs, tc) = m.running();
            g.hls_jobs = jobs;
            g.transcodes = tc;
            g.hwaccel = Some(m.encoder.read().name().to_string());
        }
    }
    let mut r = (StatusCode::OK, st.metrics.render(&g)).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; version=0.0.4"));
    r
}

pub fn no_store(r: impl IntoResponse) -> Response {
    let mut r = r.into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, tok) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(tok.trim())
}

/// The session of a Bearer token.
pub fn auth(st: &AppState, headers: &HeaderMap) -> ApiResult<(String, Arc<Session>)> {
    let tok = bearer(headers).ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;
    let s = st.sessions.verify(tok)?;
    Ok((tok.to_string(), s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_parsing() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h), None);
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer abc"));
        assert_eq!(bearer(&h), Some("abc"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&h), None);
    }
}
