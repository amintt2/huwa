//! Huwa Server (phase 0, spike S3 of docs/WEB_DOCKER_PLAN.md): the torrent engine and the
//! read-ahead HTTP proxy of the app behind a public HTTP API for Huwa Web. API: docs/server-api.md.
//!
//! - `GET  /api/v1/info`               capabilities
//! - `POST /api/v1/session`            per-browser session token
//! - `POST /api/v1/engine/{method}`    `huwa_torrent_core::api` methods, filtered per session
//! - `GET  /s/{token}/t/{hash}/{file}` torrent stream (Range / 206)
//! - `GET  /s/{token}/http/{id}`       read-ahead proxy stream (SSRF-guarded upstreams)
//! - `GET  /health`
//!
//! Everything runs on the engine's tokio runtime (as the app's loopback server does); engine calls
//! that block (`api::dispatch`) go through `spawn_blocking`. No seeding: `disable-upload` is a
//! compile-time feature of the engine and `seeding` is never enabled here.

pub mod config;
pub mod error;
pub mod sessions;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use huwa_torrent_core::{
    api,
    engine::{normalize_hash, Config as EngineConfig, Engine, ServerHandle},
    http_proxy::{self, HttpProxy, ProxyOptions},
    net_policy::{UpstreamGuard, UpstreamPolicy},
};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};

pub use config::ServerConfig;
use error::{ApiError, ApiResult};
use sessions::{Session, Sessions};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Version of the `/api/v1` contract (docs/server-api.md).
pub const API_VERSION: u32 = 1;

/// Engine methods a session may call (the others are operator-only or not exposed).
const FORBIDDEN_METHODS: &[&str] = &["setConfig", "clearCache", "enforceQuota", "tlsCheck"];

pub struct AppState {
    pub cfg: ServerConfig,
    pub engine: Arc<Engine>,
    pub proxy: Arc<HttpProxy>,
    pub sessions: Sessions,
}

/// The server, built synchronously (the engine owns its runtime and must be created outside it).
pub struct App {
    pub state: Arc<AppState>,
}

impl App {
    pub fn new(cfg: ServerConfig) -> Result<App> {
        let data_dir = cfg.cache_dir.join("engine");
        let engine_cfg: EngineConfig = serde_json::from_value(json!({
            "dataDir": data_dir,
            "cacheLimitBytes": cfg.cache_max_bytes,
            // Upload is compiled out (`disable-upload`) and stays off.
            "seeding": false,
            // Engine URLs are `/t/<hash>/<file>`; made `/s/<token>/t/…` per session (`media_urls`).
            "urlPrefix": "/t",
            "workerThreads": cfg.worker_threads,
        }))?;
        let engine = Engine::new(engine_cfg).context("starting the torrent engine")?;

        let policy = UpstreamPolicy { allow_private: cfg.allow_private_upstreams, allow_loopback: cfg.allow_loopback_upstreams };
        let guard = match &cfg.dns {
            Some(dns) => UpstreamGuard::with_lookup(policy, dns.clone()),
            None => UpstreamGuard::new(policy),
        };
        let proxy = HttpProxy::start_with(ProxyOptions {
            guard: Some(guard),
            url_prefix: Some(String::new()),
            no_listener: true,
            ..Default::default()
        })
        .context("starting the http proxy")?;

        let key = cfg.data_dir.as_deref().and_then(sessions::load_or_create_key);
        if key.is_none() {
            warn!("no usable data dir for token.key: session tokens will not survive a restart");
        }
        let sessions = match key {
            Some(k) => Sessions::new(k, cfg.session_ttl),
            None => Sessions::with_random_key(cfg.session_ttl),
        };
        Ok(App { state: Arc::new(AppState { cfg, engine, proxy, sessions }) })
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.state.engine
    }

    pub fn router(&self) -> Router {
        router(self.state.clone())
    }

    /// Binds `addr` and serves on the engine runtime in the background (registered with the
    /// engine, so `shutdown` stops it). Returns the bound address.
    pub fn spawn(&self, addr: SocketAddr) -> Result<SocketAddr> {
        let engine = self.state.engine.clone();
        let listener = engine.runtime.block_on(tokio::net::TcpListener::bind(addr)).with_context(|| format!("binding {addr}"))?;
        let local = listener.local_addr()?;
        engine.set_port(local.port());
        let app = self.router();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let task = engine.runtime.spawn(async move {
            let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = stopped.await;
            });
            if let Err(e) = serve.await {
                warn!("server stopped: {e:#}");
            }
        });
        engine.set_server(ServerHandle { stop, task });
        self.spawn_janitor();
        Ok(local)
    }

    /// Expired sessions are forgotten; torrents nobody holds any more are released (parked; the
    /// cache quota evicts them later).
    fn spawn_janitor(&self) {
        let weak = Arc::downgrade(&self.state);
        self.state.engine.runtime.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                let Some(st) = weak.upgrade() else { return };
                for hex in st.sessions.sweep() {
                    let _ = st.engine.release(&hex, None);
                }
            }
        });
    }

    /// Stops the HTTP server, the proxy and the engine (blocking; outside the runtime).
    pub fn shutdown(&self) {
        self.state.proxy.shutdown();
        self.state.engine.shutdown();
    }
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
        .expose_headers([header::CONTENT_RANGE, header::CONTENT_LENGTH, header::ACCEPT_RANGES, header::CONTENT_TYPE, header::RETRY_AFTER])
        .max_age(Duration::from_secs(600))
        // Chrome Private Network Access: a public page (huwa.mciut.fr) calling a LAN server.
        .allow_private_network(true)
}

pub fn router(state: Arc<AppState>) -> Router {
    let cors = cors_layer(&state.cfg);
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/v1/info", get(info_route))
        .route("/api/v1/session", post(create_session))
        .route("/api/v1/engine/{method}", post(engine_call))
        .route("/s/{token}/t/{info_hash}/{file}", get(torrent_stream))
        .route("/s/{token}/http/{file}", get(http_stream))
        .fallback(|| async { ApiError::not_found("no such route") })
        .layer(cors)
        .with_state(state)
}

// ------------------------------------------------------------------------------------------------
// Info and sessions
// ------------------------------------------------------------------------------------------------

async fn info_route(State(st): State<Arc<AppState>>) -> Response {
    let cfg = &st.cfg;
    no_store(Json(json!({
        "name": "huwa-server",
        "version": VERSION,
        "api": API_VERSION,
        "engine": huwa_torrent_core::VERSION,
        "publicUrl": cfg.public_url,
        "features": {
            "torrent": true,
            "httpProxy": true,
            "transcode": false,
            "fetchProxy": false,
            "stremioCompat": false,
            "p2pGateway": false,
            "seeding": false,
        },
        "limits": {
            "streamsPerSession": cfg.streams_per_session,
            "cacheMaxBytes": cfg.cache_max_bytes,
            "sessionTtlSecs": cfg.session_ttl.as_secs(),
        },
        "session": { "identity": "none" },
    })))
}

async fn create_session(State(st): State<Arc<AppState>>, body: Bytes) -> ApiResult<Response> {
    // Spike: the body (future `{publicKey, ts, sig}`, D11) is parsed but not verified yet.
    if !body.is_empty() {
        let v: Value = serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(format!("invalid json: {e}")))?;
        if !v.is_object() {
            return Err(ApiError::bad_request("body must be a JSON object"));
        }
    }
    let (token, s) = st.sessions.create();
    info!(sessions = st.sessions.count(), "session created");
    Ok((
        StatusCode::CREATED,
        no_store(Json(json!({
            "token": token,
            "sessionId": s.id,
            "expiresAt": s.expires_at,
            "mediaBase": st.cfg.media_base(&token),
            "limits": { "streams": st.cfg.streams_per_session },
        }))),
    )
        .into_response())
}

fn no_store(r: impl IntoResponse) -> Response {
    let mut r = r.into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, tok) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(tok.trim())
}

fn auth(st: &AppState, headers: &HeaderMap) -> ApiResult<(String, Arc<Session>)> {
    let tok = bearer(headers).ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;
    let s = st.sessions.verify(tok)?;
    Ok((tok.to_string(), s))
}

// ------------------------------------------------------------------------------------------------
// Engine calls
// ------------------------------------------------------------------------------------------------

/// Makes engine / proxy URLs (`/t/…`, `/http/…`) the session's media URLs, everywhere in `v`.
pub fn media_urls(v: &mut Value, base: &str) {
    match v {
        Value::Object(map) => {
            for (k, x) in map.iter_mut() {
                match x {
                    Value::String(s) if k == "url" && (s.starts_with("/t/") || s.starts_with("/http/")) => {
                        *s = format!("{base}{s}");
                    }
                    _ => media_urls(x, base),
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| media_urls(x, base)),
        _ => {}
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::internal(format!("task failed: {e}")))?.map_err(ApiError::engine)
}

fn hash_arg(args: &Value) -> ApiResult<String> {
    let raw = args
        .get("infoHash")
        .or_else(|| args.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("missing `infoHash` / `id`"))?;
    normalize_hash(raw).map(|(_, hex)| hex).map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

fn u64_ids(args: &Value) -> ApiResult<Vec<u64>> {
    huwa_torrent_core::probe::ids_of(args).map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

fn torrent_not_found() -> ApiError {
    ApiError::not_found("unknown torrent")
}

async fn engine_call(State(st): State<Arc<AppState>>, Path(method): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let (token, session) = auth(&st, &headers)?;
    let mut args: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(format!("invalid json: {e}")))?
    };
    if !args.is_object() {
        return Err(ApiError::bad_request("arguments must be a JSON object"));
    }
    if FORBIDDEN_METHODS.contains(&method.as_str()) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "forbidden_method", format!("{method} is not available to sessions")));
    }
    let engine = st.engine.clone();
    let mut out = match method.as_str() {
        "startStream" | "prewarm" => {
            let hex = hash_arg(&args)?;
            if method == "startStream" {
                session.claim_slot(&hex, st.cfg.streams_per_session)?;
            }
            let m = method.clone();
            let res = blocking(move || api::dispatch(&engine, &m, args)).await;
            match res {
                Ok(v) => {
                    st.sessions.hold(&session, &hex);
                    v
                }
                Err(e) => {
                    if !session.holds(&hex) {
                        session.free_slot(&hex);
                    }
                    return Err(e);
                }
            }
        }
        "status" => {
            let hex = hash_arg(&args)?;
            if !session.holds(&hex) {
                return Err(torrent_not_found());
            }
            serde_json::to_value(engine.status(&hex).map_err(ApiError::engine)?).map_err(|e| ApiError::internal(e.to_string()))?
        }
        "list" => {
            let held = session.torrents.lock().clone();
            let list: Vec<_> = engine.list().into_iter().filter(|t| held.contains(&t.info_hash)).collect();
            serde_json::to_value(list).map_err(|e| ApiError::internal(e.to_string()))?
        }
        "stats" => {
            let held = session.torrents.lock().clone();
            let mut stats = engine.stats();
            stats.torrents.retain(|t| held.contains(&t.info_hash));
            stats.port = 0;
            serde_json::to_value(stats).map_err(|e| ApiError::internal(e.to_string()))?
        }
        "pause" | "resume" | "release" | "remove" => {
            let hex = hash_arg(&args)?;
            if !session.holds(&hex) {
                return Err(torrent_not_found());
            }
            // A torrent shared with other sessions is only acted on by its last holder; the
            // others just let go of it (`remove`, `release`) or are no-ops (`pause`).
            let sole = st.sessions.holders_of(&hex) <= 1;
            match method.as_str() {
                "remove" => {
                    let left = st.sessions.unhold(&session, &hex).unwrap_or(0);
                    if left == 0 {
                        blocking(move || api::dispatch(&engine, "remove", json!({ "id": hex }))).await?
                    } else {
                        Value::Bool(true)
                    }
                }
                "release" => {
                    session.free_slot(&hex);
                    if sole {
                        let m = method.clone();
                        blocking(move || api::dispatch(&engine, &m, args)).await?
                    } else {
                        Value::Bool(true)
                    }
                }
                "pause" if !sole => Value::Bool(true),
                _ => {
                    let m = method.clone();
                    blocking(move || api::dispatch(&engine, &m, args)).await?
                }
            }
        }
        "probeStart" => {
            let _ = hash_arg(&args)?;
            let v = blocking(move || api::dispatch(&engine, "probeStart", args)).await?;
            if let Some(id) = v.get("id").and_then(Value::as_u64) {
                session.probes.lock().insert(id);
            }
            v
        }
        "probeStatus" | "probeCancel" => {
            let single = args.get("id").and_then(Value::as_u64).is_some();
            let owned: Vec<u64> = {
                let probes = session.probes.lock();
                u64_ids(&args)?.into_iter().filter(|id| probes.contains(id)).collect()
            };
            if single && owned.is_empty() {
                return Err(ApiError::not_found("unknown probe"));
            }
            if method == "probeCancel" {
                let mut probes = session.probes.lock();
                owned.iter().for_each(|id| {
                    probes.remove(id);
                });
            }
            args = if single { json!({ "id": owned[0] }) } else { json!({ "ids": owned }) };
            let m = method.clone();
            blocking(move || api::dispatch(&engine, &m, args)).await?
        }
        "httpOpen" => {
            let proxy = st.proxy.clone();
            let v = blocking(move || proxy.dispatch("httpOpen", args)).await?;
            if let Some(id) = v.get("id").and_then(Value::as_u64) {
                *session.http.lock().entry(id).or_default() += 1;
            }
            v
        }
        "httpPrefetch" | "httpStatus" | "httpRelease" => {
            let id = args.get("id").and_then(Value::as_u64).ok_or_else(|| ApiError::bad_request("missing `id`"))?;
            if !session.owns_http(id) {
                return Err(ApiError::not_found("unknown http session"));
            }
            if method == "httpRelease" {
                let mut http = session.http.lock();
                if let Some(n) = http.get_mut(&id) {
                    *n -= 1;
                    if *n == 0 {
                        http.remove(&id);
                    }
                }
            }
            let proxy = st.proxy.clone();
            let m = method.clone();
            blocking(move || proxy.dispatch(&m, args)).await?
        }
        _ => return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown_method", format!("unknown method {method:?}"))),
    };
    media_urls(&mut out, &st.cfg.media_base(&token));
    Ok(no_store(Json(out)))
}

// ------------------------------------------------------------------------------------------------
// Media
// ------------------------------------------------------------------------------------------------

/// Keeps `guard` alive as long as the body is being sent.
fn guarded_body<G: Send + 'static>(resp: Response, guard: G) -> Response {
    let (parts, body) = resp.into_parts();
    let stream = body.into_data_stream().map(move |chunk| {
        let _ = &guard;
        chunk
    });
    Response::from_parts(parts, Body::from_stream(stream))
}

async fn torrent_stream(
    State(st): State<Arc<AppState>>,
    Path((token, info_hash, file)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let session = st.sessions.verify(&token)?;
    let hex = normalize_hash(&info_hash).map(|(_, h)| h).map_err(|_| torrent_not_found())?;
    if !session.holds(&hex) {
        return Err(torrent_not_found());
    }
    session.claim_slot(&hex, st.cfg.streams_per_session)?;
    let guard = session.open_stream(&hex);
    let resp = huwa_torrent_core::server::serve_file(st.engine.clone(), &hex, &file, &headers).await;
    Ok(guarded_body(resp, guard))
}

async fn http_stream(State(st): State<Arc<AppState>>, Path((token, file)): Path<(String, String)>, headers: HeaderMap) -> ApiResult<Response> {
    let session = st.sessions.verify(&token)?;
    let id: u64 = file.split_once('.').map_or(file.as_str(), |(i, _)| i).parse().map_err(|_| ApiError::not_found("unknown http session"))?;
    if !session.owns_http(id) {
        return Err(ApiError::not_found("unknown http session"));
    }
    Ok(http_proxy::serve_session(st.proxy.shared.clone(), file, headers).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_urls_are_rewritten_everywhere() {
        let mut v = json!({
            "url": "/t/abc/0.mkv",
            "torrents": [{ "url": "/t/def/auto" }, { "url": "https://elsewhere/t/x" }],
            "proxy": { "url": "/http/3.mkv", "id": 3 },
            "name": "/t/not-a-url-field",
        });
        media_urls(&mut v, "/s/TOK");
        assert_eq!(v["url"], "/s/TOK/t/abc/0.mkv");
        assert_eq!(v["torrents"][0]["url"], "/s/TOK/t/def/auto");
        assert_eq!(v["torrents"][1]["url"], "https://elsewhere/t/x");
        assert_eq!(v["proxy"]["url"], "/s/TOK/http/3.mkv");
        assert_eq!(v["name"], "/t/not-a-url-field");
    }

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
