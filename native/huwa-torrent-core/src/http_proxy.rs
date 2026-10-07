//! Loopback read-ahead proxy for remote HTTP streams (debrid, AIOStreams, direct links) played by
//! mpv: `GET http://127.0.0.1:<port>/http/<id>[.<ext>]` with `Range` → `206`.
//!
//! Why: mpv reads a file serially — the head, then the container index at the end (MKV Cues /
//! Tags, MP4 `moov`), then back to the first cluster or to the resume target — and pays the
//! server's time to first byte for each of those requests (plus a TCP / TLS handshake each, ffmpeg
//! opens a new connection per seek). Here, as soon as the source is opened:
//! - the head (open-ended for a start, 2 MiB for a resume), the tail (suffix range, 2 MiB) and,
//!   for a resume whose duration is known, the target (offset estimated from the bitrate) are
//!   requested **in parallel**;
//! - mpv's requests are served from those bytes, else forwarded upstream as range requests, with a
//!   bounded read-ahead in front of the playhead (`readAhead`, capped on metered networks);
//! - connections are reused (HTTP/1.1 keep-alive pool, one connection per range), the redirect
//!   target is remembered (a debrid "resolve" link redirects every request otherwise);
//! - a range that stops answering is asked again (`stall_after`) instead of mpv's network timeout.
//!
//! Fallbacks: a server without range support (`200` to a range request) gets a `302` to the
//! original URL (mpv then plays it directly, as without the proxy); `401/403/404/410/451` are
//! answered with the same status (mpv fails, the app's source controller moves on) and reported by
//! `httpStatus`. Memory is bounded (per segment read-ahead, session budget, session count, idle
//! TTL); nothing is written to disk.
//!
//! Privacy: URLs carry debrid tokens. They are never logged (`redact` keeps scheme + host), and
//! upstream errors are formatted without their URL.
//!
//! Independent from the torrent engine (`engine.rs`): its own small runtime and loopback listener,
//! started on the first `httpOpen`, so HTTP users never start the BitTorrent session (DHT…).
//!
//! JSON methods (through `huwa_torrent_call`, see `dispatch`):
//! - `httpOpen` `{url, headers?, prefetch?: {startAt?, duration?, readAhead?, target?}}` →
//!   `{id, url, reused}` | `{fallback: "noRange" | "unsupported"}`. Without `prefetch` nothing is
//!   fetched until a request comes (header sniffs); the bytes read stay for the playback that
//!   follows (same URL and headers → same session).
//! - `httpPrefetch` `{id, startAt?, duration?, readAhead?, target?}` → `true`
//! - `httpRelease` `{id}` → `true` (every fetch stops at once; the head / tail already read are
//!   kept `IDLE_TTL` for a reopen)
//! - `httpStatus` `{id}` → `HttpStatus`

use std::{
    collections::{BTreeMap, HashMap},
    mem::ManuallyDrop,
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{Path, State as Ax},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;
use tracing::{debug, info, warn};

use crate::range::{parse_range, RangeSpec};

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;

/// Head fetched at open (pinned: never trimmed while the session lives).
pub const HEAD_BYTES: u64 = 2 * MIB;
/// Tail fetched at open (suffix range): an MP4 `moov` at the end (often 1–2 MB), or an unknown
/// container.
pub const TAIL_BYTES: u64 = 2 * MIB;
/// Tail of a Matroska / WebM file: Cues + Tags only (tens of KiB for an episode). Small, so it
/// lands with the head even on a slow link (2 MiB take 1 s at 2 MB/s).
pub const TAIL_MKV_BYTES: u64 = 512 * KIB;
/// Resume target fetched at open, before the read-ahead of a reader takes over.
pub const TARGET_BYTES: u64 = 2 * MIB;
/// The target starts this long before the resume position: mpv opens a resume on the keyframe at
/// or before it (`hr-seek=no`): up to one GOP earlier (10 s at most in common encodes, a scene cut
/// usually puts one within a few seconds). A reader landing further in waits for the bytes when
/// they come sooner than a new request would (`Reader::read`), else asks for them.
pub const TARGET_BACK_SECS: f64 = 5.0;
/// Read-ahead in front of a reader (`readAhead` overrides, clamped).
pub const DEFAULT_READ_AHEAD: u64 = 8 * MIB;
pub const MIN_READ_AHEAD: u64 = 512 * KIB;
pub const MAX_READ_AHEAD: u64 = 32 * MIB;
/// Bytes kept behind a reader (a small seek back is served from memory).
pub const BACK_KEEP: u64 = MIB;
/// A closed range request up to this size (header sniffs) is fetched as asked and pinned.
pub const BOUNDED_MAX: u64 = 4 * MIB;
/// A reader waits for a running fetch this far ahead of it instead of opening a new request
/// (at least; more when the fetch delivers more than this in one time to first byte).
pub const JOIN_MIN: u64 = 256 * KIB;
/// A bounded segment read up to this close to its end gets its continuation fetched.
pub const CONTINUE_MARGIN: u64 = MIB;
/// Memory per session (safety net: the read-ahead normally keeps it far below).
pub const SESSION_BUDGET: u64 = 48 * MIB;
/// Sessions alive at once (playing, warm for a seamless switch, sniffed): the oldest idle go first.
pub const MAX_SESSIONS: usize = 6;
pub const MAX_SEGMENTS: usize = 12;
/// A released session keeps what it read this long (a reopen of the same link reuses it).
pub const IDLE_TTL: Duration = Duration::from_secs(60);
/// Upstream: connect and response headers.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
/// A body read waiting this long (while not paused by the read-ahead) ends the fetch.
pub const BODY_STALL: Duration = Duration::from_secs(20);
/// Failed upstream requests in a row before the session reports an error.
pub const MAX_FAILURES: u32 = 4;
/// mpv's own default `user-agent`: what the server would have seen without the proxy.
pub const DEFAULT_UA: &str = "libmpv";

// ------------------------------------------------------------------------------------------------
// Privacy
// ------------------------------------------------------------------------------------------------

/// `scheme://host[:port]/…` — never the path or the query (debrid tokens live there).
pub fn redact(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("?");
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            let tail = if u.path().len() > 1 || u.query().is_some() { "/…" } else { "" };
            format!("{}://{host}{port}{tail}", u.scheme())
        }
        Err(_) => "<url>".into(),
    }
}

/// An upstream error, formatted without its URL.
fn net_error(e: reqwest::Error) -> String {
    let e = e.without_url();
    if e.is_timeout() {
        "délai dépassé".into()
    } else if e.is_connect() {
        format!("connexion impossible ({e})")
    } else {
        e.to_string()
    }
}

// ------------------------------------------------------------------------------------------------
// Requests and responses
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchRequest {
    /// Resume position (s). Above 1 s: head bounded to `HEAD_BYTES`, and the target if `duration`.
    #[serde(default)]
    pub start_at: Option<f64>,
    /// Duration of the video (s), when known: places the resume target.
    #[serde(default)]
    pub duration: Option<f64>,
    /// Read-ahead in front of a reader, bytes (metered networks pass less).
    #[serde(default)]
    pub read_ahead: Option<u64>,
    /// Fetch the resume target (a guess from the mean bitrate: off on metered networks).
    #[serde(default)]
    pub target: Option<bool>,
    /// File size when the addon gave it (Stremio `behaviorHints.videoSize`): the target leaves
    /// with the head and the tail instead of after the first answer.
    #[serde(default)]
    pub size: Option<u64>,
    /// Container when the caller knows it (`mkv`, `webm`, `mp4`…): sizes the tail. Else the URL's
    /// extension.
    #[serde(default)]
    pub container: Option<String>,
}

/// Bytes of the tail suffix for a container (see `TAIL_MKV_BYTES`).
pub fn tail_bytes_for(container: Option<&str>) -> u64 {
    match container.map(|c| c.to_ascii_lowercase()).as_deref() {
        Some("mkv" | "webm" | "mk3d") => TAIL_MKV_BYTES,
        _ => TAIL_BYTES,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub prefetch: Option<PrefetchRequest>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub reused: bool,
    /// Play the original URL directly: `noRange` (the server ignores Range), `unsupported`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpError {
    /// Upstream HTTP status (0: network error, timeout).
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpStatus {
    pub id: u64,
    pub host: String,
    pub length: Option<u64>,
    pub range_ok: bool,
    pub no_range: bool,
    pub error: Option<HttpError>,
    pub bytes_fetched: u64,
    pub bytes_served: u64,
    pub upstream_requests: u32,
    pub ttfb_ms: Option<u64>,
    pub segments: usize,
    pub retained_bytes: u64,
    pub refs: usize,
}

// ------------------------------------------------------------------------------------------------
// Session state
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Head,
    Tail,
    Target,
    /// MP4 `moov` before the tail (found in the head).
    Index,
    /// A closed range asked by a reader (header sniff), fetched as is.
    Bounded,
    /// A reader's position with nothing there: open-ended, read-ahead bounded.
    Play,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Head => "head",
            Kind::Tail => "tail",
            Kind::Target => "target",
            Kind::Index => "index",
            Kind::Bounded => "bounded",
            Kind::Play => "play",
        }
    }
}

struct Segment {
    id: u64,
    kind: Kind,
    /// First byte (None: a suffix request, known with the response or the length).
    start: Option<u64>,
    /// Exclusive end when bounded; None = to the end of the file.
    end: Option<u64>,
    /// Bytes received (`start + received` is the next byte expected).
    received: u64,
    chunks: BTreeMap<u64, Bytes>,
    retained: u64,
    /// `[start, start + pin)` is never trimmed.
    pin: u64,
    /// Furthest byte a reader asked for here (read-ahead and trimming are relative to it).
    demand: u64,
    /// A reader used this segment (the read-ahead runs from then on, the pin before).
    touched: bool,
    /// Open-ended with read-ahead (else fetched to its end at once).
    flow: bool,
    live: bool,
    hedged: bool,
    created: Instant,
    first_byte: Option<Instant>,
    last_progress: Instant,
    last_read: Instant,
    abort: Option<tokio::task::AbortHandle>,
}

impl Segment {
    fn next(&self) -> Option<u64> {
        self.start.map(|s| s + self.received)
    }

    /// Bytes at `pos` held here (up to the end of their chunk, at most `max`).
    fn slice(&self, pos: u64, max: u64) -> Option<Bytes> {
        let (at, b) = self.chunks.range(..=pos).next_back()?;
        let off = pos - at;
        if off >= b.len() as u64 {
            return None;
        }
        let n = (b.len() as u64 - off).min(max.max(1));
        Some(b.slice(off as usize..(off + n) as usize))
    }

    fn has(&self, pos: u64) -> bool {
        self.slice(pos, 1).is_some()
    }

    /// Still fetching, and `pos` is ahead in what it will deliver.
    fn will_cover(&self, pos: u64) -> bool {
        let Some(next) = self.next() else { return false };
        self.live && pos >= next && self.end.is_none_or(|e| pos < e)
    }

    /// Paused by the read-ahead when the next byte reaches this.
    fn allowance(&self, read_ahead: u64) -> u64 {
        let start = self.start.unwrap_or(0);
        let ahead = if self.touched { self.demand.saturating_sub(start) + read_ahead } else { 0 };
        start + self.pin.max(ahead)
    }

    fn insert(&mut self, chunk: Bytes) {
        let Some(at) = self.next() else { return };
        self.received += chunk.len() as u64;
        self.retained += chunk.len() as u64;
        self.chunks.insert(at, chunk);
    }

    /// Drops what lies more than `BACK_KEEP` behind the reader (never the pin).
    fn trim_behind(&mut self) {
        let Some(start) = self.start else { return };
        let cut = self.demand.saturating_sub(BACK_KEEP);
        let keep_from = start + self.pin;
        let drop: Vec<u64> = self
            .chunks
            .range(keep_from..)
            .take_while(|(at, b)| *at + b.len() as u64 <= cut)
            .map(|(at, _)| *at)
            .collect();
        for at in drop {
            if let Some(b) = self.chunks.remove(&at) {
                self.retained -= b.len() as u64;
            }
        }
    }

    /// Keeps only the pin.
    fn trim_to_pin(&mut self) {
        let Some(start) = self.start else { return };
        let keep_to = start + self.pin;
        let drop: Vec<u64> = self.chunks.range(..).filter(|(at, b)| *at + b.len() as u64 > keep_to).map(|(at, _)| *at).collect();
        for at in drop {
            if let Some(b) = self.chunks.remove(&at) {
                self.retained -= b.len() as u64;
                // The part of a chunk straddling the pin's end stays.
                if at < keep_to {
                    let kept = b.slice(..(keep_to - at) as usize);
                    self.retained += kept.len() as u64;
                    self.chunks.insert(at, kept);
                }
            }
        }
    }

    fn stop(&mut self) {
        self.live = false;
        if let Some(a) = self.abort.take() {
            a.abort();
        }
    }
}

#[derive(Default)]
struct State {
    len: Option<u64>,
    content_type: Option<String>,
    segments: Vec<Segment>,
    next_seg: u64,
    /// A `206` came back: the server honours Range.
    range_ok: bool,
    /// The server ignores Range: requests get a 302 to the original URL.
    no_range: bool,
    /// A `200` to the head request (`bytes=0-`): the body is the file from 0, range support still
    /// unknown (the tail's answer decides).
    head_200: bool,
    /// The suffix range (`bytes=-N`) was ignored (`200`): the tail is asked as `bytes=a-b`.
    suffix_ignored: bool,
    error: Option<HttpError>,
    failures: u32,
    /// Time to first byte, moving average (ms).
    ttfb_ms: Option<f64>,
    /// Throughput of one upstream response, moving average (bytes/s).
    rate_bps: Option<f64>,
    /// Asked before the length was known.
    pending: Option<PrefetchRequest>,
    prefetched: bool,
    mp4_checked: bool,
    read_ahead: u64,
    /// Size of the tail fetched at open (`tail_bytes_for`).
    tail_bytes: u64,
    released_at: Option<Instant>,
    last_activity: Option<Instant>,
    bytes_fetched: u64,
    bytes_served: u64,
    upstream_requests: u32,
}

impl State {
    fn seg(&mut self, id: u64) -> Option<&mut Segment> {
        self.segments.iter_mut().find(|s| s.id == id)
    }

    fn retained(&self) -> u64 {
        self.segments.iter().map(|s| s.retained).sum()
    }

    /// Bytes from `pos` already held contiguously (across segments).
    fn covered_until(&self, mut pos: u64) -> u64 {
        loop {
            let Some(next) = self
                .segments
                .iter()
                .filter_map(|s| {
                    let (at, b) = s.chunks.range(..=pos).next_back()?;
                    let end = at + b.len() as u64;
                    (end > pos).then_some(end)
                })
                .max()
            else {
                return pos;
            };
            pos = next;
        }
    }

    /// Up to `n` contiguous bytes from `pos`, across segments.
    fn collect(&self, mut pos: u64, n: u64) -> Vec<u8> {
        let end = pos + n;
        let mut out = Vec::new();
        while pos < end {
            let Some(b) = self.segments.iter().find_map(|g| g.slice(pos, end - pos)) else { break };
            out.extend_from_slice(&b);
            pos += b.len() as u64;
        }
        out
    }

    /// Some segment holds or will soon hold `pos`.
    fn claimed(&self, pos: u64) -> bool {
        self.segments.iter().any(|s| s.has(pos) || (s.will_cover(pos) && s.next() == Some(pos)))
    }

    /// Re-entrant: a meta change (length, range support) is visible to readers.
    fn meta_ready(&self) -> bool {
        self.error.is_some() || self.no_range || (self.len.is_some() && self.range_ok)
    }

    fn stall_after(&self) -> Duration {
        let base = self.ttfb_ms.unwrap_or(500.0) / 1000.0;
        Duration::from_secs_f64((3.0 * base + 1.0).clamp(2.0, 6.0))
    }
}

pub struct Session {
    pub id: u64,
    key: String,
    url: reqwest::Url,
    host: String,
    ext: Option<&'static str>,
    headers: HeaderMap,
    /// Where the original URL redirects to (asked directly afterwards).
    resolved: Mutex<Option<reqwest::Url>>,
    state: Mutex<State>,
    /// Fetches → readers: bytes, length, errors.
    notify: Notify,
    /// Readers → fetches: a reader moved (read-ahead), the session was released or closed.
    wants: Notify,
    refs: AtomicUsize,
    closed: AtomicBool,
}

impl Session {
    fn touch(&self, st: &mut State) {
        st.last_activity = Some(Instant::now());
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut st = self.state.lock();
        for s in st.segments.iter_mut() {
            s.stop();
        }
        st.segments.clear();
        drop(st);
        self.notify.notify_waiters();
        self.wants.notify_waiters();
    }
}

// ------------------------------------------------------------------------------------------------
// Proxy
// ------------------------------------------------------------------------------------------------

pub struct Shared {
    client: reqwest::Client,
    sessions: RwLock<HashMap<u64, Arc<Session>>>,
    next_id: AtomicU64,
    port: AtomicU16,
    handle: tokio::runtime::Handle,
    allow_loopback: bool,
    /// Origins seen ignoring Range: their links play directly from then on (no time lost
    /// finding out again).
    no_range_origins: Mutex<std::collections::HashSet<String>>,
}

/// `HttpProxy::start_with` options (the app uses the defaults).
#[derive(Debug, Clone, Default)]
pub struct ProxyOptions {
    /// Upstream on 127.0.0.1 / localhost (tests and the offline bench; the app never proxies its
    /// own loopback servers).
    pub allow_loopback: bool,
}

pub struct HttpProxy {
    /// Shut down in the background on drop (see `Engine` for why).
    runtime: ManuallyDrop<tokio::runtime::Runtime>,
    pub shared: Arc<Shared>,
    server: Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<()>)>>,
    janitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for HttpProxy {
    fn drop(&mut self) {
        // SAFETY: taken exactly once, here.
        let rt = unsafe { ManuallyDrop::take(&mut self.runtime) };
        rt.shutdown_background();
    }
}

fn build_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        // HTTP/1.1 only: over HTTP/2 every range shares one connection window, and a read-ahead
        // paused in front of its reader keeps its unread bytes on it, which can stall the range
        // the player waits for. One pooled connection per range never couples them.
        .http1_only()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .context("http client")
}

impl HttpProxy {
    /// Its own runtime (2 workers) and loopback listener.
    pub fn start() -> Result<Arc<HttpProxy>> {
        Self::start_with(ProxyOptions::default())
    }

    pub fn start_with(opts: ProxyOptions) -> Result<Arc<HttpProxy>> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("huwa-http")
            .enable_all()
            .build()
            .context("tokio runtime")?;
        let client = runtime.block_on(async { build_client() })?;
        let shared = Arc::new(Shared {
            client,
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            port: AtomicU16::new(0),
            handle: runtime.handle().clone(),
            allow_loopback: opts.allow_loopback,
            no_range_origins: Mutex::new(Default::default()),
        });
        let listener = runtime.block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))?;
        shared.port.store(listener.local_addr()?.port(), Ordering::Relaxed);
        let app = router(shared.clone());
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = runtime.spawn(async move {
            let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = stopped.await;
            });
            if let Err(e) = serve.await {
                warn!("http proxy stopped: {e:#}");
            }
        });
        let weak = Arc::downgrade(&shared);
        let janitor = runtime.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                let Some(sh) = weak.upgrade() else { return };
                sh.sweep();
            }
        });
        Ok(Arc::new(HttpProxy {
            runtime: ManuallyDrop::new(runtime),
            shared,
            server: Mutex::new(Some((stop, server))),
            janitor: Mutex::new(Some(janitor)),
        }))
    }

    pub fn port(&self) -> u16 {
        self.shared.port.load(Ordering::Relaxed)
    }

    pub fn open(&self, req: OpenRequest) -> Result<OpenResponse> {
        self.shared.open(req)
    }

    pub fn status(&self, id: u64) -> Option<HttpStatus> {
        self.shared.session(id).map(|s| self.shared.status_of(&s))
    }

    pub fn shutdown(&self) {
        let sessions: Vec<_> = self.shared.sessions.write().drain().map(|(_, s)| s).collect();
        for s in sessions {
            s.close();
        }
        let server = self.server.lock().take();
        let janitor = self.janitor.lock().take();
        self.runtime.block_on(async {
            if let Some(j) = janitor {
                j.abort();
                let _ = j.await;
            }
            if let Some((stop, mut task)) = server {
                let _ = stop.send(());
                if tokio::time::timeout(Duration::from_secs(1), &mut task).await.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
        });
    }

    /// JSON methods (module docs).
    pub fn dispatch(&self, method: &str, args: Value) -> Result<Value> {
        let id_of = |args: &Value| args.get("id").and_then(Value::as_u64).ok_or_else(|| anyhow!("missing `id`"));
        match method {
            "httpOpen" => Ok(serde_json::to_value(self.open(serde_json::from_value(args)?)?)?),
            "httpPrefetch" => {
                let id = id_of(&args)?;
                let req: PrefetchRequest = serde_json::from_value(args)?;
                let s = self.shared.session(id).ok_or_else(|| anyhow!("unknown http session {id}"))?;
                self.shared.prefetch(&s, req);
                Ok(Value::Bool(true))
            }
            "httpRelease" => {
                self.shared.release(id_of(&args)?);
                Ok(Value::Bool(true))
            }
            "httpStatus" => {
                let id = id_of(&args)?;
                Ok(serde_json::to_value(self.status(id).ok_or_else(|| anyhow!("unknown http session {id}"))?)?)
            }
            other => Err(anyhow!("unknown method {other:?}")),
        }
    }
}

// ---------- global instance (FFI / JNI) ----------

static PROXY: Mutex<Option<Arc<HttpProxy>>> = Mutex::new(None);

/// The process-wide proxy, started on first use.
pub fn global() -> Result<Arc<HttpProxy>> {
    let mut g = PROXY.lock();
    if let Some(p) = g.as_ref() {
        return Ok(p.clone());
    }
    let p = HttpProxy::start()?;
    info!(port = p.port(), "http proxy listening");
    *g = Some(p.clone());
    Ok(p)
}

/// `http*` methods of `huwa_torrent_call`. `httpRelease` / `httpStatus` never start the proxy.
pub fn dispatch_global(method: &str, args: Value) -> Result<Value> {
    if method == "httpRelease" {
        if let Some(p) = PROXY.lock().clone() {
            return p.dispatch(method, args);
        }
        return Ok(Value::Bool(true));
    }
    global()?.dispatch(method, args)
}

pub fn shutdown_global() {
    let taken = PROXY.lock().take();
    if let Some(p) = taken {
        p.shutdown();
    }
}

// ---------- sessions ----------

fn sanitize_headers(given: &HashMap<String, String>) -> HeaderMap {
    const DROP: &[&str] = &[
        "host", "range", "if-range", "content-length", "connection", "keep-alive", "te", "trailer", "transfer-encoding",
        "upgrade", "expect", "accept-encoding", "proxy-authorization", "proxy-connection",
    ];
    let mut out = HeaderMap::new();
    for (k, v) in given {
        let lk = k.trim().to_ascii_lowercase();
        if DROP.contains(&lk.as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(lk.as_bytes()), HeaderValue::from_str(v.trim())) {
            out.append(name, value);
        }
    }
    if !out.contains_key(header::USER_AGENT) {
        out.insert(header::USER_AGENT, HeaderValue::from_static(DEFAULT_UA));
    }
    out
}

fn dedupe_key(url: &str, headers: &HashMap<String, String>) -> String {
    let mut h: Vec<_> = headers.iter().map(|(k, v)| format!("{}:{}", k.to_ascii_lowercase(), v)).collect();
    h.sort();
    format!("{url}\n{}", h.join("\n"))
}

fn is_loopback(u: &reqwest::Url) -> bool {
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost") || d.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        None => true,
    }
}

/// Video extension of the URL's last path segment (the loopback URL carries it: a hint for the
/// demuxer probe, as the torrent engine's URLs do).
fn ext_of(u: &reqwest::Url) -> Option<&'static str> {
    let last = u.path_segments()?.next_back()?;
    let ext = last.rsplit_once('.')?.1.to_ascii_lowercase();
    ["mkv", "mp4", "m4v", "webm", "mov", "avi", "ts", "m2ts"].into_iter().find(|e| *e == ext)
}

impl Shared {
    fn session(&self, id: u64) -> Option<Arc<Session>> {
        self.sessions.read().get(&id).cloned()
    }

    fn loopback_url(&self, s: &Session) -> String {
        let port = self.port.load(Ordering::Relaxed);
        match s.ext {
            Some(e) => format!("http://127.0.0.1:{port}/http/{}.{e}", s.id),
            None => format!("http://127.0.0.1:{port}/http/{}", s.id),
        }
    }

    fn open(self: &Arc<Self>, req: OpenRequest) -> Result<OpenResponse> {
        let url = reqwest::Url::parse(req.url.trim()).map_err(|_| anyhow!("invalid url"))?;
        let unsupported = || OpenResponse { id: None, url: None, reused: false, fallback: Some("unsupported") };
        if !matches!(url.scheme(), "http" | "https") || (is_loopback(&url) && !self.allow_loopback) {
            return Ok(unsupported());
        }
        // Android: rustls-platform-verifier needs its JNI init, not wired: HTTPS plays directly.
        if cfg!(target_os = "android") && url.scheme() == "https" {
            return Ok(unsupported());
        }
        if self.no_range_origins.lock().contains(&url.origin().ascii_serialization()) {
            return Ok(OpenResponse { id: None, url: None, reused: false, fallback: Some("noRange") });
        }
        let key = dedupe_key(url.as_str(), &req.headers);
        let existing = self.sessions.read().values().find(|s| s.key == key && !s.closed.load(Ordering::Acquire)).cloned();
        if let Some(s) = existing {
            let st = s.state.lock();
            let (no_range, failed) = (st.no_range, st.error.is_some());
            drop(st);
            if no_range {
                return Ok(OpenResponse { id: None, url: None, reused: true, fallback: Some("noRange") });
            }
            if !failed {
                s.refs.fetch_add(1, Ordering::AcqRel);
                {
                    let mut st = s.state.lock();
                    st.released_at = None;
                    s.touch(&mut st);
                }
                debug!(session = s.id, host = %s.host, "http session reused");
                if let Some(p) = req.prefetch {
                    self.prefetch(&s, p);
                }
                return Ok(OpenResponse { id: Some(s.id), url: Some(self.loopback_url(&s)), reused: true, fallback: None });
            }
            // A failed link may work again (refreshed upstream): a fresh session.
            self.remove(s.id);
        }
        self.make_room();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let ext = ext_of(&url);
        let s = Arc::new(Session {
            id,
            key,
            host: redact(url.as_str()),
            ext,
            headers: sanitize_headers(&req.headers),
            url,
            resolved: Mutex::new(None),
            state: Mutex::new(State {
                read_ahead: DEFAULT_READ_AHEAD,
                tail_bytes: tail_bytes_for(ext),
                last_activity: Some(Instant::now()),
                ..Default::default()
            }),
            notify: Notify::new(),
            wants: Notify::new(),
            refs: AtomicUsize::new(1),
            closed: AtomicBool::new(false),
        });
        self.sessions.write().insert(id, s.clone());
        debug!(session = id, host = %s.host, prefetch = req.prefetch.is_some(), "http session opened");
        if let Some(p) = req.prefetch {
            self.prefetch(&s, p);
        }
        Ok(OpenResponse { id: Some(id), url: Some(self.loopback_url(&s)), reused: false, fallback: None })
    }

    /// Room for one more session: expired / idle ones first, then the least recently used.
    fn make_room(&self) {
        self.sweep();
        loop {
            let victim = {
                let map = self.sessions.read();
                if map.len() < MAX_SESSIONS {
                    return;
                }
                let last = |s: &Arc<Session>| s.state.lock().last_activity;
                map.values()
                    .min_by_key(|s| (s.refs.load(Ordering::Acquire) > 0, last(s)))
                    .map(|s| s.id)
            };
            match victim {
                Some(id) => self.remove(id),
                None => return,
            }
        }
    }

    fn remove(&self, id: u64) {
        let s = self.sessions.write().remove(&id);
        if let Some(s) = s {
            debug!(session = id, host = %s.host, "http session closed");
            s.close();
        }
    }

    /// Janitor pass: released sessions past `IDLE_TTL`. One still held (a long pause) stays: only
    /// `make_room` (least recently used, released first) can drop it.
    fn sweep(&self) {
        let now = Instant::now();
        let expired: Vec<u64> = self
            .sessions
            .read()
            .values()
            .filter(|s| {
                let st = s.state.lock();
                st.released_at.is_some_and(|t| now - t >= IDLE_TTL)
            })
            .map(|s| s.id)
            .collect();
        for id in expired {
            self.remove(id);
        }
    }

    fn release(&self, id: u64) {
        let Some(s) = self.session(id) else { return };
        let left = s.refs.fetch_sub(1, Ordering::AcqRel).saturating_sub(1);
        if left > 0 {
            return;
        }
        s.refs.store(0, Ordering::Release);
        let mut st = s.state.lock();
        // Nothing downloads for a link nobody plays; what was read stays for a reopen (bounded).
        for g in st.segments.iter_mut() {
            g.stop();
            g.trim_to_pin();
        }
        st.segments.retain(|g| g.retained > 0);
        st.pending = None;
        // A reopen fetches again what is missing.
        st.prefetched = false;
        st.released_at = Some(Instant::now());
        let error = st.error.is_some() || st.no_range;
        drop(st);
        s.notify.notify_waiters();
        s.wants.notify_waiters();
        debug!(session = id, host = %s.host, "http session released");
        if error {
            self.remove(id);
        }
    }

    fn status_of(&self, s: &Session) -> HttpStatus {
        let st = s.state.lock();
        HttpStatus {
            id: s.id,
            host: s.host.clone(),
            length: st.len,
            range_ok: st.range_ok,
            no_range: st.no_range,
            error: st.error.clone(),
            bytes_fetched: st.bytes_fetched,
            bytes_served: st.bytes_served,
            upstream_requests: st.upstream_requests,
            ttfb_ms: st.ttfb_ms.map(|t| t.round() as u64),
            segments: st.segments.len(),
            retained_bytes: st.retained(),
            refs: s.refs.load(Ordering::Acquire),
        }
    }

    // ---------- prefetch ----------

    fn prefetch(self: &Arc<Self>, s: &Arc<Session>, req: PrefetchRequest) {
        let mut st = s.state.lock();
        if s.closed.load(Ordering::Acquire) || st.error.is_some() || st.no_range {
            return;
        }
        if let Some(ra) = req.read_ahead {
            st.read_ahead = ra.clamp(MIN_READ_AHEAD, MAX_READ_AHEAD);
        }
        st.released_at = None;
        s.touch(&mut st);
        if st.prefetched {
            return;
        }
        st.prefetched = true;
        if let Some(c) = req.container.as_deref() {
            st.tail_bytes = tail_bytes_for(Some(c));
        }
        let resume = req.start_at.is_some_and(|t| t > 1.0);
        // Head: from the first byte not held yet. A start reads on from there (open-ended), a
        // resume only needs the headers.
        let from = st.covered_until(0);
        if resume {
            if from < HEAD_BYTES && !st.claimed(from) {
                self.spawn_segment(s, &mut st, Kind::Head, Some(from), Some(HEAD_BYTES), HEAD_BYTES - from, false);
            }
        } else if !st.claimed(from) {
            self.spawn_segment(s, &mut st, Kind::Head, Some(from), None, HEAD_BYTES.saturating_sub(from), true);
        }
        match st.len {
            Some(len) => {
                self.spawn_tail(s, &mut st, len);
                self.spawn_target(s, &mut st, &req, len);
            }
            None => {
                // Suffix range: no need to know the length.
                if !st.segments.iter().any(|g| g.kind == Kind::Tail) {
                    let n = st.tail_bytes;
                    self.spawn_segment(s, &mut st, Kind::Tail, None, None, n, false);
                }
                if let Some(size) = req.size.filter(|n| *n > 0) {
                    self.spawn_target(s, &mut st, &req, size);
                }
                st.pending = Some(req);
            }
        }
        drop(st);
        s.notify.notify_waiters();
        s.wants.notify_waiters();
    }

    fn spawn_tail(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, len: u64) {
        let start = len.saturating_sub(st.tail_bytes);
        let from = st.covered_until(start);
        if from < len && !st.claimed(from) && !st.segments.iter().any(|g| g.kind == Kind::Tail && g.live) {
            self.spawn_segment(s, st, Kind::Tail, Some(from), Some(len), len - from, false);
        }
    }

    fn spawn_target(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, req: &PrefetchRequest, len: u64) {
        let (Some(at), Some(dur)) = (req.start_at, req.duration) else { return };
        if req.target == Some(false) || at <= 1.0 || dur <= at || dur <= 0.0 || st.segments.iter().any(|g| g.kind == Kind::Target) {
            return;
        }
        let bps = len as f64 / dur;
        let begin = ((at - TARGET_BACK_SECS).max(0.0) * bps) as u64;
        // Not inside the head / tail already asked for.
        if begin < HEAD_BYTES || begin + TARGET_BYTES >= len.saturating_sub(st.tail_bytes) {
            return;
        }
        let from = st.covered_until(begin);
        if !st.claimed(from) {
            self.spawn_segment(s, st, Kind::Target, Some(from), None, TARGET_BYTES, true);
        }
    }

    /// The length is known: what waited for it (resume target, an explicit tail).
    fn on_len(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, len: u64) {
        for g in st.segments.iter_mut() {
            if g.kind == Kind::Tail && g.start.is_none() && g.live {
                // A suffix range answers from here (RFC 9110 §14.1.2).
                g.start = Some(len.saturating_sub(g.pin));
                g.end = Some(len);
            }
        }
        if st.suffix_ignored && st.prefetched {
            self.spawn_tail(s, st, len);
        }
        if let Some(req) = st.pending.take() {
            self.spawn_target(s, st, &req, len);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_segment(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, kind: Kind, start: Option<u64>, end: Option<u64>, pin: u64, flow: bool) -> u64 {
        st.segments.retain(|g| g.live || g.retained > 0);
        if st.segments.len() >= MAX_SEGMENTS {
            // The least recently read one that is not fetching, else the oldest reader position.
            let victim = st
                .segments
                .iter()
                .filter(|g| g.kind == Kind::Play || g.kind == Kind::Bounded || !g.live)
                .min_by_key(|g| (g.live, g.last_read))
                .map(|g| g.id);
            if let Some(v) = victim {
                if let Some(g) = st.seg(v) {
                    g.stop();
                }
                st.segments.retain(|g| g.id != v);
            }
        }
        st.next_seg += 1;
        let id = st.next_seg;
        let now = Instant::now();
        st.segments.push(Segment {
            id,
            kind,
            start,
            end,
            received: 0,
            chunks: BTreeMap::new(),
            retained: 0,
            pin,
            demand: start.unwrap_or(0),
            touched: false,
            flow,
            live: true,
            hedged: false,
            created: now,
            first_byte: None,
            last_progress: now,
            last_read: now,
            abort: None,
        });
        let task = self.handle.spawn(fetch(self.clone(), s.clone(), id));
        if let Some(g) = st.seg(id) {
            g.abort = Some(task.abort_handle());
        }
        debug!(session = s.id, seg = id, kind = kind.as_str(), ?start, ?end, "http fetch");
        id
    }

    // ---------- upstream ----------

    async fn send(&self, s: &Session, range: &str, fresh: bool) -> Result<reqwest::Response, String> {
        let resolved = if fresh { None } else { s.resolved.lock().clone() };
        let url = resolved.clone().unwrap_or_else(|| s.url.clone());
        let mut h = s.headers.clone();
        if resolved.as_ref().is_some_and(|r| r.origin() != s.url.origin()) {
            // reqwest drops these on a cross-origin redirect: so do we when asking the target.
            for k in [header::COOKIE, header::AUTHORIZATION] {
                h.remove(k);
            }
        }
        if let Ok(v) = HeaderValue::from_str(range) {
            h.insert(header::RANGE, v);
        }
        let req = self.client.get(url.clone()).headers(h).send();
        let resp = match tokio::time::timeout(RESPONSE_TIMEOUT, req).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(net_error(e)),
            Err(_) => return Err("délai dépassé".into()),
        };
        if resp.url() != &url && resolved.is_none() {
            *s.resolved.lock() = Some(resp.url().clone());
        }
        Ok(resp)
    }
}

/// `Content-Range: bytes a-b/total` → (a, total).
fn content_range(h: &reqwest::header::HeaderMap) -> Option<(u64, Option<u64>)> {
    let v = h.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?.trim();
    let v = v.strip_prefix("bytes")?.trim();
    let (range, total) = v.split_once('/')?;
    let start = range.split('-').next()?.trim().parse().ok()?;
    Some((start, total.trim().parse().ok()))
}

fn fatal_status(code: u16) -> bool {
    matches!(code, 401 | 403 | 404 | 407 | 410 | 451)
}

enum Outcome {
    Done,
    /// Try again later (counted).
    Failed,
}

/// One upstream request filling one segment.
async fn fetch(px: Arc<Shared>, s: Arc<Session>, seg_id: u64) {
    let outcome = fetch_inner(&px, &s, seg_id).await;
    if matches!(outcome, Outcome::Failed) {
        // Backoff before the reader waiting on this segment asks again.
        let n = s.state.lock().failures;
        tokio::time::sleep(Duration::from_millis(200 * (n as u64 + 1))).await;
    }
    let mut st = s.state.lock();
    if let Some(g) = st.seg(seg_id) {
        g.live = false;
        g.abort = None;
    }
    if matches!(outcome, Outcome::Failed) {
        st.failures += 1;
        if st.failures >= MAX_FAILURES && st.error.is_none() && !st.no_range {
            warn!(session = s.id, host = %s.host, "http upstream keeps failing");
            st.error = Some(HttpError { status: 0, message: "le serveur ne répond pas".into() });
        }
    }
    st.segments.retain(|g| g.live || g.retained > 0);
    drop(st);
    s.notify.notify_waiters();
}

async fn fetch_inner(px: &Arc<Shared>, s: &Arc<Session>, seg_id: u64) -> Outcome {
    let (range, suffix, req_start) = {
        let mut st = s.state.lock();
        let Some(g) = st.seg(seg_id) else { return Outcome::Done };
        let range = match (g.start, g.end) {
            (None, _) => format!("bytes=-{}", g.pin.max(1)),
            (Some(a), Some(e)) => format!("bytes={a}-{}", e.saturating_sub(1).max(a)),
            (Some(a), None) => format!("bytes={a}-"),
        };
        let r = (range, g.start.is_none(), g.start);
        st.upstream_requests += 1;
        r
    };
    let t0 = Instant::now();
    let mut fresh = false;
    let mut resp = loop {
        let r = px.send(s, &range, fresh).await;
        let resp = match r {
            Ok(r) => r,
            Err(msg) => {
                debug!(session = s.id, host = %s.host, seg = seg_id, error = %msg, "http request failed");
                return Outcome::Failed;
            }
        };
        let code = resp.status().as_u16();
        // A remembered redirect target may have expired: once more from the original link.
        if fatal_status(code) && !fresh && s.resolved.lock().is_some() {
            *s.resolved.lock() = None;
            fresh = true;
            continue;
        }
        break resp;
    };
    let code = resp.status().as_u16();
    let ttfb = t0.elapsed().as_secs_f64() * 1000.0;
    {
        let mut st = s.state.lock();
        if s.closed.load(Ordering::Acquire) || !st.seg(seg_id).is_some_and(|g| g.live) {
            return Outcome::Done;
        }
        st.ttfb_ms = Some(st.ttfb_ms.map_or(ttfb, |t| t * 0.6 + ttfb * 0.4));
        let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_ascii_lowercase);
        // A playlist (HLS / DASH behind a link without extension): mpv must fetch its segments
        // relative to the real URL, not through this one.
        let playlist = code < 300 && content_type.as_deref().is_some_and(|t| t.contains("mpegurl") || t.contains("dash+xml"));
        if st.content_type.is_none() {
            st.content_type = content_type;
        }
        let mut new_len = None;
        match code {
            206 => {
                let Some((start, total)) = content_range(resp.headers()) else {
                    warn!(session = s.id, host = %s.host, "206 without Content-Range");
                    return Outcome::Failed;
                };
                st.range_ok = true;
                st.failures = 0;
                if st.len.is_none() {
                    match total {
                        Some(t) => new_len = Some(t),
                        // Length unknown: nothing to tell the player. Direct playback.
                        None => st.no_range = true,
                    }
                }
                if let Some(g) = st.seg(seg_id) {
                    if g.start.is_none() || g.start != Some(start) {
                        if !suffix {
                            debug!(session = s.id, seg = seg_id, want = ?req_start, got = start, "range answered elsewhere");
                        }
                        g.start = Some(start);
                        g.demand = g.demand.max(start);
                    }
                }
            }
            200 if req_start == Some(0) => {
                // The whole file from byte 0: usable as the head, but says nothing of range support.
                st.head_200 = true;
                st.failures = 0;
                if st.len.is_none() {
                    match resp.content_length() {
                        Some(t) => new_len = Some(t),
                        None => st.no_range = true,
                    }
                }
                if st.suffix_ignored || !st.segments.iter().any(|g| g.kind == Kind::Tail) {
                    st.no_range = true;
                }
            }
            200 if suffix => {
                // The suffix range was ignored: the tail is asked as `bytes=a-b` once the length is
                // known (now, or with the head's answer, see `on_len`).
                st.suffix_ignored = true;
                if st.head_200 {
                    st.no_range = true;
                } else {
                    if let Some(g) = st.seg(seg_id) {
                        g.live = false;
                    }
                    if let Some(len) = st.len {
                        px.spawn_tail(s, &mut st, len);
                    }
                    drop(st);
                    s.notify.notify_waiters();
                    return Outcome::Done;
                }
            }
            200 => st.no_range = true,
            416 => {
                debug!(session = s.id, seg = seg_id, "416");
                return Outcome::Done;
            }
            c if fatal_status(c) => {
                info!(session = s.id, host = %s.host, status = c, "http source refused");
                st.error = Some(HttpError { status: c, message: format!("HTTP {c}") });
            }
            c => {
                debug!(session = s.id, host = %s.host, status = c, "http upstream error");
                if st.failures + 1 >= MAX_FAILURES {
                    st.error = Some(HttpError { status: c, message: format!("HTTP {c}") });
                }
                return Outcome::Failed;
            }
        }
        if playlist {
            info!(session = s.id, host = %s.host, "playlist: direct playback");
            st.no_range = true;
        } else if st.no_range {
            info!(session = s.id, host = %s.host, "server ignores Range: direct playback");
            px.no_range_origins.lock().insert(s.url.origin().ascii_serialization());
        }
        if st.no_range || st.error.is_some() {
            // Nothing more to fetch from this session.
            for g in st.segments.iter_mut() {
                g.stop();
            }
            drop(st);
            s.notify.notify_waiters();
            return Outcome::Done;
        }
        if let Some(len) = new_len {
            st.len = Some(len);
            px.on_len(s, &mut st, len);
        }
    }
    s.notify.notify_waiters();

    // ---- body ----
    loop {
        // Read-ahead: paused while far enough in front of the reader.
        loop {
            let notified = s.wants.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut st = s.state.lock();
                if s.closed.load(Ordering::Acquire) {
                    return Outcome::Done;
                }
                let ra = st.read_ahead;
                let Some(g) = st.seg(seg_id) else { return Outcome::Done };
                if !g.live {
                    return Outcome::Done;
                }
                if !g.flow || g.next().unwrap_or(0) < g.allowance(ra) {
                    break;
                }
            }
            notified.await;
        }
        let chunk = match tokio::time::timeout(BODY_STALL, resp.chunk()).await {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => return Outcome::Done,
            Ok(Err(e)) => {
                debug!(session = s.id, seg = seg_id, error = %net_error(e), "http body ended");
                return Outcome::Done;
            }
            Err(_) => {
                debug!(session = s.id, seg = seg_id, "http body stalled");
                return Outcome::Done;
            }
        };
        if chunk.is_empty() {
            continue;
        }
        let mut st = s.state.lock();
        let len = st.len;
        let check_mp4 = !st.mp4_checked;
        let Some(g) = st.seg(seg_id) else { return Outcome::Done };
        if !g.live {
            return Outcome::Done;
        }
        // Never past the requested end (a server sending more than asked).
        let mut chunk = chunk;
        if let (Some(e), Some(n)) = (g.end, g.next()) {
            if n + chunk.len() as u64 > e {
                chunk.truncate(e.saturating_sub(n) as usize);
            }
        }
        let now = Instant::now();
        let first = *g.first_byte.get_or_insert(now);
        g.last_progress = now;
        let n = chunk.len() as u64;
        g.insert(chunk);
        let next = g.next().unwrap_or(0);
        let kind = g.kind;
        let seg_rate = (g.received >= 128 * KIB && now > first).then(|| g.received as f64 / (now - first).as_secs_f64());
        let reached_end = g.end.is_some_and(|e| next >= e) || len.is_some_and(|l| next >= l);
        if let Some(r) = seg_rate {
            st.rate_bps = Some(st.rate_bps.map_or(r, |old| old * 0.8 + r * 0.2));
        }
        st.bytes_fetched += n;
        // MP4 with its moov after the mdat but before the tail: fetched at once (mpv reads it
        // before frame 1, a whole time to first byte later otherwise).
        if check_mp4 && kind == Kind::Head && next >= (64 * KIB).min(len.unwrap_or(u64::MAX)) {
            st.mp4_checked = true;
            let head = st.collect(0, 64 * KIB);
            if let Some(len) = len {
                if let Some(moov) = mp4_moov_after_mdat(&head) {
                    let tail_start = len.saturating_sub(st.tail_bytes);
                    if moov < tail_start && !st.claimed(moov) {
                        let end = tail_start.min(moov + 8 * MIB);
                        px.spawn_segment(s, &mut st, Kind::Index, Some(moov), Some(end), end - moov, false);
                    }
                }
            }
        }
        // Another segment already holds what comes next: this request has done its part.
        let merged = !reached_end && st.segments.iter().any(|o| o.id != seg_id && o.has(next));
        if st.retained() > SESSION_BUDGET {
            trim_for_budget(&mut st, seg_id);
        }
        drop(st);
        s.notify.notify_waiters();
        if reached_end || merged {
            return Outcome::Done;
        }
    }
}

/// Over budget: unpinned bytes of the segments read least recently go first.
fn trim_for_budget(st: &mut State, keep: u64) {
    let mut order: Vec<(Instant, u64)> = st.segments.iter().filter(|g| g.id != keep).map(|g| (g.last_read, g.id)).collect();
    order.sort();
    for (_, id) in order {
        if st.retained() <= SESSION_BUDGET {
            return;
        }
        if let Some(g) = st.seg(id) {
            g.stop();
            g.trim_to_pin();
        }
    }
}

/// The `moov` offset of an MP4 whose `mdat` comes first (top-level boxes in the head), else None.
pub fn mp4_moov_after_mdat(head: &[u8]) -> Option<u64> {
    if head.len() < 16 || &head[4..8] != b"ftyp" {
        return None;
    }
    let mut at = 0u64;
    for _ in 0..16 {
        let i = at as usize;
        if i + 8 > head.len() {
            return None;
        }
        let mut size = u32::from_be_bytes(head[i..i + 4].try_into().ok()?) as u64;
        let kind = &head[i + 4..i + 8];
        if size == 1 {
            if i + 16 > head.len() {
                return None;
            }
            size = u64::from_be_bytes(head[i + 8..i + 16].try_into().ok()?);
        }
        if kind == b"moov" || size < 8 {
            return None;
        }
        if kind == b"mdat" {
            return Some(at + size);
        }
        at += size;
    }
    None
}

// ------------------------------------------------------------------------------------------------
// Serving the player
// ------------------------------------------------------------------------------------------------

fn router(shared: Arc<Shared>) -> Router {
    Router::new().route("/http/{file}", get(serve)).with_state(shared)
}

/// What a `Range` header asks for, before the length is known.
fn first_wanted(h: Option<&str>) -> (Option<u64>, Option<u64>) {
    let Some(spec) = h.and_then(|h| h.trim().strip_prefix("bytes=")) else { return (Some(0), None) };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else { return (Some(0), None) };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        return (None, b.parse().ok());
    }
    (a.parse().ok(), b.parse::<u64>().ok().map(|e| e + 1))
}

enum ReadErr {
    Closed,
    Fatal(HttpError),
    NoRange,
}

fn redirect_to(s: &Session) -> Response {
    let mut out = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(s.url.as_str()) {
        out.insert(header::LOCATION, v);
    }
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::FOUND, out).into_response()
}

fn error_response(e: &HttpError) -> Response {
    let code = if e.status >= 400 { StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY) } else { StatusCode::BAD_GATEWAY };
    (code, e.message.clone()).into_response()
}

async fn serve(Ax(px): Ax<Arc<Shared>>, Path(file): Path<String>, headers: HeaderMap) -> Response {
    let id = file.split_once('.').map_or(file.as_str(), |(i, _)| i);
    let Some(s) = id.parse().ok().and_then(|id| px.session(id)) else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (want_start, want_end) = first_wanted(range_header.as_deref());

    // Length and range support first (the status line depends on them).
    let deadline = tokio::time::Instant::now() + RESPONSE_TIMEOUT + Duration::from_secs(2);
    loop {
        let notified = s.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let mut st = s.state.lock();
            s.touch(&mut st);
            if s.closed.load(Ordering::Acquire) {
                return (StatusCode::GONE, "closed").into_response();
            }
            if let Some(e) = &st.error {
                return error_response(e);
            }
            if st.no_range {
                return redirect_to(&s);
            }
            if st.meta_ready() {
                break;
            }
            // Nothing asked upstream yet (no prefetch: a header sniff): this request starts it.
            if !st.segments.iter().any(|g| g.live) {
                let pos = want_start.unwrap_or(0);
                match (want_start, want_end) {
                    (None, n) => {
                        let n = n.unwrap_or(TAIL_BYTES).clamp(1, BOUNDED_MAX);
                        px.spawn_segment(&s, &mut st, Kind::Tail, None, None, n, false);
                    }
                    (Some(a), Some(e)) if e > a && e - a <= BOUNDED_MAX => {
                        px.spawn_segment(&s, &mut st, Kind::Bounded, Some(a), Some(e), e - a, false);
                    }
                    _ => {
                        px.spawn_segment(&s, &mut st, Kind::Play, Some(pos), None, 0, true);
                    }
                }
            }
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            let st = s.state.lock();
            // A 200 to the head with no tail answer: the range support was never shown.
            if st.len.is_some() && !st.range_ok {
                drop(st);
                return redirect_to(&s);
            }
            return (StatusCode::GATEWAY_TIMEOUT, "upstream timeout").into_response();
        }
    }

    let (len, content_type) = {
        let st = s.state.lock();
        (st.len.unwrap_or(0), st.content_type.clone())
    };
    let spec = parse_range(range_header.as_deref(), len);
    let mut out = HeaderMap::new();
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let ct = content_type.unwrap_or_else(|| s.ext.map(|e| crate::server::mime_for(&format!("x.{e}"))).unwrap_or("application/octet-stream").to_string());
    if let Ok(v) = HeaderValue::from_str(&ct) {
        out.insert(header::CONTENT_TYPE, v);
    }
    let (status, start, end) = match spec {
        RangeSpec::Unsatisfiable => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{len}")) {
                out.insert(header::CONTENT_RANGE, v);
            }
            return (StatusCode::RANGE_NOT_SATISFIABLE, out).into_response();
        }
        RangeSpec::Full => (StatusCode::OK, 0, len),
        RangeSpec::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
    };
    if let Ok(v) = HeaderValue::from_str(&(end - start).to_string()) {
        out.insert(header::CONTENT_LENGTH, v);
    }
    if status == StatusCode::PARTIAL_CONTENT {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end - 1, len)) {
            out.insert(header::CONTENT_RANGE, v);
        }
    }
    // A closed request (header sniff) is fetched as asked, not with a read-ahead.
    let bounded = want_end.is_some() && end - start <= BOUNDED_MAX;
    let reader = Reader { px: px.clone(), s: s.clone(), pos: start, end, bounded };
    let body = futures::stream::unfold(reader, |mut r| async move {
        if r.pos >= r.end {
            return None;
        }
        match r.read().await {
            Ok(b) => {
                r.pos += b.len() as u64;
                Some((Ok::<Bytes, std::io::Error>(b), r))
            }
            Err(e) => {
                let msg = match e {
                    ReadErr::Closed => "session closed".to_string(),
                    ReadErr::Fatal(e) => e.message,
                    ReadErr::NoRange => "range unsupported".to_string(),
                };
                r.pos = r.end;
                Some((Err(std::io::Error::other(msg)), r))
            }
        }
    });
    (status, out, Body::from_stream(body)).into_response()
}

struct Reader {
    px: Arc<Shared>,
    s: Arc<Session>,
    pos: u64,
    end: u64,
    bounded: bool,
}

impl Reader {
    /// The next bytes at `pos`: held, coming in a running fetch, or asked for now.
    async fn read(&mut self) -> Result<Bytes, ReadErr> {
        let (s, px, pos) = (self.s.clone(), self.px.clone(), self.pos);
        let max = (self.end - pos).min(256 * KIB);
        loop {
            let notified = s.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let waiting: Option<(u64, Duration)>;
            {
                let mut st = s.state.lock();
                if s.closed.load(Ordering::Acquire) {
                    return Err(ReadErr::Closed);
                }
                if let Some(e) = &st.error {
                    return Err(ReadErr::Fatal(e.clone()));
                }
                if st.no_range {
                    return Err(ReadErr::NoRange);
                }
                let now = Instant::now();
                st.last_activity = Some(now);
                let len = st.len.unwrap_or(u64::MAX);
                // 1. Held.
                if let Some(i) = st.segments.iter().position(|g| g.has(pos)) {
                    let g = &mut st.segments[i];
                    let b = g.slice(pos, max).expect("has");
                    let reached = pos + b.len() as u64;
                    g.touched = true;
                    g.demand = g.demand.max(reached);
                    g.last_read = now;
                    if g.flow {
                        g.trim_behind();
                    }
                    // A bounded segment read close to its end: what follows is asked now.
                    let cont = (!g.flow && !self.bounded)
                        .then_some(g.end)
                        .flatten()
                        .filter(|e| *e < len && reached + CONTINUE_MARGIN >= *e);
                    st.bytes_served += b.len() as u64;
                    if let Some(e) = cont {
                        let ahead = st.covered_until(e);
                        if ahead < len && !st.claimed(ahead) && !st.segments.iter().any(|g| g.will_cover(ahead) && g.next().is_some_and(|n| ahead - n <= JOIN_MIN)) {
                            px.spawn_segment(&s, &mut st, Kind::Play, Some(ahead), None, 0, true);
                        }
                    }
                    drop(st);
                    s.wants.notify_waiters();
                    return Ok(b);
                }
                // 2. Coming: a running fetch reaches `pos` within about one time to first byte.
                let ttfb = st.ttfb_ms.unwrap_or(300.0) / 1000.0;
                let session_rate = st.rate_bps.unwrap_or(0.0);
                let stall = st.stall_after();
                let join = |g: &Segment| -> bool {
                    if !g.will_cover(pos) {
                        return false;
                    }
                    let gap = pos - g.next().unwrap_or(pos);
                    // Its own throughput once measurable, else the session's.
                    let rate = match g.first_byte {
                        Some(t) if now > t && g.received >= 64 * KIB => g.received as f64 / (now - t).as_secs_f64(),
                        _ => session_rate,
                    };
                    gap <= JOIN_MIN.max((rate * ttfb) as u64)
                };
                let pending_tail = st.segments.iter().filter(|g| g.live && g.start.is_none()).map(|g| g.pin).max();
                if let Some(g) = st.segments.iter_mut().filter(|g| join(g)).min_by_key(|g| pos - g.next().unwrap_or(pos)) {
                    g.touched = true;
                    g.demand = g.demand.max(pos);
                    g.last_read = now;
                    waiting = Some((g.id, stall));
                } else if pending_tail.is_some_and(|n| st.len.is_some_and(|l| pos >= l.saturating_sub(n))) {
                    // The suffix request will answer with these bytes.
                    waiting = None;
                } else {
                    // 3. Asked now. Other open-ended fetches nobody reads any more stop: one
                    // playhead at a time (mpv seeks by closing its connection).
                    for g in st.segments.iter_mut() {
                        if g.kind == Kind::Play && g.live && now.duration_since(g.last_read) > Duration::from_secs(1) {
                            g.stop();
                            g.chunks.clear();
                            g.retained = 0;
                        }
                    }
                    st.segments.retain(|g| g.live || g.retained > 0);
                    let bounded_end = self.bounded.then_some(self.end);
                    match bounded_end {
                        Some(e) => px.spawn_segment(&s, &mut st, Kind::Bounded, Some(pos), Some(e), e - pos, false),
                        None => px.spawn_segment(&s, &mut st, Kind::Play, Some(pos), None, 0, true),
                    };
                    continue;
                }
            }
            // The fetch we wait on may be paused by its read-ahead: the new demand wakes it.
            s.wants.notify_waiters();
            let _ = tokio::time::timeout(Duration::from_millis(250), notified).await;
            // A fetch that stopped delivering (a debrid server stuck on one range): asked again
            // now instead of after mpv's network timeout.
            if let Some((seg, stall)) = waiting {
                let mut st = s.state.lock();
                let hung = st.seg(seg).is_some_and(|g| {
                    g.live && !g.hedged && g.next().is_some_and(|n| n <= pos) && g.last_progress.elapsed() >= stall && g.created.elapsed() >= stall
                });
                if hung {
                    let g = st.seg(seg).expect("checked");
                    g.hedged = true;
                    let (kind, end) = (g.kind, g.end);
                    g.stop();
                    info!(session = s.id, host = %s.host, seg, kind = kind.as_str(), "http range stalled: asked again");
                    let flow = end.is_none();
                    let pin = end.map_or(0, |e| e - pos);
                    px.spawn_segment(&s, &mut st, if flow { Kind::Play } else { kind }, Some(pos), end, pin, flow);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_keeps_no_path_nor_query() {
        assert_eq!(redact("https://abc.download.real-debrid.com/d/TOKEN123/Show%20-%2001.mkv?x=1"), "https://abc.download.real-debrid.com/…");
        assert_eq!(redact("http://host:8080/"), "http://host:8080");
        assert_eq!(redact("not a url"), "<url>");
        assert!(!redact("https://h/resolve/realdebrid/APIKEY/hash").contains("APIKEY"));
    }

    #[test]
    fn header_sanitizing() {
        let mut h = HashMap::new();
        h.insert("Range".to_string(), "bytes=5-".to_string());
        h.insert("Host".to_string(), "evil".to_string());
        h.insert("Cookie".to_string(), "a=b".to_string());
        h.insert("Referer".to_string(), "https://x/".to_string());
        h.insert("Bad Header".to_string(), "x".to_string());
        let out = sanitize_headers(&h);
        assert!(out.get(header::RANGE).is_none() && out.get(header::HOST).is_none());
        assert_eq!(out.get(header::COOKIE).unwrap(), "a=b");
        assert_eq!(out.get(header::REFERER).unwrap(), "https://x/");
        assert_eq!(out.get(header::USER_AGENT).unwrap(), DEFAULT_UA);
        h.insert("user-agent".to_string(), "Custom/1".to_string());
        assert_eq!(sanitize_headers(&h).get(header::USER_AGENT).unwrap(), "Custom/1");
    }

    #[test]
    fn loopback_and_extension() {
        for u in ["http://127.0.0.1:9/x", "http://localhost/x", "http://[::1]/x", "http://0.0.0.0/x"] {
            assert!(is_loopback(&reqwest::Url::parse(u).unwrap()), "{u}");
        }
        assert!(!is_loopback(&reqwest::Url::parse("https://cdn.example/x.mkv").unwrap()));
        assert_eq!(ext_of(&reqwest::Url::parse("https://h/d/T/Show%20-%2001.MKV?t=1").unwrap()), Some("mkv"));
        assert_eq!(ext_of(&reqwest::Url::parse("https://h/resolve/abc").unwrap()), None);
    }

    #[test]
    fn wanted_ranges() {
        assert_eq!(first_wanted(None), (Some(0), None));
        assert_eq!(first_wanted(Some("bytes=10-")), (Some(10), None));
        assert_eq!(first_wanted(Some("bytes=10-19")), (Some(10), Some(20)));
        assert_eq!(first_wanted(Some("bytes=-500")), (None, Some(500)));
    }

    #[test]
    fn content_range_parsing() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::CONTENT_RANGE, "bytes 100-199/1000".parse().unwrap());
        assert_eq!(content_range(&h), Some((100, Some(1000))));
        h.insert(reqwest::header::CONTENT_RANGE, "bytes 0-9/*".parse().unwrap());
        assert_eq!(content_range(&h), Some((0, None)));
    }

    #[test]
    fn mp4_moov_after_mdat_is_found() {
        let mut b = Vec::new();
        b.extend_from_slice(&24u32.to_be_bytes());
        b.extend_from_slice(b"ftypisom");
        b.extend_from_slice(&[0; 12]);
        b.extend_from_slice(&8u32.to_be_bytes());
        b.extend_from_slice(b"free");
        b.extend_from_slice(&1_000_000u32.to_be_bytes());
        b.extend_from_slice(b"mdat");
        b.resize(4096, 0);
        assert_eq!(mp4_moov_after_mdat(&b), Some(24 + 8 + 1_000_000));
        // moov first (faststart): nothing to do.
        let mut f = b[..24].to_vec();
        f.extend_from_slice(&100u32.to_be_bytes());
        f.extend_from_slice(b"moov");
        f.resize(4096, 0);
        assert_eq!(mp4_moov_after_mdat(&f), None);
        assert_eq!(mp4_moov_after_mdat(b"\x1aE\xdf\xa3 matroska"), None);
    }

    fn seg(start: u64, pin: u64) -> Segment {
        let now = Instant::now();
        Segment {
            id: 1, kind: Kind::Play, start: Some(start), end: None, received: 0, chunks: BTreeMap::new(), retained: 0, pin,
            demand: start, touched: false, flow: true, live: true, hedged: false, created: now, first_byte: None,
            last_progress: now, last_read: now, abort: None,
        }
    }

    #[test]
    fn segment_slices_trims_and_paces() {
        let mut g = seg(1000, 100);
        for _ in 0..10 {
            g.insert(Bytes::from(vec![7u8; 100]));
        }
        assert_eq!(g.next(), Some(2000));
        assert_eq!(g.slice(1050, 1000).unwrap().len(), 50);
        assert!(g.slice(2000, 10).is_none() && g.slice(999, 10).is_none());
        // Untouched: paced by the pin only; touched: the read-ahead counts from the reader.
        assert_eq!(g.allowance(500), 1100);
        g.touched = true;
        g.demand = 1600;
        assert_eq!(g.allowance(500), 2100);
        // Trimming keeps the pin and BACK_KEEP behind the reader.
        g.demand = 1000 + 100 + BACK_KEEP + 500;
        g.trim_behind();
        assert!(g.has(1000), "pin kept");
        g.trim_to_pin();
        assert!(g.has(1099) && !g.has(1100));
        assert_eq!(g.retained, 100);
    }

    #[test]
    fn covered_until_spans_segments() {
        let mut st = State::default();
        let mut a = seg(0, 0);
        a.insert(Bytes::from(vec![0u8; 100]));
        let mut b = seg(100, 0);
        b.id = 2;
        b.insert(Bytes::from(vec![0u8; 50]));
        st.segments = vec![a, b];
        assert_eq!(st.covered_until(0), 150);
        assert_eq!(st.covered_until(20), 150);
        assert_eq!(st.covered_until(150), 150);
    }
}
