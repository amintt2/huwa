//! Stremio streaming-server compatible surface (D10), opt-in with `HUWA_STREMIO_COMPAT=1`,
//! mounted at the root so Stremio Web (or any client of that protocol) can use a Huwa server as
//! its "streaming server URL".
//!
//! Protocol compatibility only: the request and response shapes were read from the public clients
//! (stremio-core `types/streaming_server`, `models/streaming_server.rs`; stremio-video
//! `withStreamingServer`). No Stremio code is copied.
//!
//! Stremio clients send no credentials, so every compat request shares one anonymous session (one
//! quota bucket: `HUWA_STREMIO_COMPAT_STREAMS` streams, the transcode limits of a session). An
//! operator who exposes it publicly should put the instance behind reverse-proxy auth.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    body::{Body, Bytes},
    extract::{Path, RawQuery, State},
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::{
    engine_api::{self, media_headers, EngineParts},
    error::{ApiError, ApiResult},
    media::{self, decide::ClientCaps, probe::Kind, query_pairs, Source},
    metrics::inc,
    sessions::Session,
    AppState,
};

pub const COMPAT_SESSION: &str = "stremio-compat";
/// How long `create` waits for the metadata (to answer `guessedFileIdx`).
const CREATE_META_WAIT: Duration = Duration::from_secs(30);

/// Compat HLS ids (`/hlsv2/<id>/…`, chosen by the client) → media session ids.
#[derive(Default)]
pub struct Compat {
    hls: Mutex<HashMap<String, String>>,
}

fn session(st: &AppState) -> Arc<Session> {
    st.sessions.internal(COMPAT_SESSION)
}

fn parts(st: &AppState) -> ApiResult<Arc<EngineParts>> {
    if !st.cfg.stremio_compat {
        return Err(ApiError::not_found("no such route"));
    }
    inc(&st.metrics.compat_requests);
    st.eng.clone().ok_or_else(|| ApiError::not_found("no such route"))
}

fn is_hash(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

fn wants_html(h: &HeaderMap) -> bool {
    h.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"))
}

/// Base URL the client reaches this server at.
fn base_url(st: &AppState, h: &HeaderMap) -> String {
    if let Some(u) = &st.cfg.public_url {
        return format!("{u}/");
    }
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("127.0.0.1");
    let proto = if st.tls {
        "https"
    } else if st.cfg.trust_proxy {
        h.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("http")
    } else {
        "http"
    };
    format!("{proto}://{host}/")
}

// ------------------------------------------------------------------------------------------------
// Settings and static info
// ------------------------------------------------------------------------------------------------

pub async fn settings_get(State(st): State<Arc<AppState>>, headers: HeaderMap, req: Request<Body>) -> Response {
    // The web app has a `/settings` page: browsers navigating there get it.
    if wants_html(&headers) || parts(&st).is_err() {
        return crate::web::serve_static(st, req).await;
    }
    let cfg = &st.cfg;
    let hw = st.media.as_ref().map(|m| m.encoder.read().name()).unwrap_or("libx264");
    Json(json!({
        "baseUrl": base_url(&st, &headers),
        "values": {
            "serverVersion": crate::VERSION,
            "appPath": cfg.data_dir.as_ref().map(|d| d.display().to_string()).unwrap_or_default(),
            "cacheRoot": cfg.cache_dir.display().to_string(),
            "cacheSize": cfg.cache_max_bytes,
            "btMaxConnections": 55,
            "btHandshakeTimeout": 20000,
            "btRequestTimeout": 4000,
            "btDownloadSpeedSoftLimit": 0,
            "btDownloadSpeedHardLimit": ((cfg.download_limit_mbps * 125_000.0) as u64),
            "btMinPeersForStable": 5,
            "remoteHttps": Value::Null,
            "localAddonEnabled": false,
            "transcodeProfile": Value::Null,
            "transcodeHardwareAccel": hw != "libx264",
            "proxyStreamsEnabled": false,
            "allTranscodeProfiles": [],
        },
        "options": [],
    }))
    .into_response()
}

pub async fn settings_post(State(st): State<Arc<AppState>>) -> ApiResult<Response> {
    parts(&st)?;
    // Operator settings come from the environment: accepted and ignored.
    Ok(Json(json!({ "success": true })).into_response())
}

pub async fn network_info(State(st): State<Arc<AppState>>) -> ApiResult<Response> {
    parts(&st)?;
    Ok(Json(json!({ "availableInterfaces": [] })).into_response())
}

pub async fn device_info(State(st): State<Arc<AppState>>) -> ApiResult<Response> {
    parts(&st)?;
    let hw: Vec<&str> = st.media.as_ref().map(|m| m.encoder.read().name()).filter(|n| *n != "libx264").into_iter().collect();
    Ok(Json(json!({ "availableHardwareAccelerations": hw })).into_response())
}

pub async fn casting(State(st): State<Arc<AppState>>) -> ApiResult<Response> {
    parts(&st)?;
    Ok(Json(json!([])).into_response())
}

// ------------------------------------------------------------------------------------------------
// Torrents
// ------------------------------------------------------------------------------------------------

fn stremio_stats(t: &huwa_torrent_core::engine::TorrentStatus, file: Option<usize>) -> Value {
    let mut offset = 0u64;
    let files: Vec<Value> = t
        .files
        .iter()
        .map(|f| {
            let v = json!({ "name": f.name.rsplit('/').next().unwrap_or(&f.name), "path": f.name, "length": f.size, "offset": offset });
            offset += f.size;
            v
        })
        .collect();
    let mut v = json!({
        "infoHash": t.info_hash,
        "name": t.name,
        "files": files,
        "downloadSpeed": t.download_bps,
        "uploadSpeed": 0,
        "downloaded": t.progress_bytes,
        "uploaded": 0,
        "peers": t.peers_live,
        "unchoked": t.peers_live,
        "queued": t.peers_connecting,
        "unique": t.peers_seen,
        "connectionTries": t.peers_seen,
        "swarmPaused": t.state == "paused",
        "swarmConnections": t.peers_live,
        "swarmSize": t.peers_seen,
        "peerSearchRunning": t.state == "resolving",
        "sources": [],
        "opts": {},
        "guessedFileIdx": t.selected_file,
    });
    if let Some(f) = file.or(t.selected_file).and_then(|i| t.files.get(i)) {
        v["streamLen"] = json!(f.size);
        v["streamName"] = json!(f.name.rsplit('/').next().unwrap_or(&f.name));
        v["streamProgress"] = json!(if f.size > 0 { f.progress_bytes as f64 / f.size as f64 } else { 0.0 });
    }
    v
}

/// Starts `hex` for the compat session (sources passed through), if it does not hold it yet.
async fn ensure_started(st: &Arc<AppState>, eng: &Arc<EngineParts>, hex: &str, sources: Vec<String>, file: Option<usize>) -> ApiResult<()> {
    let s = session(st);
    if s.holds(hex) && sources.is_empty() {
        return Ok(());
    }
    // `create` does not take a stream slot (the media GET does): like a prewarm, but focused.
    let mut args = json!({ "infoHash": hex, "sources": sources });
    if let Some(f) = file {
        args["fileIdx"] = json!(f);
    }
    let mut req: huwa_torrent_core::engine::StartStreamRequest = serde_json::from_value(args).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let (engine, parts) = (eng.engine.clone(), eng.clone());
    engine_api::blocking(move || {
        req.sources = parts.filter_sources(std::mem::take(&mut req.sources));
        Ok(engine.start_stream_for(req, COMPAT_SESSION)?)
    })
    .await?;
    st.sessions.hold(&s, hex);
    Ok(())
}

async fn wait_files(eng: &EngineParts, hex: &str) -> Option<huwa_torrent_core::engine::TorrentStatus> {
    let deadline = tokio::time::Instant::now() + CREATE_META_WAIT;
    loop {
        if let Ok(s) = eng.engine.status(hex) {
            if !s.files.is_empty() {
                return Some(s);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// `.torrent` bytes → info hash, registered with the engine's metadata cache.
fn add_blob(eng: &EngineParts, blob_hex: &str) -> ApiResult<(String, Vec<String>)> {
    let bytes = hex::decode(blob_hex.trim()).map_err(|_| ApiError::bad_request("`blob` must be the .torrent file in hex"))?;
    let t = librqbit::torrent_from_bytes(&bytes).map_err(|e| ApiError::bad_request(format!("invalid torrent: {e}")))?;
    let hex = t.info_hash.as_string().to_lowercase();
    let trackers: Vec<String> = t.iter_announce().filter_map(|a| std::str::from_utf8(a.as_ref()).ok()).map(|u| format!("tracker:{u}")).collect();
    let info = t.info.data.validate().map_err(|e| ApiError::bad_request(format!("invalid torrent: {e}")))?;
    let files: Vec<(String, u64)> = info.iter_file_details().map(|f| (f.filename.to_pathbuf().to_string_lossy().into_owned(), f.len)).collect();
    eng.engine
        .meta_cache
        .insert(&hex, huwa_torrent_core::probe::CachedMeta::new(bytes::Bytes::from(bytes.clone()), files, Vec::new(), std::time::Instant::now()));
    Ok((hex, trackers))
}

async fn create_inner(st: Arc<AppState>, path_hash: Option<String>, body: Bytes) -> ApiResult<Response> {
    let eng = parts(&st)?;
    let v: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(format!("invalid json: {e}")))? };
    let (hex, mut sources) = if let Some(blob) = v.get("blob").and_then(Value::as_str) {
        add_blob(&eng, blob)?
    } else {
        let h = v.pointer("/torrent/infoHash").and_then(Value::as_str).map(str::to_string).or(path_hash.clone()).ok_or_else(|| ApiError::bad_request("missing torrent.infoHash"))?;
        let (_, hex) = huwa_torrent_core::engine::normalize_hash(&h).map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
        (hex, Vec::new())
    };
    if let Some(p) = &path_hash {
        if !p.eq_ignore_ascii_case(&hex) {
            return Err(ApiError::bad_request("the path info hash does not match the torrent"));
        }
    }
    if let Some(src) = v.pointer("/peerSearch/sources").and_then(Value::as_array) {
        sources.extend(src.iter().filter_map(Value::as_str).map(str::to_string));
    }
    ensure_started(&st, &eng, &hex, sources, None).await?;
    let status = wait_files(&eng, &hex).await;
    let mut out = json!({ "infoHash": hex });
    if let Some(s) = &status {
        let files: Vec<(String, u64)> = s.files.iter().map(|f| (f.name.clone(), f.size)).collect();
        let episode = v.pointer("/guessFileIdx/episode").and_then(Value::as_u64).map(|e| e as u32);
        let guessed = match v.get("guessFileIdx") {
            Some(Value::Bool(false)) | None => None,
            _ => match huwa_torrent_core::probe::pick_probe_file(&files, None, None, episode) {
                huwa_torrent_core::probe::FilePick::File(i) => Some(i),
                _ => huwa_torrent_core::engine::pick_file(&files),
            },
        };
        out = stremio_stats(s, guessed);
        out["guessedFileIdx"] = json!(guessed.or(s.selected_file));
    }
    Ok(Json(out).into_response())
}

pub async fn create_root(State(st): State<Arc<AppState>>, body: Bytes) -> ApiResult<Response> {
    create_inner(st, None, body).await
}

pub async fn create_hash(State(st): State<Arc<AppState>>, Path(hash): Path<String>, body: Bytes) -> ApiResult<Response> {
    create_inner(st, Some(hash), body).await
}

pub async fn stats_all(State(st): State<Arc<AppState>>) -> ApiResult<Response> {
    let eng = parts(&st)?;
    let held = session(&st).torrents.lock().clone();
    let mut out = serde_json::Map::new();
    for t in eng.engine.list().into_iter().filter(|t| held.contains(&t.info_hash)) {
        out.insert(t.info_hash.clone(), stremio_stats(&t, None));
    }
    Ok(Json(Value::Object(out)).into_response())
}

async fn stats_of(st: &Arc<AppState>, hash: &str, file: Option<usize>) -> ApiResult<Response> {
    let eng = parts(st)?;
    let (_, hex) = huwa_torrent_core::engine::normalize_hash(hash).map_err(|_| ApiError::not_found("unknown torrent"))?;
    if !session(st).holds(&hex) {
        return Ok(Json(Value::Null).into_response());
    }
    Ok(match eng.engine.status(&hex) {
        Ok(t) => Json(stremio_stats(&t, file)).into_response(),
        Err(_) => Json(Value::Null).into_response(),
    })
}

/// `GET /{a}/{b}`: `/{infoHash}/{fileIdx}` (stream) or `/{infoHash}/stats.json`; anything else
/// is the web app (`/assets/x.png`, SPA routes).
pub async fn two_segments(State(st): State<Arc<AppState>>, Path((a, b)): Path<(String, String)>, RawQuery(q): RawQuery, headers: HeaderMap, req: Request<Body>) -> Response {
    if !(st.cfg.stremio_compat && st.eng.is_some() && is_hash(&a)) {
        return crate::web::serve_static(st, req).await;
    }
    if b == "stats.json" {
        return stats_of(&st, &a, None).await.into_response();
    }
    if b == "create" {
        return crate::web::serve_static(st, req).await;
    }
    stream(st, a, b, q, headers).await.into_response()
}

pub async fn file_stats(State(st): State<Arc<AppState>>, Path((a, b)): Path<(String, String)>, req: Request<Body>) -> Response {
    if !(st.cfg.stremio_compat && st.eng.is_some() && is_hash(&a)) {
        return crate::web::serve_static(st, req).await;
    }
    let idx = b.parse::<i64>().ok().filter(|i| *i >= 0).map(|i| i as usize);
    stats_of(&st, &a, idx).await.into_response()
}

async fn stream(st: Arc<AppState>, hash: String, idx: String, q: Option<String>, headers: HeaderMap) -> ApiResult<Response> {
    let eng = parts(&st)?;
    let (_, hex) = huwa_torrent_core::engine::normalize_hash(&hash).map_err(|_| ApiError::not_found("unknown torrent"))?;
    let n: i64 = idx.split('.').next().unwrap_or("").parse().map_err(|_| ApiError::not_found("bad file index"))?;
    let file = (n >= 0).then_some(n as usize);
    let sources: Vec<String> = query_pairs(q.as_deref()).into_iter().filter(|(k, _)| k == "tr").map(|(_, v)| v).collect();
    let s = session(&st);
    if !s.holds(&hex) {
        ensure_started(&st, &eng, &hex, sources, file).await?;
    }
    if let Err(e) = s.claim_slot(&hex, st.cfg.compat_streams) {
        inc(&st.metrics.quota_refusals);
        return Err(e);
    }
    let guard = s.open_stream(&hex);
    let seg = file.map_or("auto".to_string(), |f| f.to_string());
    // A Stremio-protocol client reads with several players at once (see `serve_file_shared`).
    let resp = huwa_torrent_core::server::serve_file_shared(eng.engine.clone(), &hex, &seg, &headers).await;
    Ok(media_headers(engine_api::guarded_body(resp, guard)))
}

// ------------------------------------------------------------------------------------------------
// HLS (stremio-video `withStreamingServer`)
// ------------------------------------------------------------------------------------------------

/// `mediaURL` → a source the compat session holds. Local URLs (this server's `/{hash}/{idx}` or
/// `/s/…/t/…`) map to the torrent; anything else goes through the HTTP proxy (upstream policy):
/// ffmpeg only ever reads the internal listener.
async fn source_for(st: &Arc<AppState>, eng: &Arc<EngineParts>, media_url: &str) -> ApiResult<Source> {
    if let Some(Source::Torrent { hex, file }) = media::source_of_url(media_url) {
        ensure_started(st, eng, &hex, Vec::new(), file).await?;
        return Ok(Source::Torrent { hex, file });
    }
    let u = url::Url::parse(media_url).map_err(|_| ApiError::bad_request("mediaURL must be an absolute http(s) URL"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(ApiError::bad_request("mediaURL must be http(s)"));
    }
    let s = session(st);
    let proxy = eng.proxy.clone();
    let args = json!({ "url": media_url });
    let v = engine_api::blocking(move || proxy.dispatch("httpOpen", args)).await?;
    let id = v.get("id").and_then(Value::as_u64).ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "upstream_unsupported", "the upstream does not support range requests"))?;
    *s.http.lock().entry(id).or_default() += 1;
    Ok(Source::Http { id })
}

fn media_url_of(q: &[(String, String)]) -> ApiResult<String> {
    q.iter().find(|(k, _)| k == "mediaURL").map(|(_, v)| v.clone()).ok_or_else(|| ApiError::bad_request("missing mediaURL"))
}

pub async fn hls_probe(State(st): State<Arc<AppState>>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let eng = parts(&st)?;
    let media = st.media.clone().ok_or_else(|| ApiError::not_found("no such route"))?;
    let q = query_pairs(q.as_deref());
    let source = source_for(&st, &eng, &media_url_of(&q)?).await?;
    let s = session(&st);
    let ms = media.open(&st, &eng, &s, source).await?;
    let streams: Vec<Value> = ms
        .info
        .streams
        .iter()
        .filter(|x| !x.attached_pic && x.kind != Kind::Data)
        .map(|x| {
            let mut v = json!({
                "id": x.index,
                "track": x.kind,
                "codec": x.codec,
            });
            if let Some(c) = x.channels {
                v["channels"] = json!(c);
            }
            if let Some(f) = x.frame_rate {
                v["frameRate"] = json!(f);
            }
            if let Some(m) = &x.mimetype {
                v["mimeType"] = json!(m);
            }
            if let Some(f) = &x.filename {
                v["filename"] = json!(f);
            }
            if let Some(l) = &x.language {
                v["language"] = json!(l);
            }
            v
        })
        .collect();
    let name = ms.info.container.clone();
    Ok(Json(json!({ "format": { "name": name, "duration": ms.info.duration }, "streams": streams })).into_response())
}

fn valid_cid(c: &str) -> bool {
    !c.is_empty() && c.len() <= 64 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub async fn hls_master(State(st): State<Arc<AppState>>, Path((cid, file)): Path<(String, String)>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let eng = parts(&st)?;
    let media = st.media.clone().ok_or_else(|| ApiError::not_found("no such route"))?;
    if file != "master.m3u8" || !valid_cid(&cid) {
        return Err(ApiError::not_found("no such file"));
    }
    let pairs = query_pairs(q.as_deref());
    let s = session(&st);
    let known = st.compat.hls.lock().get(&cid).cloned().and_then(|m| media.get(&m));
    let ms = match known {
        Some(ms) => ms,
        None => {
            let source = source_for(&st, &eng, &media_url_of(&pairs)?).await?;
            let ms = media.open(&st, &eng, &s, source).await?;
            st.compat.hls.lock().insert(cid.clone(), ms.id.clone());
            ms
        }
    };
    media::master(&st, &media, &s, &ms, &ClientCaps::from_query(&pairs))
}

pub async fn hls_file(State(st): State<Arc<AppState>>, Path((cid, variant, file)): Path<(String, String, String)>) -> ApiResult<Response> {
    parts(&st)?;
    let media = st.media.clone().ok_or_else(|| ApiError::not_found("no such route"))?;
    let mid = st.compat.hls.lock().get(&cid).cloned().ok_or_else(|| ApiError::not_found("unknown hls id"))?;
    let ms = media.get(&mid).ok_or_else(|| ApiError::not_found("unknown hls id"))?;
    let s = session(&st);
    if variant == "subtitles" || variant == "subtitle" {
        return media::subs_response(&media, &ms, &file, 0.0);
    }
    media::variant_file(&st, &media, &s, &ms, &variant, &file).await
}

// ------------------------------------------------------------------------------------------------
// Subtitles
// ------------------------------------------------------------------------------------------------

/// Largest subtitle file fetched for `/subtitles.vtt`.
const MAX_SUBTITLE_BYTES: usize = 8 * 1024 * 1024;

pub async fn subtitles_vtt(State(st): State<Arc<AppState>>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let eng = parts(&st)?;
    let pairs = query_pairs(q.as_deref());
    let from = pairs.iter().find(|(k, _)| k == "from").map(|(_, v)| v.clone()).ok_or_else(|| ApiError::bad_request("missing from"))?;
    let u = url::Url::parse(&from).map_err(|_| ApiError::bad_request("from must be an absolute http(s) URL"))?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some() {
        return Err(ApiError::bad_request("from must be an http(s) URL without credentials"));
    }
    // The server fetches it: same upstream IP policy as the proxy (DNS resolver + redirects).
    let (guard, checked) = (eng.guard.clone(), u.clone());
    tokio::task::spawn_blocking(move || guard.precheck(&checked))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|b| ApiError::engine(anyhow::Error::new(b)))?;
    let client = eng.guard.apply(reqwest::Client::builder().timeout(Duration::from_secs(15)).no_proxy(), 5).build().map_err(|e| ApiError::internal(e.to_string()))?;
    let resp = client.get(u).send().await.map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, "upstream_error", format!("{e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "upstream_error", format!("upstream answered {}", resp.status())));
    }
    if resp.content_length().is_some_and(|l| l as usize > MAX_SUBTITLE_BYTES) {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "subtitle file too large"));
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    use futures::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, "upstream_error", e.to_string()))?;
        body.extend_from_slice(&chunk);
        if body.len() > MAX_SUBTITLE_BYTES {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "subtitle file too large"));
        }
    }
    let text = String::from_utf8_lossy(&body);
    let vtt = if text.contains("[Script Info]") || text.contains("Dialogue:") {
        media::subs::to_vtt(&media::subs::parse_ass(&text).1)
    } else {
        media::subs::srt_to_vtt(&text)
    };
    let mut r = (StatusCode::OK, vtt).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/vtt; charset=utf-8"));
    Ok(r)
}

impl Compat {
    /// Forgets compat HLS ids whose media session was closed.
    pub fn sweep(&self, media: &media::Media) {
        self.hls.lock().retain(|_, m| media.get(m).is_some());
    }
}
