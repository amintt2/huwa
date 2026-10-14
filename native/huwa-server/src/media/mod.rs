//! Media module (D13 / D14): ffprobe, direct / remux / transcode decision, fMP4 HLS, subtitle
//! sidecars and MKV fonts. Every ffmpeg / ffprobe input is the internal loopback listener of the
//! torrent or HTTP proxy session the browser session holds (`EngineParts::internal_*_url`).
//!
//! Routes (docs/server-api.md §12):
//! - `POST /api/v1/media/probe` (Bearer) `{url} | {infoHash, fileIdx?} | {httpId}` + caps query
//! - `GET /s/{token}/hls/{media}/master.m3u8?videoCodecs=…&audioCodecs=…&maxAudioChannels=…`
//! - `GET /s/{token}/hls/{media}/{variant}/index.m3u8 | init.mp4 | {n}.m4s`
//! - `GET /s/{token}/subs/{media}/{track}.vtt|.ass?since=<s>`
//! - `GET /s/{token}/fonts/{media}` (list), `/s/{token}/fonts/{media}/{n}` (file)

pub mod decide;
pub mod hls;
pub mod hwaccel;
pub mod mkv;
pub mod probe;
pub mod subs;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::anyhow;
use axum::{
    body::{Body, Bytes},
    extract::{Path, RawQuery, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use tracing::{info, warn};

use self::{
    decide::{decide, ClientCaps, Mode, Plan},
    hls::{Launch, Variant, WaitError},
    hwaccel::Encoder,
    probe::{Kind, MediaInfo},
    subs::Subs,
};
use crate::{
    engine_api::{media_headers, no_store, EngineParts},
    error::{ApiError, ApiResult},
    metrics::inc,
    sessions::{random_hex, Session},
    AppState,
};

/// A media session nobody used for this long is closed.
pub const MEDIA_IDLE: Duration = Duration::from_secs(30 * 60);
/// Subtitle extraction stops after this long without a request.
pub const SUBS_IDLE: Duration = Duration::from_secs(5 * 60);
/// ffprobe results are reused this long (same torrent file or proxy session).
pub const PROBE_CACHE: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Torrent { hex: String, file: Option<usize> },
    Http { id: u64 },
}

impl Source {
    /// Stream slot of the source (quota).
    pub fn slot_key(&self) -> String {
        match self {
            Source::Torrent { hex, .. } => hex.clone(),
            Source::Http { id } => format!("http:{id}"),
        }
    }

    fn cache_key(&self) -> String {
        match self {
            Source::Torrent { hex, file } => format!("t:{hex}:{}", file.map_or("auto".to_string(), |f| f.to_string())),
            Source::Http { id } => format!("h:{id}"),
        }
    }

    fn json(&self) -> Value {
        match self {
            Source::Torrent { hex, file } => json!({ "kind": "torrent", "infoHash": hex, "fileIdx": file }),
            Source::Http { id } => json!({ "kind": "http", "id": id }),
        }
    }

    /// The session holds what this source reads.
    pub fn owned_by(&self, s: &Session) -> bool {
        match self {
            Source::Torrent { hex, .. } => s.holds(hex),
            Source::Http { id } => s.owns_http(*id),
        }
    }
}

pub struct MediaSession {
    pub id: String,
    pub owner: String,
    pub source: Source,
    pub input: String,
    pub info: MediaInfo,
    pub keyframes: Option<Vec<f64>>,
    pub dir: PathBuf,
    variants: Mutex<HashMap<String, Arc<Variant>>>,
    subs: Mutex<Option<Arc<Subs>>>,
    fonts: tokio::sync::Mutex<Option<Vec<Option<PathBuf>>>>,
    last_access: AtomicU64,
}

impl MediaSession {
    fn touch(&self) {
        self.last_access.store(hls::now_ms(), Ordering::Relaxed);
    }

    fn idle_for(&self) -> Duration {
        let variants = self.variants.lock().values().map(|v| v.last_access.load(Ordering::Relaxed)).max().unwrap_or(0);
        let subs = self.subs.lock().as_ref().map_or(0, |s| s.last_access.load(Ordering::Relaxed));
        let last = self.last_access.load(Ordering::Relaxed).max(variants).max(subs);
        Duration::from_millis(hls::now_ms().saturating_sub(last))
    }

    pub fn stop(&self) {
        for v in self.variants.lock().values() {
            v.stop(true);
        }
        if let Some(s) = self.subs.lock().take() {
            s.stop();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    pub fn variant(&self, key: &str) -> Option<Arc<Variant>> {
        self.variants.lock().get(key).cloned()
    }

    pub fn has_index(&self) -> bool {
        self.keyframes.is_some()
    }
}

pub struct Media {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub root: PathBuf,
    pub encoder: RwLock<Encoder>,
    sessions: RwLock<HashMap<String, Arc<MediaSession>>>,
    cache: Mutex<HashMap<String, (Instant, MediaInfo, Option<Vec<f64>>)>>,
    pub transcodes_max: usize,
    pub transcodes_per_session: usize,
    http: reqwest::Client,
}

impl Media {
    pub fn new(cfg: &crate::ServerConfig) -> anyhow::Result<Media> {
        let root = cfg.hls_dir();
        // Leftovers of a previous process are useless (run ids restart).
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root)?;
        Ok(Media {
            ffmpeg: cfg.ffmpeg.clone(),
            ffprobe: cfg.ffprobe.clone(),
            root,
            encoder: RwLock::new(Encoder::Software),
            sessions: Default::default(),
            cache: Default::default(),
            transcodes_max: cfg.transcodes_max,
            transcodes_per_session: cfg.transcodes_per_session,
            http: reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(120)).build()?,
        })
    }

    pub fn get(&self, id: &str) -> Option<Arc<MediaSession>> {
        self.sessions.read().get(id).cloned()
    }

    /// Running ffmpeg HLS jobs and, among them, video transcodes.
    pub fn running(&self) -> (usize, usize) {
        let (mut jobs, mut tc) = (0, 0);
        for ms in self.sessions.read().values() {
            for v in ms.variants.lock().values() {
                if v.running() {
                    jobs += 1;
                    if v.is_transcode() {
                        tc += 1;
                    }
                }
            }
        }
        (jobs, tc)
    }

    /// Room for one more transcode for `owner` (the variants of `except` do not count: a
    /// restart replaces its own job).
    pub fn transcode_room(&self, owner: &str, except: &str) -> Result<(), ApiError> {
        let (mut total, mut mine) = (0, 0);
        for ms in self.sessions.read().values() {
            if ms.id == except {
                continue;
            }
            for v in ms.variants.lock().values() {
                if v.is_transcode() && v.running() {
                    total += 1;
                    if ms.owner == owner {
                        mine += 1;
                    }
                }
            }
        }
        if self.transcodes_per_session > 0 && mine >= self.transcodes_per_session {
            return Err(ApiError::transcode_quota(self.transcodes_per_session, "session"));
        }
        if self.transcodes_max > 0 && total >= self.transcodes_max {
            return Err(ApiError::transcode_quota(self.transcodes_max, "server"));
        }
        Ok(())
    }

    async fn read_range(&self, url: &str, start: u64, end: u64) -> anyhow::Result<Vec<u8>> {
        if end <= start {
            return Ok(Vec::new());
        }
        let r = self.http.get(url).header("range", format!("bytes={start}-{}", end - 1)).send().await?;
        if !r.status().is_success() {
            return Err(anyhow!("range read: HTTP {}", r.status()));
        }
        Ok(r.bytes().await?.to_vec())
    }

    async fn keyframes(&self, url: &str, len: u64) -> Option<Vec<f64>> {
        let read = |s: u64, e: u64| -> mkv::ReadFut<'_> { Box::pin(self.read_range(url, s, e)) };
        match tokio::time::timeout(Duration::from_secs(90), mkv::keyframes(&read, len)).await {
            Ok(Ok(k)) => k,
            Ok(Err(e)) => {
                warn!("reading the Cues failed: {e:#}");
                None
            }
            Err(_) => {
                warn!("reading the Cues timed out");
                None
            }
        }
    }

    /// The media session of `session` for `source` (reused, or probed now).
    pub async fn open(&self, st: &AppState, eng: &EngineParts, session: &Session, mut source: Source) -> ApiResult<Arc<MediaSession>> {
        if let Some(ms) = self.sessions.read().values().find(|m| m.owner == session.id && (m.source == source || matches!((&source, &m.source), (Source::Torrent { hex: a, file: None }, Source::Torrent { hex: b, .. }) if a == b))).cloned() {
            ms.touch();
            return Ok(ms);
        }
        let input_for = |s: &Source| match s {
            Source::Torrent { hex, file } => eng.internal_torrent_url(hex, *file),
            Source::Http { id } => eng.internal_http_url(*id),
        };
        let cached = {
            let mut c = self.cache.lock();
            c.retain(|_, (at, ..)| at.elapsed() < PROBE_CACHE);
            c.get(&source.cache_key()).map(|(_, i, k)| (i.clone(), k.clone()))
        };
        let (info, keyframes) = match cached {
            Some(x) => x,
            None => {
                inc(&st.metrics.media_probes);
                let input = input_for(&source);
                let info = probe::run(&self.ffprobe, &input).await.map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, "probe_failed", format!("{e:#}")))?;
                let keyframes = if info.is_matroska() {
                    match info.size {
                        Some(len) if len > 0 => self.keyframes(&input, len).await,
                        _ => None,
                    }
                } else {
                    None
                };
                self.cache.lock().insert(source.cache_key(), (Instant::now(), info.clone(), keyframes.clone()));
                (info, keyframes)
            }
        };
        // `auto`: the engine picked the file by now (ffprobe read it).
        if let Source::Torrent { hex, file: None } = &source {
            if let Ok(s) = eng.engine.status(hex) {
                if let Some(f) = s.selected_file {
                    source = Source::Torrent { hex: hex.clone(), file: Some(f) };
                }
            }
        }
        let id = random_hex::<16>();
        let ms = Arc::new(MediaSession {
            dir: self.root.join(&id),
            id: id.clone(),
            owner: session.id.clone(),
            input: input_for(&source),
            source,
            info,
            keyframes,
            variants: Default::default(),
            subs: Default::default(),
            fonts: Default::default(),
            last_access: AtomicU64::new(hls::now_ms()),
        });
        self.sessions.write().insert(id.clone(), ms.clone());
        session.media.lock().insert(id);
        Ok(ms)
    }

    /// The variant of `ms` for `plan` (one live variant per media: others are stopped).
    pub fn variant_for(&self, ms: &MediaSession, plan: Plan, start: Option<f64>) -> Arc<Variant> {
        let key = plan.key();
        let mut vs = ms.variants.lock();
        if let Some(v) = vs.get(&key) {
            return v.clone();
        }
        for other in vs.values() {
            other.stop(false);
        }
        let segments = match (&plan.mode, &ms.keyframes) {
            (Mode::Remux, Some(k)) | (Mode::Direct, Some(k)) => mkv::copy_segments(k, ms.info.duration, hls::SEGMENT_SECS),
            _ => mkv::grid_segments(ms.info.duration, hls::SEGMENT_SECS),
        };
        let v = Arc::new(Variant::new(key.clone(), plan, segments, ms.dir.join(&key), ms.input.clone(), ms.owner.clone(), start));
        vs.insert(key, v.clone());
        v
    }

    pub fn launch(&self, ms: &MediaSession) -> Launch {
        Launch { ffmpeg: self.ffmpeg.clone(), encoder: *self.encoder.read(), video_height: ms.info.main_video().and_then(|v| v.height) }
    }

    /// Janitor pass: idle variants stopped (files deleted), idle subtitle runs stopped, idle or
    /// orphaned media sessions closed.
    pub fn sweep(&self, alive: &dyn Fn(&str) -> bool) {
        let all: Vec<Arc<MediaSession>> = self.sessions.read().values().cloned().collect();
        for ms in all {
            if !alive(&ms.owner) || ms.idle_for() >= MEDIA_IDLE {
                info!(media = %ms.id, "media session closed");
                ms.stop();
                self.sessions.write().remove(&ms.id);
                continue;
            }
            for v in ms.variants.lock().values() {
                if v.idle_for() >= hls::IDLE && (v.running() || v.dir.exists()) {
                    info!(media = %ms.id, variant = %v.key, "idle hls variant stopped");
                    v.stop(true);
                }
            }
            let idle_subs = ms.subs.lock().as_ref().is_some_and(|s| s.idle_for() >= SUBS_IDLE);
            if idle_subs {
                if let Some(s) = ms.subs.lock().take() {
                    s.stop();
                }
            }
        }
    }

    pub fn shutdown(&self) {
        for ms in self.sessions.write().drain().map(|(_, v)| v) {
            ms.stop();
        }
    }

    /// Text subtitle tracks of `ms` (sidecar extractor created on first use).
    fn subs_of(&self, ms: &MediaSession) -> Option<Arc<Subs>> {
        let mut s = ms.subs.lock();
        if s.is_none() {
            let tracks: Vec<(usize, usize)> = ms.info.of_kind(Kind::Subtitle).filter(|t| t.is_text_subtitle()).map(|t| (t.track, t.index)).collect();
            if tracks.is_empty() {
                return None;
            }
            let pacer = ms.info.of_kind(Kind::Audio).next().or_else(|| ms.info.main_video()).map(|x| x.index);
            *s = Some(Arc::new(Subs::new(tracks, pacer, ms.info.duration, ms.dir.join("subs"), ms.input.clone(), self.ffmpeg.clone())));
        }
        s.clone()
    }

    /// Extracts the attachments (fonts) once; `None` entries could not be dumped.
    async fn fonts_of(&self, ms: &MediaSession) -> Vec<Option<PathBuf>> {
        let mut f = ms.fonts.lock().await;
        if let Some(v) = f.as_ref() {
            return v.clone();
        }
        let atts: Vec<_> = ms.info.of_kind(Kind::Attachment).cloned().collect();
        let dir = ms.dir.join("fonts");
        let _ = std::fs::create_dir_all(&dir);
        let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "http,tcp", "-rw_timeout", "60000000"].map(String::from).to_vec();
        for a in &atts {
            // Explicit output names: the attachment's own filename is never used as a path.
            args.extend([format!("-dump_attachment:{}", a.index), dir.join(format!("{}.bin", a.track)).display().to_string()]);
        }
        args.extend(["-i".to_string(), ms.input.clone(), "-t".into(), "0".into(), "-f".into(), "null".into(), "-".into()]);
        let run = tokio::process::Command::new(&self.ffmpeg).args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).status();
        let _ = tokio::time::timeout(Duration::from_secs(120), run).await;
        let out: Vec<Option<PathBuf>> = atts.iter().map(|a| Some(dir.join(format!("{}.bin", a.track))).filter(|p| p.exists())).collect();
        *f = Some(out.clone());
        out
    }
}

// ------------------------------------------------------------------------------------------------
// Probe API
// ------------------------------------------------------------------------------------------------

pub fn query_pairs(q: Option<&str>) -> Vec<(String, String)> {
    q.map(|q| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()).unwrap_or_default()
}

/// A media URL of this server (absolute or relative) → its source.
pub fn source_of_url(u: &str) -> Option<Source> {
    let path = match url::Url::parse(u) {
        Ok(p) => p.path().to_string(),
        Err(_) => u.split(['?', '#']).next()?.to_string(),
    };
    let seg: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match seg.as_slice() {
        ["s", _, "t", hash, file] => {
            let (_, hex) = huwa_torrent_core::engine::normalize_hash(hash).ok()?;
            let file = huwa_torrent_core::server::parse_file(file)?;
            Some(Source::Torrent { hex, file })
        }
        ["s", _, "http", file] => Some(Source::Http { id: file.split('.').next()?.parse().ok()? }),
        // Stremio-compatible stream URL: `/{infoHash}/{fileIdx}`.
        [hash, idx] if hash.len() == 40 => {
            let (_, hex) = huwa_torrent_core::engine::normalize_hash(hash).ok()?;
            let i: i64 = idx.split('.').next()?.parse().ok()?;
            Some(Source::Torrent { hex, file: (i >= 0).then_some(i as usize) })
        }
        _ => None,
    }
}

fn source_of_body(v: &Value) -> ApiResult<Source> {
    if let Some(u) = v.get("url").and_then(Value::as_str) {
        return source_of_url(u).ok_or_else(|| ApiError::bad_request("`url` is not a media URL of this server"));
    }
    if let Some(h) = v.get("infoHash").and_then(Value::as_str) {
        let (_, hex) = huwa_torrent_core::engine::normalize_hash(h).map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
        let file = v.get("fileIdx").and_then(Value::as_u64).map(|f| f as usize);
        return Ok(Source::Torrent { hex, file });
    }
    if let Some(id) = v.get("httpId").and_then(Value::as_u64) {
        return Ok(Source::Http { id });
    }
    Err(ApiError::bad_request("give `url`, `infoHash` (+ `fileIdx`) or `httpId`"))
}

/// The media token prefix of `ms` for `session`: `{publicUrl}/s/{stream token}`.
pub fn media_prefix(st: &AppState, session: &Session, ms: &MediaSession) -> String {
    st.cfg.media_base(&st.sessions.stream_token(session, &format!("m-{}", ms.id)))
}

/// The probe document (shared with the Stremio-compatible `/hlsv2/probe`).
pub fn describe(st: &AppState, eng: &EngineParts, session: &Session, ms: &MediaSession, caps: &ClientCaps) -> Value {
    let base = media_prefix(st, session, ms);
    let plan = decide(&ms.info, caps, ms.has_index());
    let direct = match &ms.source {
        Source::Torrent { hex, file } => {
            let path = format!("/t/{hex}/{}", file.map_or("auto".to_string(), |f| f.to_string()));
            crate::engine_api::media_base_for(st, session, &path).map(|b| format!("{b}{path}"))
        }
        Source::Http { id } => {
            let path = format!("/http/{id}");
            crate::engine_api::media_base_for(st, session, &path).map(|b| format!("{b}{path}"))
        }
    };
    let _ = eng;
    let stream_json = |s: &probe::StreamInfo| serde_json::to_value(s).unwrap_or(Value::Null);
    let subtitles: Vec<Value> = ms
        .info
        .of_kind(Kind::Subtitle)
        .map(|s| {
            let mut v = stream_json(s);
            v["text"] = json!(s.is_text_subtitle());
            v["bitmap"] = json!(s.is_bitmap_subtitle());
            if s.is_text_subtitle() {
                v["url"] = json!(format!("{base}/subs/{}/{}.vtt", ms.id, s.track));
                v["assUrl"] = json!(format!("{base}/subs/{}/{}.ass", ms.id, s.track));
            }
            v
        })
        .collect();
    let attachments: Vec<Value> = ms
        .info
        .of_kind(Kind::Attachment)
        .map(|s| {
            let mut v = stream_json(s);
            v["url"] = json!(format!("{base}/fonts/{}/{}", ms.id, s.track));
            v
        })
        .collect();
    json!({
        "id": ms.id,
        "source": ms.source.json(),
        "container": ms.info.container,
        "duration": ms.info.duration,
        "bitRate": ms.info.bit_rate,
        "size": ms.info.size,
        "video": ms.info.of_kind(Kind::Video).filter(|v| !v.attached_pic).map(stream_json).collect::<Vec<_>>(),
        "audio": ms.info.of_kind(Kind::Audio).map(stream_json).collect::<Vec<_>>(),
        "subtitles": subtitles,
        "attachments": attachments,
        "keyframeIndex": if ms.has_index() { "cues" } else { "none" },
        "decision": plan,
        "direct": direct,
        "hls": format!("{base}/hls/{}/master.m3u8", ms.id),
        "fonts": format!("{base}/fonts/{}", ms.id),
    })
}

pub async fn probe_route(State(st): State<Arc<AppState>>, RawQuery(q): RawQuery, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let (Some(eng), Some(media)) = (st.eng.clone(), st.media.clone()) else { return Err(ApiError::not_found("no such route")) };
    let (_, session) = crate::auth(&st, &headers)?;
    let v: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(format!("invalid json: {e}")))? };
    let source = source_of_body(&v)?;
    if !source.owned_by(&session) {
        return Err(ApiError::not_found("unknown stream: start it first (startStream / httpOpen)"));
    }
    let ms = media.open(&st, &eng, &session, source).await?;
    let caps = ClientCaps::from_query(&query_pairs(q.as_deref()));
    Ok(no_store(Json(describe(&st, &eng, &session, &ms, &caps))))
}

// ------------------------------------------------------------------------------------------------
// HLS
// ------------------------------------------------------------------------------------------------

fn codecs_of(ms: &MediaSession, plan: &Plan) -> String {
    let video = plan.video.and_then(|i| ms.info.streams.iter().find(|s| s.index == i));
    let v = match (plan.mode, video) {
        (_, None) => None,
        (Mode::Transcode, Some(_)) => Some("avc1.64002a".to_string()),
        (_, Some(s)) => Some(match decide::norm_video(&s.codec).as_str() {
            "h264" => {
                let p = s.profile.as_deref().unwrap_or("High");
                let prof = if p.contains("Constrained Baseline") {
                    "42e0"
                } else if p.contains("Baseline") {
                    "4200"
                } else if p.contains("Main") {
                    "4d40"
                } else {
                    "6400"
                };
                format!("avc1.{prof}{:02x}", s.level.unwrap_or(41).clamp(10, 62))
            }
            "hevc" => {
                if s.bit_depth.unwrap_or(8) > 8 {
                    "hvc1.2.4.L150.90".into()
                } else {
                    "hvc1.1.6.L150.90".into()
                }
            }
            "av1" => "av01.0.08M.08".into(),
            "vp9" => "vp09.00.40.08".into(),
            other => other.to_string(),
        }),
    };
    let audio = plan.audio.and_then(|i| ms.info.streams.iter().find(|s| s.index == i));
    let a = audio.map(|s| {
        if !plan.audio_copy {
            return "mp4a.40.2".to_string();
        }
        match decide::norm_audio(&s.codec).as_str() {
            "aac" => "mp4a.40.2".into(),
            "mp3" => "mp4a.40.34".into(),
            "opus" => "opus".into(),
            "eac3" => "ec-3".into(),
            "ac3" => "ac-3".into(),
            "flac" => "fLaC".into(),
            o => o.to_string(),
        }
    });
    [v, a].into_iter().flatten().collect::<Vec<_>>().join(",")
}

fn master_playlist(ms: &MediaSession, v: &Variant) -> String {
    let video = v.plan.video.and_then(|i| ms.info.streams.iter().find(|s| s.index == i));
    let (w, h) = video.and_then(|s| Some((s.width?, s.height?))).unwrap_or((0, 0));
    let (w, h) = if v.plan.mode == Mode::Transcode && h > v.plan.max_height { ((w as u64 * v.plan.max_height as u64 / h as u64) as u32 & !1, v.plan.max_height) } else { (w, h) };
    let bandwidth = if v.plan.mode == Mode::Transcode {
        match h {
            0..=480 => 2_200_000,
            481..=720 => 5_300_000,
            _ => 9_400_000,
        }
    } else {
        ms.info.bit_rate.unwrap_or(8_000_000).max(500_000)
    };
    let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
    out.push_str(&format!("#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},CODECS=\"{}\"", codecs_of(ms, &v.plan)));
    if w > 0 && h > 0 {
        out.push_str(&format!(",RESOLUTION={w}x{h}"));
    }
    if let Some(fr) = video.and_then(|s| s.frame_rate) {
        out.push_str(&format!(",FRAME-RATE={fr:.3}"));
    }
    out.push_str(&format!("\n{}/index.m3u8\n", v.key));
    out
}

fn playlist_response(body: String) -> Response {
    let mut r = (StatusCode::OK, body).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/vnd.apple.mpegurl"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    media_headers(r)
}

fn wait_error(e: WaitError) -> ApiError {
    match e {
        WaitError::NotFound => ApiError::not_found("no such segment"),
        WaitError::Timeout => ApiError::unavailable("segment_not_ready", "the segment is not ready yet, retry"),
        WaitError::Failed(m) => ApiError::new(StatusCode::BAD_GATEWAY, "transcode_failed", m),
        WaitError::Quota(q) => q,
    }
}

/// `master.m3u8` for `session`'s media `ms` (shared with the Stremio-compatible routes).
pub fn master(st: &AppState, media: &Media, session: &Session, ms: &MediaSession, caps: &ClientCaps) -> ApiResult<Response> {
    ms.touch();
    if let Err(e) = session.claim_slot(&ms.source.slot_key(), st.cfg.streams_per_session) {
        inc(&st.metrics.quota_refusals);
        return Err(e);
    }
    let mut plan = decide(&ms.info, caps, ms.has_index());
    if plan.mode == Mode::Direct {
        // HLS asked for a file the browser could play directly: copy it into HLS anyway.
        plan.mode = if ms.has_index() && plan.video.is_some() { Mode::Remux } else { Mode::Transcode };
        if plan.mode == Mode::Transcode {
            plan.video_copy = false;
        }
    }
    if plan.mode == Mode::Transcode && !st.cfg.transcode {
        return Err(ApiError::new(StatusCode::CONFLICT, "transcode_disabled", "this server does not transcode"));
    }
    if plan.mode == Mode::Transcode && !ms.variant(&plan.key()).is_some_and(|v| v.running()) {
        if let Err(e) = media.transcode_room(&ms.owner, &ms.id) {
            inc(&st.metrics.quota_refusals);
            return Err(e);
        }
    }
    let v = media.variant_for(ms, plan, caps.start);
    v.touch();
    Ok(playlist_response(master_playlist(ms, &v)))
}

/// `index.m3u8`, `init.mp4`, `<n>.m4s` of a variant.
pub async fn variant_file(st: &AppState, media: &Media, session: &Arc<Session>, ms: &Arc<MediaSession>, variant: &str, file: &str) -> ApiResult<Response> {
    ms.touch();
    let v = ms.variant(variant).ok_or_else(|| ApiError::not_found("unknown variant: load master.m3u8 first"))?;
    let slot = ms.source.slot_key();
    if let Err(e) = session.claim_slot(&slot, st.cfg.streams_per_session) {
        inc(&st.metrics.quota_refusals);
        return Err(e);
    }
    let launch = media.launch(ms);
    let owner = ms.owner.clone();
    let mid = ms.id.clone();
    let quota = || media.transcode_room(&owner, &mid);
    if file == "index.m3u8" {
        v.touch();
        return Ok(playlist_response(v.playlist()));
    }
    let _guard = session.open_stream(&slot);
    let before = v.jobs_started.load(Ordering::Relaxed);
    let before_restarts = v.restarts.load(Ordering::Relaxed);
    let res = if file == "init.mp4" {
        v.init(&launch, &quota).await.map(|p| vec![p])
    } else {
        let n: usize = file.strip_suffix(".m4s").and_then(|n| n.parse().ok()).ok_or_else(|| ApiError::not_found("no such file"))?;
        let r = v.segment(n, &launch, &quota).await;
        if r.is_ok() {
            inc(&st.metrics.hls_segments_served);
        }
        r
    };
    st.metrics.hls_jobs_started.fetch_add(v.jobs_started.load(Ordering::Relaxed) - before, Ordering::Relaxed);
    st.metrics.hls_restarts.fetch_add(v.restarts.load(Ordering::Relaxed) - before_restarts, Ordering::Relaxed);
    let files = res.map_err(|e| {
        if matches!(e, WaitError::Failed(_)) {
            inc(&st.metrics.hls_job_failures);
        }
        if matches!(e, WaitError::Quota(_)) {
            inc(&st.metrics.quota_refusals);
        }
        wait_error(e)
    })?;
    let mut body = Vec::new();
    for f in files {
        body.extend(tokio::fs::read(&f).await.map_err(|e| ApiError::internal(format!("segment file: {e}")))?);
    }
    let mut r = Response::new(Body::from(body));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
    Ok(media_headers(r))
}

/// Resolves `/s/{token}/…/{media}`: the token (stream token for `m-<media>`, or the session's),
/// and the session's ownership of the media.
fn media_session(st: &AppState, token: &str, mid: &str) -> ApiResult<(Arc<Session>, Arc<MediaSession>)> {
    let media = st.media.as_ref().ok_or_else(|| ApiError::not_found("no such route"))?;
    let session = st.sessions.verify_media(token, &format!("m-{mid}"))?;
    let ms = media.get(mid).filter(|m| m.owner == session.id).ok_or_else(|| ApiError::not_found("unknown media"))?;
    Ok((session, ms))
}

pub async fn hls_master_route(State(st): State<Arc<AppState>>, Path((token, mid, file)): Path<(String, String, String)>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    if file != "master.m3u8" {
        return Err(ApiError::not_found("no such file"));
    }
    let (session, ms) = media_session(&st, &token, &mid)?;
    let media = st.media.clone().expect("checked");
    master(&st, &media, &session, &ms, &ClientCaps::from_query(&query_pairs(q.as_deref())))
}

pub async fn hls_file_route(State(st): State<Arc<AppState>>, Path((token, mid, variant, file)): Path<(String, String, String, String)>) -> ApiResult<Response> {
    let (session, ms) = media_session(&st, &token, &mid)?;
    let media = st.media.clone().expect("checked");
    variant_file(&st, &media, &session, &ms, &variant, &file).await
}

// ------------------------------------------------------------------------------------------------
// Subtitles and fonts
// ------------------------------------------------------------------------------------------------

pub fn subs_response(media: &Media, ms: &MediaSession, file: &str, since: f64) -> ApiResult<Response> {
    let (track, ass) = if let Some(t) = file.strip_suffix(".vtt") {
        (t, false)
    } else if let Some(t) = file.strip_suffix(".ass") {
        (t, true)
    } else {
        return Err(ApiError::not_found("use <track>.vtt or <track>.ass"));
    };
    let track: usize = track.parse().map_err(|_| ApiError::not_found("no such track"))?;
    let subs = media.subs_of(ms).ok_or_else(|| ApiError::not_found("no text subtitle track"))?;
    let a = subs.get(track, since.max(0.0), ass).map_err(|e| ApiError::internal(format!("subtitle extraction: {e:#}")))?.ok_or_else(|| ApiError::not_found("no such text subtitle track"))?;
    let mut r = (StatusCode::OK, a.body).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(if ass { "text/x-ssa; charset=utf-8" } else { "text/vtt; charset=utf-8" }));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&format!("{:.3}", a.until)) {
        h.insert("x-huwa-subs-until", v);
    }
    h.insert("x-huwa-subs-complete", HeaderValue::from_static(if a.complete { "1" } else { "0" }));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("x-huwa-subs-until, x-huwa-subs-complete"));
    Ok(media_headers(r))
}

pub async fn subs_route(State(st): State<Arc<AppState>>, Path((token, mid, file)): Path<(String, String, String)>, RawQuery(q): RawQuery) -> ApiResult<Response> {
    let (_, ms) = media_session(&st, &token, &mid)?;
    let media = st.media.clone().expect("checked");
    let since = query_pairs(q.as_deref()).into_iter().find(|(k, _)| k == "since").and_then(|(_, v)| v.parse::<f64>().ok()).unwrap_or(0.0);
    if media.subs_of(&ms).is_some() {
        inc(&st.metrics.subtitle_extractions);
    }
    subs_response(&media, &ms, &file, since)
}

fn font_type(name: Option<&str>, mime: Option<&str>) -> &'static str {
    let ext = name.and_then(|n| n.rsplit('.').next()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match (ext.as_str(), mime.unwrap_or("")) {
        ("otf", _) | (_, "application/vnd.ms-opentype") | (_, "font/otf") => "font/otf",
        ("ttc", _) | (_, "font/collection") => "font/collection",
        ("woff2", _) => "font/woff2",
        ("woff", _) => "font/woff",
        ("ttf", _) | (_, "application/x-truetype-font") | (_, "font/ttf") | (_, "application/x-font-ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}

pub async fn fonts_list_route(State(st): State<Arc<AppState>>, Path((token, mid)): Path<(String, String)>) -> ApiResult<Response> {
    let (session, ms) = media_session(&st, &token, &mid)?;
    let base = media_prefix(&st, &session, &ms);
    let list: Vec<Value> = ms
        .info
        .of_kind(Kind::Attachment)
        .map(|a| json!({ "track": a.track, "filename": a.filename, "mimetype": a.mimetype, "url": format!("{base}/fonts/{}/{}", ms.id, a.track) }))
        .collect();
    Ok(media_headers(no_store(Json(json!({ "fonts": list })))))
}

pub async fn font_route(State(st): State<Arc<AppState>>, Path((token, mid, n)): Path<(String, String, String)>) -> ApiResult<Response> {
    let (_, ms) = media_session(&st, &token, &mid)?;
    let media = st.media.clone().expect("checked");
    let n: usize = n.parse().map_err(|_| ApiError::not_found("no such font"))?;
    let att = ms.info.track(Kind::Attachment, n).cloned().ok_or_else(|| ApiError::not_found("no such font"))?;
    let files = media.fonts_of(&ms).await;
    let path = files.get(n).cloned().flatten().ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "extract_failed", "the attachment could not be extracted"))?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| ApiError::internal(e.to_string()))?;
    let mut r = Response::new(Body::from(bytes));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(font_type(att.filename.as_deref(), att.mimetype.as_deref())));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    if let Some(name) = att.filename.as_deref().filter(|n| n.is_ascii() && !n.contains(['"', '\\', '\r', '\n'])) {
        if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{name}\"")) {
            r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    Ok(media_headers(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_from_urls() {
        let h = "ab".repeat(20);
        assert_eq!(source_of_url(&format!("https://x.example/s/m1.tok/t/{h}/3.mkv")), Some(Source::Torrent { hex: h.clone(), file: Some(3) }));
        assert_eq!(source_of_url(&format!("/s/tok/t/{}/auto", h.to_uppercase())), Some(Source::Torrent { hex: h.clone(), file: None }));
        assert_eq!(source_of_url("/s/tok/http/12.mkv?x=1"), Some(Source::Http { id: 12 }));
        assert_eq!(source_of_url(&format!("http://127.0.0.1:11470/{h}/-1")), Some(Source::Torrent { hex: h.clone(), file: None }));
        assert_eq!(source_of_url("https://evil.example/video.mkv"), None);
        assert_eq!(font_type(Some("A.TTF"), None), "font/ttf");
        assert_eq!(font_type(Some("b"), Some("application/vnd.ms-opentype")), "font/otf");
    }
}
