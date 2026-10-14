//! Torrent engine and HTTP proxy behind the API (`/api/v1/engine/{method}`) and the media routes
//! (`/s/{token}/t/…`, `/s/{token}/http/…`), plus the internal loopback listener that ffmpeg reads
//! (`http://127.0.0.1:<port>/i/<secret>/…`: ffmpeg never gets a user URL, D13).

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures::StreamExt;
use huwa_torrent_core::{
    api,
    engine::{normalize_hash, Config as EngineConfig, Engine, StartStreamRequest},
    http_proxy::{self, HttpProxy, ProxyOptions},
    net_policy::{UpstreamGuard, UpstreamPolicy},
};
use serde_json::{json, Value};
use tracing::warn;

use crate::{
    error::{ApiError, ApiResult},
    metrics::inc,
    sessions::{random_hex, Session},
    AppState, ServerConfig,
};

/// Engine methods a session may not call (operator settings come from the environment).
pub const FORBIDDEN_METHODS: &[&str] = &["setConfig", "clearCache", "enforceQuota", "tlsCheck"];

pub struct EngineParts {
    pub engine: Arc<Engine>,
    pub proxy: Arc<HttpProxy>,
    /// Upstream policy for anything the server fetches itself (compat `/subtitles.vtt`).
    pub guard: UpstreamGuard,
    /// Internal loopback listener for ffmpeg / ffprobe. Each URL carries a capability for its
    /// own source only (HMAC of the source): a demuxer that follows a relative or absolute URL
    /// found inside a file cannot reach another stream.
    pub internal_port: std::sync::atomic::AtomicU16,
    internal_key: ring::hmac::Key,
}

/// Demuxers ffmpeg / ffprobe may use: self-contained containers only. Playlist and manifest
/// formats (hls, dash, concat, …) that open URLs found in the file are not in the list.
pub const FORMAT_WHITELIST: &str = "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpegts,mpegtsraw,avi,flv,ogg,asf,wav,mp3,aac,flac,mpeg,mpegvideo,h264,hevc,m4v,ac3,eac3,dts,truehd,ass,srt,webvtt,ivf,obu,nut,rm,wtv,matroska_pipe";

impl EngineParts {
    pub fn new(cfg: &ServerConfig) -> Result<EngineParts> {
        let data_dir = cfg.cache_dir.join("engine");
        let download_bps = (cfg.download_limit_mbps > 0.0).then(|| (cfg.download_limit_mbps * 1_000_000.0 / 8.0) as u64);
        let engine_cfg: EngineConfig = serde_json::from_value(json!({
            "dataDir": data_dir,
            "cacheLimitBytes": cfg.cache_max_bytes,
            // Upload is compiled out (`disable-upload`) and stays off.
            "seeding": false,
            // Engine URLs are `/t/<hash>/<file>`; made `/s/<token>/t/…` per session (`media_urls`).
            "urlPrefix": "/t",
            "workerThreads": cfg.worker_threads,
            "downloadBps": download_bps,
        }))?;
        let engine = Engine::new(engine_cfg).context("starting the torrent engine")?;
        let policy = UpstreamPolicy { allow_private: cfg.allow_private_upstreams, allow_loopback: cfg.allow_loopback_upstreams };
        let guard = match &cfg.dns {
            Some(dns) => UpstreamGuard::with_lookup(policy, dns.clone()),
            None => UpstreamGuard::new(policy),
        };
        let proxy = HttpProxy::start_with(ProxyOptions {
            guard: Some(guard.clone()),
            url_prefix: Some(String::new()),
            no_listener: true,
            max_sessions: Some(cfg.proxy_sessions),
            session_budget: Some(cfg.proxy_readahead_bytes),
            ..Default::default()
        })
        .context("starting the http proxy")?;
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, random_hex::<32>().as_bytes());
        Ok(EngineParts { engine, proxy, guard, internal_port: Default::default(), internal_key: key })
    }

    /// Binds the internal listener on `127.0.0.1:0` (engine runtime).
    pub fn start_internal(self: &Arc<Self>) -> Result<()> {
        let listener = self.engine.runtime.block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))?;
        self.internal_port.store(listener.local_addr()?.port(), std::sync::atomic::Ordering::Relaxed);
        let app = Router::new()
            .route("/i/{cap}/t/{info_hash}/{file}", get(internal_torrent))
            .route("/i/{cap}/http/{file}", get(internal_http))
            .with_state(self.clone());
        self.engine.runtime.spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                warn!("internal media listener stopped: {e:#}");
            }
        });
        Ok(())
    }

    fn cap(&self, scope: &str) -> String {
        hex::encode(&ring::hmac::sign(&self.internal_key, scope.as_bytes()).as_ref()[..16])
    }

    fn cap_ok(&self, cap: &str, scope: &str) -> bool {
        let Ok(mac) = hex::decode(cap) else { return false };
        let want = ring::hmac::sign(&self.internal_key, scope.as_bytes());
        mac.len() == 16 && mac.iter().zip(want.as_ref()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    fn internal_base(&self, scope: &str) -> String {
        format!("http://127.0.0.1:{}/i/{}", self.internal_port.load(std::sync::atomic::Ordering::Relaxed), self.cap(scope))
    }

    /// Loopback URL of a torrent file for ffmpeg (`None`: the engine's pick, `auto`).
    pub fn internal_torrent_url(&self, hex: &str, file: Option<usize>) -> String {
        format!("{}/t/{hex}/{}", self.internal_base(&format!("t-{hex}")), file.map_or("auto".to_string(), |f| f.to_string()))
    }

    /// Loopback URL of an HTTP proxy session for ffmpeg.
    pub fn internal_http_url(&self, id: u64) -> String {
        format!("{}/http/{id}", self.internal_base(&format!("h-{id}")))
    }

    /// Stremio-style sources with tracker URLs the upstream policy refuses removed (a tracker
    /// announce is an HTTP / UDP request the server makes: no internal addresses). The check
    /// resolves the name once; librqbit's tracker client resolves again on its own (rebinding is
    /// out of reach of this check, see docs/server-api.md §8).
    pub fn filter_sources(&self, sources: Vec<String>) -> Vec<String> {
        sources
            .into_iter()
            .filter(|s| {
                let Some(t) = s.strip_prefix("tracker:").or_else(|| (s.contains("://")).then_some(s.as_str())) else { return true };
                let ok = url::Url::parse(t).ok().is_some_and(|u| {
                    matches!(u.scheme(), "http" | "https" | "udp")
                        && match u.host() {
                            Some(url::Host::Ipv4(ip)) => self.guard.policy.allows(ip.into()),
                            Some(url::Host::Ipv6(ip)) => self.guard.policy.allows(ip.into()),
                            Some(url::Host::Domain(d)) => {
                                !d.eq_ignore_ascii_case("localhost")
                                    && !d.to_ascii_lowercase().ends_with(".localhost")
                                    && self.guard.lookup.lookup(d).map_or(true, |addrs| addrs.iter().all(|a| self.guard.policy.allows(a.ip())))
                            }
                            None => false,
                        }
                });
                if !ok {
                    tracing::info!("tracker source refused by the upstream policy");
                }
                ok
            })
            .collect()
    }

    pub fn shutdown(&self) {
        self.proxy.shutdown();
        self.engine.shutdown();
    }
}

async fn internal_torrent(State(p): State<Arc<EngineParts>>, Path((cap, info_hash, file)): Path<(String, String, String)>, headers: HeaderMap) -> Response {
    let Ok((_, hex)) = normalize_hash(&info_hash) else { return StatusCode::NOT_FOUND.into_response() };
    if !p.cap_ok(&cap, &format!("t-{hex}")) {
        return StatusCode::NOT_FOUND.into_response();
    }
    huwa_torrent_core::server::serve_file(p.engine.clone(), &hex, &file, &headers).await
}

async fn internal_http(State(p): State<Arc<EngineParts>>, Path((cap, file)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let Some(id) = file.split('.').next().and_then(|i| i.parse::<u64>().ok()) else { return StatusCode::NOT_FOUND.into_response() };
    if !p.cap_ok(&cap, &format!("h-{id}")) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let resp = http_proxy::serve_session(p.proxy.shared.clone(), file, headers).await;
    // The proxy answers 302 to the original URL when the upstream ignores Range: ffmpeg must
    // never follow it (it would fetch outside the upstream policy).
    if resp.status().is_redirection() {
        return (StatusCode::BAD_GATEWAY, "upstream without Range support").into_response();
    }
    resp
}

// ------------------------------------------------------------------------------------------------
// Engine calls
// ------------------------------------------------------------------------------------------------

/// Stream token scope of an engine / proxy path (`/t/<hash>/…` → `t-<hash>`, `/http/<id>…` →
/// `h-<id>`).
pub fn scope_of_path(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix("/t/") {
        let hash = rest.split('/').next()?;
        return (hash.len() == 40).then(|| format!("t-{}", hash.to_ascii_lowercase()));
    }
    if let Some(rest) = path.strip_prefix("/http/") {
        let id = rest.split(['.', '/']).next()?;
        return id.parse::<u64>().ok().map(|id| format!("h-{id}"));
    }
    None
}

/// Makes engine / proxy URLs (`/t/…`, `/http/…`) media URLs, everywhere in `v`: `base(path)`
/// returns the prefix (`{publicUrl}/s/{stream token}`) for a path.
pub fn media_urls(v: &mut Value, base: &dyn Fn(&str) -> Option<String>) {
    match v {
        Value::Object(map) => {
            for (k, x) in map.iter_mut() {
                match x {
                    Value::String(s) if k == "url" && (s.starts_with("/t/") || s.starts_with("/http/")) => {
                        if let Some(b) = base(s) {
                            *s = format!("{b}{s}");
                        }
                    }
                    _ => media_urls(x, base),
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| media_urls(x, base)),
        _ => {}
    }
}

/// The media URL prefix of `session` for an engine path (a per-stream token).
pub fn media_base_for(st: &AppState, session: &Session, path: &str) -> Option<String> {
    let scope = scope_of_path(path)?;
    Some(st.cfg.media_base(&st.sessions.stream_token(session, &scope)))
}

pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> ApiResult<T> {
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

pub fn torrent_not_found() -> ApiError {
    ApiError::not_found("unknown torrent")
}

pub fn no_store(r: impl IntoResponse) -> Response {
    let mut r = r.into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// Starts (or refreshes) a stream for `session`: slot, engine start as the session's focus, hold.
/// Torrents one session may hold at a time (`startStream` / `prewarm`).
pub const MAX_HELD_TORRENTS: usize = 32;
/// Swarm probes one session may have running.
pub const MAX_RUNNING_PROBES: usize = 16;

fn filtered_args(eng: &EngineParts, mut args: Value) -> Value {
    if let Some(src) = args.get("sources").and_then(Value::as_array) {
        let list: Vec<String> = src.iter().filter_map(Value::as_str).map(str::to_string).collect();
        args["sources"] = json!(eng.filter_sources(list));
    }
    args
}

pub async fn start_stream(st: &Arc<AppState>, eng: &Arc<EngineParts>, session: &Arc<Session>, args: Value, prewarm: bool) -> ApiResult<Value> {
    let hex = hash_arg(&args)?;
    if !session.holds(&hex) && session.torrents.lock().len() >= MAX_HELD_TORRENTS {
        inc(&st.metrics.quota_refusals);
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", format!("too many torrents held ({MAX_HELD_TORRENTS}): remove some"))
            .with("limit", json!(MAX_HELD_TORRENTS))
            .with("kind", json!("torrents")));
    }
    let args = {
        let eng = eng.clone();
        tokio::task::spawn_blocking(move || filtered_args(&eng, args)).await.map_err(|e| ApiError::internal(e.to_string()))?
    };
    if !prewarm {
        if let Err(e) = session.claim_slot(&hex, st.cfg.streams_per_session) {
            inc(&st.metrics.quota_refusals);
            return Err(e);
        }
    }
    let req: StartStreamRequest = serde_json::from_value(args).map_err(|e| ApiError::bad_request(format!("{e}")))?;
    let engine = eng.engine.clone();
    let owner = session.id.clone();
    let res = blocking(move || {
        let r = if prewarm { engine.prewarm(req)? } else { engine.start_stream_for(req, &owner)? };
        Ok(serde_json::to_value(r)?)
    })
    .await;
    match res {
        Ok(v) => {
            st.sessions.hold(session, &hex);
            Ok(v)
        }
        Err(e) => {
            if !session.holds(&hex) {
                session.free_slot(&hex);
            }
            Err(e)
        }
    }
}

pub async fn engine_call(State(st): State<Arc<AppState>>, Path(method): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let Some(eng) = st.eng.clone() else { return Err(ApiError::not_found("no such route")) };
    let (_, session) = crate::auth(&st, &headers)?;
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
    let engine = eng.engine.clone();
    let mut out = match method.as_str() {
        "startStream" => start_stream(&st, &eng, &session, args, false).await?,
        "prewarm" => start_stream(&st, &eng, &session, args, true).await?,
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
            if !sole && matches!(method.as_str(), "remove" | "release") {
                engine.drop_focus_of(&session.id, &hex);
            }
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
            {
                let mut probes = session.probes.lock();
                probes.retain(|id| engine.probes.get(*id).is_some_and(|p| !p.status().state.is_final()));
                if probes.len() >= MAX_RUNNING_PROBES {
                    inc(&st.metrics.quota_refusals);
                    return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", format!("too many probes running ({MAX_RUNNING_PROBES})"))
                        .with("limit", json!(MAX_RUNNING_PROBES))
                        .with("kind", json!("probes")));
                }
            }
            let e2 = eng.clone();
            let args = tokio::task::spawn_blocking(move || filtered_args(&e2, args)).await.map_err(|e| ApiError::internal(e.to_string()))?;
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
            let cap = st.cfg.proxy_sessions_per_session;
            {
                // Reserved under the lock: concurrent opens cannot overshoot the cap.
                let http = session.http.lock();
                if cap > 0 && http.len() + session.http_pending.load(std::sync::atomic::Ordering::Acquire) >= cap {
                    inc(&st.metrics.quota_refusals);
                    return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", format!("HTTP proxy quota exceeded ({cap} per session): httpRelease some"))
                        .with("limit", json!(cap))
                        .with("kind", json!("proxy")));
                }
                session.http_pending.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            }
            let proxy = eng.proxy.clone();
            let res = blocking(move || proxy.dispatch("httpOpen", args)).await;
            let mut http = session.http.lock();
            session.http_pending.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
            let v = res?;
            if let Some(id) = v.get("id").and_then(Value::as_u64) {
                *http.entry(id).or_default() += 1;
            }
            v
        }
        "httpPrefetch" | "httpStatus" | "httpRelease" => {
            let id = args.get("id").and_then(Value::as_u64).ok_or_else(|| ApiError::bad_request("missing `id`"))?;
            if !session.owns_http(id) {
                return Err(ApiError::not_found("unknown http session"));
            }
            if method == "httpRelease" {
                // One proxy reference released per reference this session really gave up.
                let mut http = session.http.lock();
                let Some(n) = http.get_mut(&id) else { return Err(ApiError::not_found("unknown http session")) };
                *n -= 1;
                if *n == 0 {
                    http.remove(&id);
                    session.free_slot(&format!("http:{id}"));
                }
            }
            let proxy = eng.proxy.clone();
            let m = method.clone();
            blocking(move || proxy.dispatch(&m, args)).await?
        }
        _ => return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown_method", format!("unknown method {method:?}"))),
    };
    media_urls(&mut out, &|p| media_base_for(&st, &session, p));
    Ok(no_store(Json(out)))
}

// ------------------------------------------------------------------------------------------------
// Media
// ------------------------------------------------------------------------------------------------

/// Keeps `guard` alive as long as the body is being sent.
pub fn guarded_body<G: Send + 'static>(resp: Response, guard: G) -> Response {
    let (parts, body) = resp.into_parts();
    let stream = body.into_data_stream().map(move |chunk| {
        let _ = &guard;
        chunk
    });
    Response::from_parts(parts, Body::from_stream(stream))
}

/// Headers of every media response: the token in the path must not leak through `Referer`.
pub fn media_headers(mut resp: Response) -> Response {
    resp.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    resp
}

pub async fn torrent_stream(State(st): State<Arc<AppState>>, Path((token, info_hash, file)): Path<(String, String, String)>, headers: HeaderMap) -> ApiResult<Response> {
    let Some(eng) = st.eng.clone() else { return Err(ApiError::not_found("no such route")) };
    let hex = normalize_hash(&info_hash).map(|(_, h)| h).map_err(|_| torrent_not_found())?;
    let session = st.sessions.verify_media(&token, &format!("t-{hex}"))?;
    if !session.holds(&hex) {
        return Err(torrent_not_found());
    }
    if let Err(e) = session.claim_slot(&hex, st.cfg.streams_per_session) {
        inc(&st.metrics.quota_refusals);
        return Err(e);
    }
    let guard = session.open_stream(&hex);
    let resp = huwa_torrent_core::server::serve_file(eng.engine.clone(), &hex, &file, &headers).await;
    Ok(media_headers(guarded_body(resp, guard)))
}

pub async fn http_stream(State(st): State<Arc<AppState>>, Path((token, file)): Path<(String, String)>, headers: HeaderMap) -> ApiResult<Response> {
    let Some(eng) = st.eng.clone() else { return Err(ApiError::not_found("no such route")) };
    let id: u64 = file.split_once('.').map_or(file.as_str(), |(i, _)| i).parse().map_err(|_| ApiError::not_found("unknown http session"))?;
    let session = st.sessions.verify_media(&token, &format!("h-{id}"))?;
    if !session.owns_http(id) {
        return Err(ApiError::not_found("unknown http session"));
    }
    // HTTP proxy streams count against the per-session stream quota, like torrents.
    let key = format!("http:{id}");
    if let Err(e) = session.claim_slot(&key, st.cfg.streams_per_session) {
        inc(&st.metrics.quota_refusals);
        return Err(e);
    }
    let guard = session.open_stream(&key);
    let resp = http_proxy::serve_session(eng.proxy.shared.clone(), file, headers).await;
    Ok(media_headers(guarded_body(resp, guard)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_urls_are_rewritten_everywhere() {
        let mut v = json!({
            "url": "/t/abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd/0.mkv",
            "torrents": [{ "url": "/t/defdefdefdefdefdefdefdefdefdefdefdefdefd/auto" }, { "url": "https://elsewhere/t/x" }],
            "proxy": { "url": "/http/3.mkv", "id": 3 },
            "name": "/t/not-a-url-field",
        });
        media_urls(&mut v, &|p| scope_of_path(p).map(|s| format!("/s/{s}")));
        assert_eq!(v["url"], "/s/t-abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd/t/abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd/0.mkv");
        assert_eq!(v["torrents"][0]["url"], "/s/t-defdefdefdefdefdefdefdefdefdefdefdefdefd/t/defdefdefdefdefdefdefdefdefdefdefdefdefd/auto");
        assert_eq!(v["torrents"][1]["url"], "https://elsewhere/t/x");
        assert_eq!(v["proxy"]["url"], "/s/h-3/http/3.mkv");
        assert_eq!(v["name"], "/t/not-a-url-field");
    }
}
