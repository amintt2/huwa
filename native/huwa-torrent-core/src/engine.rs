//! librqbit session wrapper: registry of streamed torrents, status, pause/resume/removal,
//! cache quota and persistence of Huwa's own per-torrent metadata.
//!
//! API surface used from librqbit 9.0.1 (verified against the sources):
//! - `Session::new_with_opts(PathBuf, SessionOptions) -> BoxFuture<Result<Arc<Session>>>`
//! - `Session::add_torrent(&Arc<Self>, AddTorrent, Option<AddTorrentOptions>)`; for magnets the
//!   future only resolves once the metadata is fetched from peers → spawned in the background.
//! - `Session::get(TorrentIdOrHash) -> Option<ManagedTorrentHandle>`, `pause`, `unpause`,
//!   `delete(id, delete_files)`, `update_only_files`, `with_torrents`, `stop`.
//! - `ManagedTorrent::{stats, name, info_hash, with_metadata, is_paused, stream(file_id)}`.

use std::{
    collections::{HashMap, HashSet},
    mem::ManuallyDrop,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use librqbit::{
    api::TorrentIdOrHash,
    dht::{DhtPersistenceConfig, Id20},
    limits::LimitsConfig,
    AddTorrent, AddTorrentOptions, ConnectionOptions, DhtSessionConfig, ManagedTorrent, PeerConnectionOptions, Session,
    SessionOptions, SessionPersistenceConfig, TorrentStatsState,
};

/// librqbit's `torrent_state::ManagedTorrentHandle` is not re-exported from the crate root.
pub type ManagedTorrentHandle = Arc<ManagedTorrent>;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tracing::{info, warn};

use crate::{
    cache,
    probe::{MetaCache, Probes},
    timeline::{StartTimeline, StartTimelineView, META_ENGINE, META_MAGNET, META_PROBE},
};

/// Session-wide configuration, sent by the Expo module at `initialize`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Root folder for everything we write (torrent data, session state, DHT table).
    pub data_dir: PathBuf,
    /// Upper bound of on-disk torrent data; least recently used torrents are evicted above it.
    #[serde(default = "default_cache_limit")]
    pub cache_limit_bytes: u64,
    /// Upload to other peers. Off by default: many jurisdictions treat uploading differently,
    /// and mobile data plans are small. Requires a session restart to change.
    #[serde(default)]
    pub seeding: bool,
    /// Max connected peers per torrent.
    #[serde(default)]
    pub max_peers: Option<usize>,
    #[serde(default)]
    pub download_bps: Option<u32>,
    #[serde(default)]
    pub upload_bps: Option<u32>,
    /// Extra trackers announced for every torrent (in addition to those from the magnet).
    #[serde(default)]
    pub default_trackers: Vec<String>,
    /// How long a stream request waits for magnet metadata before answering 504.
    #[serde(default = "default_resolve_timeout")]
    pub resolve_timeout_secs: u64,
    /// Serve the opening reads of a playback (header, container index, resume / seek target) from
    /// blocks written but not verified yet, instead of waiting for the whole piece's SHA-1: the
    /// player needs a few hundred KiB, a piece is 1–16 MiB. Integrity: a piece failing its check is
    /// downloaded again, but bytes already read stay read (a damaged frame, or a file the player
    /// cannot open; never data kept on disk). Only until the playback settles.
    /// On by default (`"unverifiedStart": false` turns it off).
    #[serde(default = "default_true")]
    pub unverified_start: bool,
}

fn default_cache_limit() -> u64 {
    5 * 1024 * 1024 * 1024
}
fn default_true() -> bool {
    true
}
fn default_resolve_timeout() -> u64 {
    90
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStreamRequest {
    /// 40 hex chars (BTv1 info hash), case-insensitive.
    pub info_hash: String,
    /// Index of the file inside the torrent. `None` → the largest video file once resolved.
    #[serde(default)]
    pub file_idx: Option<usize>,
    /// Stremio-style sources: `tracker:udp://…`, `dht:<hash>`; plain tracker URLs are accepted too.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Display name (from the addon) used until the metadata is known.
    #[serde(default)]
    pub name: Option<String>,
    /// Metered network (cellular): only a window ahead of the playhead is downloaded, never the
    /// whole file in the background (see `Engine::sync_selection`). Updated by every call.
    #[serde(default)]
    pub metered: bool,
}

/// librqbit file selection of a torrent (`Entry::selection`).
pub const SELECTION_UNKNOWN: u8 = 0;
/// Nothing selected: only the pieces covered by open `FileStream`s download (librqbit keeps
/// streaming unselected files). Used before the first bytes of a window arrive (no natural-order
/// fan-out competing with the head) and on metered networks (no background download).
pub const SELECTION_STREAMS_ONLY: u8 = 1;
/// The played file selected: the rest of it downloads in natural order after the windows.
pub const SELECTION_WHOLE_FILE: u8 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStreamResponse {
    pub id: String,
    pub url: String,
    pub info_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub idx: usize,
    pub name: String,
    pub size: u64,
    pub progress_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStatus {
    pub id: String,
    pub info_hash: String,
    pub name: Option<String>,
    /// `resolving` | `initializing` | `live` | `paused` | `finished` | `error`
    pub state: String,
    pub error: Option<String>,
    pub progress: f64,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub download_bps: u64,
    pub upload_bps: u64,
    pub peers_live: u32,
    pub peers_connecting: u32,
    pub peers_seen: u32,
    pub files: Vec<FileStatus>,
    pub selected_file: Option<usize>,
    pub url: String,
    pub active_streams: usize,
    pub added_at: u64,
    pub last_access: u64,
    pub size_on_disk: u64,
    /// Streaming health (see `streaming.rs`): `ok` | `searching` (no peer connected) | `stalled`
    /// (the player waits for data) | `recovering` (re-announce in progress) | `idle`.
    pub health: &'static str,
    /// Automatic recoveries (pause + resume re-announce) since the torrent was added this run.
    pub recoveries: u32,
    /// Timeline of the latest `startStream` of this torrent (see `timeline.rs`).
    pub start: StartTimelineView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStats {
    pub version: &'static str,
    pub port: u16,
    pub cache_limit_bytes: u64,
    pub cache_used_bytes: u64,
    pub evictions: EvictionStats,
    pub seeding: bool,
    pub torrents: Vec<TorrentStatus>,
}

/// What we persist about a torrent, next to librqbit's own session file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedEntry {
    info_hash: String,
    requested_file: Option<usize>,
    selected_file: Option<usize>,
    trackers: Vec<String>,
    name: Option<String>,
    added_at: u64,
    last_access: u64,
}

pub enum EntryState {
    Resolving,
    Ready(ManagedTorrentHandle),
    Failed(String),
}

pub struct Entry {
    pub id20: Id20,
    pub hex: String,
    pub requested_file: Option<usize>,
    pub trackers: Vec<String>,
    pub display_name: RwLock<Option<String>>,
    pub state: RwLock<EntryState>,
    pub selected_file: RwLock<Option<usize>>,
    pub ready: Notify,
    pub added_at: u64,
    pub last_access: AtomicU64,
    pub active_streams: AtomicUsize,
    /// Playback session state used by the priority policy.
    pub first_byte_sent: AtomicBool,
    pub last_served_end: AtomicU64,
    pub consecutive_waits: AtomicU64,
    /// Last `metered` flag sent by the app (`StartStreamRequest::metered`).
    pub metered: AtomicBool,
    /// What is selected in librqbit right now (`SELECTION_*`).
    pub selection: AtomicU8,
    /// Background magnet resolution (`start_stream`). Aborted and awaited by `remove`, so a torrent
    /// deleted while resolving cannot come back as an unlisted download.
    pub resolver: parking_lot::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// How the resolution was started (`timeline::META_*`): a magnet resolution still running when
    /// a probe has cached the metadata is restarted from it (see `start_stream`).
    pub resolving_from: AtomicU8,
    /// Where the time of the current start goes (see `timeline.rs`).
    pub timeline: StartTimeline,
    /// A pre-warm runs (`Engine::prewarm`): not parked by the monitor meanwhile.
    pub prewarming: AtomicBool,
    /// Peers that answered the probe (several: the container index is fetched with the head).
    pub answering: AtomicUsize,
}

impl Entry {
    pub fn touch(&self) {
        self.last_access.store(now_secs(), Ordering::Relaxed);
    }

    pub fn handle(&self) -> Option<ManagedTorrentHandle> {
        match &*self.state.read() {
            EntryState::Ready(h) => Some(h.clone()),
            _ => None,
        }
    }

    /// Waits until the magnet is resolved (or failed). `Err` carries the failure message.
    pub async fn wait_ready(&self, timeout: Duration) -> Result<ManagedTorrentHandle> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match &*self.state.read() {
                EntryState::Ready(h) => return Ok(h.clone()),
                EntryState::Failed(e) => return Err(anyhow!("{e}")),
                EntryState::Resolving => {}
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(anyhow!("timeout: metadata not resolved after {}s", timeout.as_secs()));
            }
            // `notify_one` stores a permit for the first waiter; other concurrent waiters would
            // miss a notification sent between the check above and this await, so the wait is
            // bounded to 250 ms and the state re-checked.
            let slice = remaining.min(Duration::from_millis(250));
            let _ = tokio::time::timeout(slice, self.ready.notified()).await;
        }
    }
}

/// The loopback HTTP server task (see `server::start`) and its graceful-stop signal.
pub struct ServerHandle {
    pub stop: tokio::sync::oneshot::Sender<()>,
    pub task: tokio::task::JoinHandle<()>,
}

pub struct Engine {
    /// Never dropped in place: the last `Arc<Engine>` may go away inside one of the runtime's own
    /// tasks (an HTTP connection ending after `shutdown`), where a blocking runtime drop panics.
    /// `Drop` uses `shutdown_background` instead.
    pub runtime: ManuallyDrop<tokio::runtime::Runtime>,
    pub session: Arc<Session>,
    config: RwLock<Config>,
    entries: RwLock<HashMap<String, Arc<Entry>>>,
    port: AtomicU64,
    torrents_dir: PathBuf,
    server: parking_lot::Mutex<Option<ServerHandle>>,
    /// Swarm probes (see `probe.rs`) and the metadata they resolved, reused by `start_stream`.
    pub probes: Probes,
    pub meta_cache: MetaCache,
    /// Read-ahead walkers, playhead / stall tracking and recovery state (see `streaming.rs`).
    pub streaming: crate::streaming::Streaming,
    /// Janitor and streaming monitor: they upgrade a `Weak<Engine>` on every tick, so `shutdown`
    /// aborts and awaits them (otherwise a tick could still hold the engine afterwards).
    background: parking_lot::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Torrent of the latest `start_stream` (the one on screen). The others are parked by the
    /// streaming monitor once their player left (see `park`): rapid switching never leaves old
    /// torrents downloading against the new start.
    focus: RwLock<Option<String>>,
    /// Cache evictions done by `enforce_quota` (count, bytes, time), for `stats`.
    evictions: parking_lot::Mutex<EvictionStats>,
}

/// Head bytes fetched by a pre-warm (at least two pieces): what a player reads before frame 1.
pub const PREWARM_HEAD_BYTES: u64 = 2 * 1024 * 1024;
/// At most this much head is pre-warmed (MKV font attachments included).
pub const PREWARM_HEAD_MAX: u64 = 48 * 1024 * 1024;
/// A pre-warm gives up (and parks the torrent) after this long.
pub const PREWARM_BUDGET: Duration = Duration::from_secs(60);

/// Free space kept under the cache quota by the janitor (at most a tenth of the quota), so a new
/// stream never waits for an eviction.
pub const CACHE_HEADROOM: u64 = 512 * 1024 * 1024;
/// Quota pass interval (in-memory accounting: a few `stats()` calls). The first pass runs one
/// interval after launch: the first start of a session goes first.
pub const QUOTA_TICK: Duration = Duration::from_secs(15);
/// No eviction this long after a start.
pub const START_QUIET: Duration = Duration::from_secs(10);
/// A torrent touched this recently is never evicted (a return to it may be under way).
pub const EVICT_MIN_IDLE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictionStats {
    pub count: u32,
    pub bytes: u64,
    pub total_ms: u64,
    pub max_ms: u64,
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: taken exactly once, here; the field is never used afterwards.
        let runtime = unsafe { ManuallyDrop::take(&mut self.runtime) };
        runtime.shutdown_background();
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn normalize_hash(s: &str) -> Result<(Id20, String)> {
    let s = s.trim();
    let s = s.strip_prefix("magnet:?xt=urn:btih:").unwrap_or(s);
    let id: Id20 = s.parse().map_err(|e| anyhow!("invalid info hash {s:?}: {e}"))?;
    Ok((id, id.as_string().to_lowercase()))
}

/// `tracker:udp://x` → `udp://x`; `dht:<hash>` → dropped (DHT is always on); plain URLs pass.
pub fn trackers_from_sources(sources: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in sources {
        let s = s.trim();
        let url = s.strip_prefix("tracker:").unwrap_or(s);
        if url.starts_with("dht:") || url.is_empty() {
            continue;
        }
        if (url.starts_with("udp://") || url.starts_with("http://") || url.starts_with("https://") || url.starts_with("wss://"))
            && !out.iter().any(|o| o == url)
        {
            out.push(url.to_string());
        }
    }
    out
}

pub fn build_magnet(hex: &str, trackers: &[String], name: Option<&str>) -> String {
    let mut m = format!("magnet:?xt=urn:btih:{hex}");
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        m.push_str("&dn=");
        m.push_str(&urlencoding::encode(n));
    }
    for t in trackers {
        m.push_str("&tr=");
        m.push_str(&urlencoding::encode(t));
    }
    m
}

/// Video containers (mpv plays every one; the JS engine policy maps each to AVPlayer or mpv from
/// the extension carried by the stream URL, see `src/components/player/engines/policy.ts`).
const VIDEO_EXT: &[&str] = &[
    "mkv", "mk3d", "mp4", "m4v", "mov", "webm", "avi", "divx", "xvid", "ts", "m2ts", "mts", "m2t", "wmv", "asf", "flv", "f4v",
    "mpg", "mpeg", "m2v", "vob", "evo", "ogm", "ogv", "rmvb", "rm", "3gp",
];

/// Extensions that are never the video of a torrent: subtitles, pictures, text, archives (RAR'd
/// releases cannot be streamed), separate audio tracks, disc images (no ISO reader over HTTP),
/// executables. Anything else without a video extension (no extension, `.bin`, a typo) may still
/// be the video: the largest such file is the fallback, and mpv recognizes it from its bytes.
const NOT_VIDEO_EXT: &[&str] = &[
    "srt", "ass", "ssa", "sub", "idx", "sup", "vtt", "smi", "ttf", "otf", "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif",
    "nfo", "txt", "md", "sfv", "md5", "sha1", "sha256", "url", "htm", "html", "log", "cue", "xml", "json", "pdf", "epub",
    "rar", "zip", "7z", "tar", "gz", "bz2", "xz", "par2", "torrent", "exe", "dll", "msi", "dmg", "apk", "lnk", "db",
    "iso", "img", "nrg", "mdf", "mds", "flac", "mp3", "aac", "m4a", "ogg", "opus", "wav", "ac3", "eac3", "dts", "thd", "mka",
];

fn ext_of(name: &str) -> Option<String> {
    Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase)
}

/// Not a video for sure (see `NOT_VIDEO_EXT`; split archives `.r00`… `.r99` and `.001` too).
pub fn is_junk_name(name: &str) -> bool {
    let Some(ext) = ext_of(name) else { return false };
    NOT_VIDEO_EXT.contains(&ext.as_str())
        || (ext.len() == 3 && ext.starts_with('r') && ext[1..].bytes().all(|c| c.is_ascii_digit()))
        || (ext.len() == 3 && ext.bytes().all(|c| c.is_ascii_digit()))
}

/// Sample, trailer, creditless opening / ending (NCOP / NCED, `OP1`), menu, preview… : a video
/// that comes with the episode, not the episode. Matched on whole words of the path.
pub fn is_extra_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let numbered = |w: &str, p: &str| w.strip_prefix(p).is_some_and(|rest| rest.len() <= 3 && rest.bytes().all(|c| c.is_ascii_alphanumeric()) && rest.bytes().next().is_none_or(|c| c.is_ascii_digit()));
    words.iter().any(|w| {
        matches!(
            *w,
            "sample" | "samples" | "trailer" | "trailers" | "teaser" | "creditless" | "menu" | "menus" | "preview" | "previews"
                | "featurette" | "featurettes" | "extras" | "bonus" | "pv" | "cm" | "cms"
        ) || numbered(w, "ncop")
            || numbered(w, "nced")
            || (w.len() > 2 && (numbered(w, "op") || numbered(w, "ed")) && w[2..].bytes().all(|c| c.is_ascii_digit()))
    })
}

/// Lower-case video extension of a file name (one of `VIDEO_EXT`), for the stream URL.
pub fn video_ext(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    VIDEO_EXT.iter().copied().find(|e| *e == ext)
}

/// Extension of file `idx` of a resolved torrent.
pub fn file_ext_of(handle: &ManagedTorrentHandle, idx: usize) -> Option<&'static str> {
    handle
        .with_metadata(|m| m.file_infos.get(idx).and_then(|f| video_ext(&f.relative_filename.to_string_lossy())))
        .ok()
        .flatten()
}

pub fn url_of(port: u16, hex: &str, file: Option<usize>, ext: Option<&str>) -> String {
    let file = file.map_or_else(|| "auto".to_string(), |i| i.to_string());
    match ext {
        Some(e) => format!("http://127.0.0.1:{port}/{hex}/{file}.{e}"),
        None => format!("http://127.0.0.1:{port}/{hex}/{file}"),
    }
}

pub fn is_video_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Whether the played file is fully downloaded (`None` when unknown).
pub fn selected_file_complete(file_progress: &[u64], handle: &ManagedTorrentHandle, file: Option<usize>) -> Option<bool> {
    let i = file?;
    let len = handle.with_metadata(|m| m.file_infos.get(i).map(|f| f.len)).ok().flatten()?;
    Some(file_progress.get(i).copied().unwrap_or(0) >= len)
}

/// Files that may be the video, best first in kind: named videos that are not extras, then any
/// named video, then files with no / an unknown extension (decided by size; mpv sniffs the bytes).
pub fn video_candidates(files: &[(String, u64)]) -> Vec<usize> {
    let all = 0..files.len();
    let main: Vec<usize> = all.clone().filter(|&i| is_video_name(&files[i].0) && !is_extra_name(&files[i].0)).collect();
    if !main.is_empty() {
        return main;
    }
    let videos: Vec<usize> = all.clone().filter(|&i| is_video_name(&files[i].0)).collect();
    if !videos.is_empty() {
        return videos;
    }
    all.filter(|&i| !is_junk_name(&files[i].0) && !is_extra_name(&files[i].0)).collect()
}

/// Picks the largest video file (samples, trailers, NCOP/NCED and other extras last), else the
/// largest file that is not known to be something else (no extension, unknown extension). None
/// when the torrent holds no possible video (archives, ISO, subtitles only…).
pub fn pick_file(files: &[(String, u64)]) -> Option<usize> {
    video_candidates(files).into_iter().max_by_key(|&i| files[i].1)
}

impl Engine {
    pub fn new(config: Config) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&config.data_dir).with_context(|| format!("creating {:?}", config.data_dir))?;
        let torrents_dir = config.data_dir.join("torrents");
        let session_dir = config.data_dir.join("session");
        std::fs::create_dir_all(&torrents_dir)?;
        std::fs::create_dir_all(&session_dir)?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("huwa-torrent")
            .enable_all()
            .build()
            .context("tokio runtime")?;

        let opts = SessionOptions {
            dht: Some(DhtSessionConfig {
                bootstrap_addrs: Some(crate::streaming::DHT_BOOTSTRAP.iter().map(|s| s.to_string()).collect()),
                port: None,
                persistence: Some(DhtPersistenceConfig {
                    dump_interval: Some(crate::streaming::DHT_DUMP_INTERVAL),
                    config_filename: Some(config.data_dir.join("dht.json")),
                }),
            }),
            // Mobile tuning, see `streaming.rs` for the reasons.
            connect: Some(ConnectionOptions {
                peer_opts: Some(PeerConnectionOptions {
                    connect_timeout: Some(crate::streaming::PEER_CONNECT_TIMEOUT),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            runtime_worker_threads: Some(crate::streaming::BLOCKING_PERMITS),
            disable_trackers: false,
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json { folder: Some(session_dir) }),
            // No listener: mobile devices are rarely reachable, and it keeps the surface small.
            listen: None,
            ratelimits: LimitsConfig {
                download_bps: config.download_bps.and_then(std::num::NonZeroU32::new),
                upload_bps: config.upload_bps.and_then(std::num::NonZeroU32::new),
            },
            trackers: config
                .default_trackers
                .iter()
                .filter_map(|t| url::Url::parse(t).ok())
                .collect::<HashSet<_>>(),
            peer_limit: config.max_peers,
            disable_upload: !config.seeding,
            disable_local_service_discovery: true,
            client_name_and_version: Some(format!("huwa {}", crate::VERSION)),
            ..Default::default()
        };

        let session = runtime
            .block_on(Session::new_with_opts(torrents_dir.clone(), opts))
            .context("creating librqbit session")?;

        let engine = Arc::new(Self {
            runtime: ManuallyDrop::new(runtime),
            session,
            config: RwLock::new(config),
            entries: RwLock::new(HashMap::new()),
            port: AtomicU64::new(0),
            torrents_dir,
            server: parking_lot::Mutex::new(None),
            probes: Probes::default(),
            meta_cache: MetaCache::default(),
            streaming: Default::default(),
            background: parking_lot::Mutex::new(Vec::new()),
            focus: RwLock::new(None),
            evictions: Default::default(),
        });
        engine.streaming.unverified_start.store(engine.config.read().unverified_start, Ordering::Relaxed);
        engine.restore_entries();
        let janitor = engine.spawn_janitor();
        let monitor = crate::streaming::spawn_monitor(&engine);
        engine.background.lock().extend([janitor, monitor]);
        Ok(engine)
    }

    /// Trackers announced for a torrent (stream start and probes alike, see `trackers::for_torrent`).
    pub fn torrent_trackers(&self, sources: &[String]) -> Vec<String> {
        crate::trackers::for_torrent(sources, !self.config.read().default_trackers.is_empty())
    }

    pub fn config(&self) -> Config {
        self.config.read().clone()
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed) as u16
    }

    pub fn set_port(&self, port: u16) {
        self.port.store(port as u64, Ordering::Relaxed);
    }

    /// Called by `server::start`; `shutdown` stops and awaits it.
    pub fn set_server(&self, server: ServerHandle) {
        if let Some(old) = self.server.lock().replace(server) {
            let _ = old.stop.send(());
            old.task.abort();
        }
    }

    /// `http://127.0.0.1:<port>/<hash>/<file>[.<ext>]`: the extension (when the file is known)
    /// tells the app's player policy the container without a request (see `server::parse_file`).
    pub fn url_for(&self, hex: &str, file: Option<usize>, ext: Option<&str>) -> String {
        url_of(self.port(), hex, file, ext)
    }

    pub fn entry(&self, hex: &str) -> Option<Arc<Entry>> {
        self.entries.read().get(hex).cloned()
    }

    pub fn entries(&self) -> Vec<Arc<Entry>> {
        let mut v: Vec<_> = self.entries.read().values().cloned().collect();
        v.sort_by_key(|e| std::cmp::Reverse(e.added_at));
        v
    }

    fn entries_file(&self) -> PathBuf {
        self.config.read().data_dir.join("huwa-entries.json")
    }

    fn persist_entries(&self) {
        let list: Vec<PersistedEntry> = self
            .entries
            .read()
            .values()
            .map(|e| PersistedEntry {
                info_hash: e.hex.clone(),
                requested_file: e.requested_file,
                selected_file: *e.selected_file.read(),
                trackers: e.trackers.clone(),
                name: e.display_name.read().clone(),
                added_at: e.added_at,
                last_access: e.last_access.load(Ordering::Relaxed),
            })
            .collect();
        let path = self.entries_file();
        let tmp = path.with_extension("json.tmp");
        let res = serde_json::to_vec(&list)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| std::fs::write(&tmp, bytes).map_err(Into::into))
            .and_then(|_| std::fs::rename(&tmp, &path).map_err(Into::into));
        if let Err(e) = res {
            warn!("persisting entries failed: {e:#}");
        }
    }

    /// Re-attach torrents restored by librqbit's session persistence to our registry.
    fn restore_entries(self: &Arc<Self>) {
        let persisted: HashMap<String, PersistedEntry> = std::fs::read(self.entries_file())
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<PersistedEntry>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.info_hash.clone(), p))
            .collect();

        let handles: Vec<ManagedTorrentHandle> = self.session.with_torrents(|it| it.map(|(_, h)| h.clone()).collect());
        let mut map = self.entries.write();
        for h in handles {
            let hex = h.info_hash().as_string().to_lowercase();
            let p = persisted.get(&hex);
            let entry = Arc::new(Entry {
                id20: h.info_hash(),
                hex: hex.clone(),
                requested_file: p.and_then(|p| p.requested_file),
                trackers: p.map(|p| p.trackers.clone()).unwrap_or_default(),
                display_name: RwLock::new(p.and_then(|p| p.name.clone()).or_else(|| h.name())),
                state: RwLock::new(EntryState::Ready(h.clone())),
                selected_file: RwLock::new(p.and_then(|p| p.selected_file).or_else(|| h.only_files().and_then(|f| f.first().copied()))),
                ready: Notify::new(),
                added_at: p.map(|p| p.added_at).unwrap_or_else(now_secs),
                last_access: AtomicU64::new(p.map(|p| p.last_access).unwrap_or_else(now_secs)),
                active_streams: AtomicUsize::new(0),
                first_byte_sent: AtomicBool::new(false),
                last_served_end: AtomicU64::new(0),
                consecutive_waits: AtomicU64::new(0),
                metered: AtomicBool::new(false),
                selection: AtomicU8::new(SELECTION_UNKNOWN),
                resolver: parking_lot::Mutex::new(None),
                resolving_from: AtomicU8::new(META_ENGINE),
                timeline: StartTimeline::default(),
                prewarming: AtomicBool::new(false),
                answering: AtomicUsize::new(0),
            });
            map.insert(hex, entry);
        }
        info!("restored {} torrent(s)", map.len());
    }

    /// Periodic cache-quota enforcement (every `QUOTA_TICK`, cheap: in-memory accounting) and
    /// persistence (every minute), in the background, never while a stream starts.
    fn spawn_janitor(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(self);
        self.runtime.spawn(async move {
            let mut ticks = 0u32;
            loop {
                tokio::time::sleep(QUOTA_TICK).await;
                ticks += 1;
                let Some(engine) = weak.upgrade() else { return };
                // Never while a stream is starting (deletes compete for the disk with the first
                // pieces): the headroom leaves room enough to wait for the next pass.
                if !engine.starting_now() {
                    if let Err(e) = engine.enforce_quota().await {
                        warn!("quota enforcement failed: {e:#}");
                    }
                }
                if ticks % 4 == 0 {
                    engine.persist_entries();
                }
            }
        })
    }

    /// Registers the torrent (if new), starts the magnet resolution in the background and
    /// returns the loopback URL immediately. The HTTP handler waits for readiness.
    pub fn start_stream(self: &Arc<Self>, req: StartStreamRequest) -> Result<StartStreamResponse> {
        self.start_inner(req, true)
    }

    /// Pre-warm (Wi-Fi, before the tap): the first pieces of the file and its container index are
    /// fetched for a torrent the app expects to play (`prewarm` API), then the torrent is parked.
    /// The tap's `start_stream` then finds them on disk: the first frame needs no download. Never
    /// the focus (the torrent on screen keeps it); cancelled by `release`. A few MiB at most: the
    /// head stream's look-ahead is narrowed to the head itself.
    pub fn prewarm(self: &Arc<Self>, req: StartStreamRequest) -> Result<StartStreamResponse> {
        let (_, hex) = normalize_hash(&req.info_hash)?;
        if let Some(e) = self.entry(&hex) {
            // Being played (or pre-warmed) right now: nothing to add, and nothing to disturb.
            let busy = self.focus().as_deref() == Some(hex.as_str())
                || e.active_streams.load(Ordering::Relaxed) > 0
                || e.prewarming.load(Ordering::Acquire);
            if busy {
                let file = *e.selected_file.read();
                let ext = e.handle().and_then(|h| file.and_then(|i| file_ext_of(&h, i)));
                return Ok(StartStreamResponse { id: hex.clone(), url: self.url_for(&hex, file, ext), info_hash: hex });
            }
        }
        let resp = self.start_inner(req, false)?;
        let entry = self.entry(&resp.info_hash).context("unknown torrent")?;
        if entry.prewarming.swap(true, Ordering::AcqRel) {
            return Ok(resp);
        }
        let engine = self.clone();
        self.runtime.spawn(async move {
            let job = async {
                let h = entry.wait_ready(PREWARM_BUDGET).await?;
                h.wait_until_initialized().await?;
                if h.is_paused() {
                    engine.session.unpause(&h).await?;
                }
                let file = (*entry.selected_file.read()).context("no file")?;
                let g = crate::streaming::Geometry::of(&h, file).context("no geometry")?;
                let name = h
                    .with_metadata(|m| m.file_infos.get(file).map(|f| f.relative_filename.to_string_lossy().into_owned()))
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let unverified = engine.config().unverified_start;
                // An MKV's opening reads run to its first cluster: past the font attachments of a
                // fansub release (often several MiB, all read before frame 1).
                let mut head_end = PREWARM_HEAD_BYTES.max(2 * g.piece_len).min(g.file_len);
                if crate::server::container_index(&name) == crate::priorities::ContainerIndex::MatroskaTail {
                    if let Ok(first) = crate::streaming::read_head(h.clone(), file, crate::priorities::INDEX_HEAD_BYTES.min(g.file_len), unverified).await {
                        if let Some(cluster) = crate::priorities::mkv_first_cluster(&first) {
                            head_end = head_end.max(cluster + PREWARM_HEAD_BYTES / 4).min(PREWARM_HEAD_MAX).min(g.file_len);
                        }
                    }
                }
                let (tail, _) = crate::priorities::startup_tail_plan(crate::server::container_index(&name), g.file_len, g.piece_len);
                let head = crate::streaming::fetch_region(h.clone(), file, g, 0, head_end, unverified);
                let tail_job = async {
                    if tail > 0 && g.file_len - tail > head_end {
                        crate::streaming::fetch_region(h.clone(), file, g, g.file_len - tail, g.file_len, unverified).await
                    } else {
                        Ok(())
                    }
                };
                // Once both streams are registered, nothing else is selected: only they download.
                let deselect = async {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    engine.sync_selection(&entry, &h, false).await;
                };
                let (a, b, ()) = tokio::join!(head, tail_job, deselect);
                a.and(b)
            };
            let res = tokio::time::timeout(PREWARM_BUDGET, job).await;
            entry.prewarming.store(false, Ordering::Release);
            match res {
                Ok(Ok(())) => info!(hex = %entry.hex, "pre-warm done"),
                Ok(Err(e)) => warn!(hex = %entry.hex, "pre-warm failed: {e:#}"),
                Err(_) => info!(hex = %entry.hex, "pre-warm timed out"),
            }
            if engine.focus().as_deref() != Some(entry.hex.as_str()) {
                engine.park(&entry);
            }
        });
        Ok(resp)
    }

    fn start_inner(self: &Arc<Self>, req: StartStreamRequest, focus: bool) -> Result<StartStreamResponse> {
        let (id20, hex) = normalize_hash(&req.info_hash)?;
        let trackers = self.torrent_trackers(&req.sources);
        if focus {
            let previous = self.focus.write().replace(hex.clone());
            if previous.as_deref() != Some(hex.as_str()) {
                self.background_others(&hex);
            }
        }

        if let Some(existing) = self.entry(&hex) {
            existing.touch();
            if let Some(m) = self.meta_cache.get(&hex, std::time::Instant::now()) {
                existing.answering.store(m.answering, Ordering::Relaxed);
            }
            existing.metered.store(req.metered, Ordering::Relaxed);
            if let Some(name) = req.name.as_ref() {
                if existing.display_name.read().is_none() {
                    *existing.display_name.write() = Some(name.clone());
                }
            }
            // A previously failed resolution is retried.
            let failed = matches!(&*existing.state.read(), EntryState::Failed(_));
            // A magnet resolution still running (cold DHT, the probe had not answered yet when it
            // started) while the probe has the metadata by now: it is restarted from that metadata
            // instead of keeping the player on the magnet (the URL came back at once and nothing
            // ever played: one of the `timeout` starts).
            let stuck = matches!(&*existing.state.read(), EntryState::Resolving)
                && existing.resolving_from.load(Ordering::Relaxed) == META_MAGNET
                && self.meta_cache.get(&hex, std::time::Instant::now()).is_some();
            if failed {
                self.entries.write().remove(&hex);
            } else if stuck {
                info!(hex = %hex, "magnet still resolving, restarting from the probe's metadata");
                let _ = self.runtime.block_on(self.remove(&hex));
            } else {
                existing.timeline.begin();
                if let Some(h) = existing.handle() {
                    existing.timeline.mark_meta(META_ENGINE);
                    // Another episode of a season pack already in the engine: that file is the one
                    // to select (and to report the first piece of).
                    let files = h.with_metadata(|m| m.file_infos.len()).unwrap_or(0);
                    if let Some(i) = req.file_idx.filter(|i| *i < files) {
                        if *existing.selected_file.read() != Some(i) {
                            *existing.selected_file.write() = Some(i);
                            existing.selection.store(SELECTION_UNKNOWN, Ordering::Release);
                        }
                    }
                    if h.is_paused() {
                        let session = self.session.clone();
                        let h2 = h.clone();
                        self.runtime.spawn(async move {
                            if let Err(e) = session.unpause(&h2).await {
                                warn!("unpause failed: {e:#}");
                            }
                        });
                    }
                    // Played before: if the selection was left empty (metered network, parked, or
                    // the previous playback ended before its window settled), librqbit has dropped
                    // the seeders as "not needed" and only re-dials them when the selection grows.
                    // The player's first request narrows it again (see `sync_selection`). In the
                    // background: the URL goes back at once (this used to block the call up to 2 s,
                    // and every other engine call queued behind it on the app's module queue).
                    let (engine, entry, h) = (self.clone(), existing.clone(), h.clone());
                    self.runtime.spawn(async move {
                        if tokio::time::timeout(Duration::from_secs(2), engine.sync_selection(&entry, &h, true)).await.is_err() {
                            warn!(hex = %entry.hex, "re-selecting the played file timed out");
                        }
                    });
                }
                self.spawn_start_watcher(&existing);
                let file = req.file_idx.or(*existing.selected_file.read());
                let ext = existing.handle().and_then(|h| file.and_then(|i| file_ext_of(&h, i)));
                return Ok(StartStreamResponse { id: hex.clone(), url: self.url_for(&hex, file, ext), info_hash: hex });
            }
        }

        // Probed a moment ago (torrent race): no magnet resolution, the peers that answered the
        // probe are dialled first, and only the wanted file is allocated.
        let probed = self.meta_cache.get(&hex, std::time::Instant::now());
        let max_peers = self.config.read().max_peers;
        // The file is known with the probe's metadata: the URL carries its extension, so the app
        // picks the player (mpv for MKV) without sniffing a torrent that has no byte yet.
        let probed_file = probed.as_ref().and_then(|m| req.file_idx.filter(|i| *i < m.files.len()).or_else(|| pick_file(&m.files)));
        let url_ext = probed.as_ref().zip(probed_file).and_then(|(m, i)| m.files.get(i)).and_then(|(n, _)| video_ext(n));

        let entry = Arc::new(Entry {
            id20,
            hex: hex.clone(),
            requested_file: req.file_idx,
            trackers: trackers.clone(),
            display_name: RwLock::new(req.name.clone()),
            state: RwLock::new(EntryState::Resolving),
            selected_file: RwLock::new(req.file_idx),
            ready: Notify::new(),
            added_at: now_secs(),
            last_access: AtomicU64::new(now_secs()),
            active_streams: AtomicUsize::new(0),
            first_byte_sent: AtomicBool::new(false),
            last_served_end: AtomicU64::new(0),
            consecutive_waits: AtomicU64::new(0),
            metered: AtomicBool::new(req.metered),
            selection: AtomicU8::new(SELECTION_UNKNOWN),
            resolver: parking_lot::Mutex::new(None),
            resolving_from: AtomicU8::new(if probed.is_some() { META_PROBE } else { META_MAGNET }),
            timeline: StartTimeline::default(),
            prewarming: AtomicBool::new(false),
            answering: AtomicUsize::new(0),
        });
        entry.timeline.begin();
        if let Some(m) = &probed {
            entry.answering.store(m.answering, Ordering::Relaxed);
        }
        match &probed {
            Some(m) => entry.timeline.set_swarm_setup(m.peers.len(), crate::streaming::peer_limit_for(m.swarm, max_peers)),
            None => entry.timeline.set_swarm_setup(0, max_peers),
        }
        self.entries.write().insert(hex.clone(), entry.clone());
        self.persist_entries();

        let engine = self.clone();
        let magnet = build_magnet(&hex, &trackers, req.name.as_deref());
        let task_entry = entry.clone();
        let task = self.runtime.spawn(async move {
            let entry = task_entry;
            let mut opts = AddTorrentOptions {
                overwrite: true,
                trackers: if trackers.is_empty() { None } else { Some(trackers.clone()) },
                ..Default::default()
            };
            let from = if probed.is_some() { META_PROBE } else { META_MAGNET };
            let add = match probed {
                Some(m) => {
                    opts.only_files = probed_file.map(|i| vec![i]);
                    opts.peer_limit = crate::streaming::peer_limit_for(m.swarm, max_peers);
                    if !m.peers.is_empty() {
                        opts.initial_peers = Some(m.peers.clone());
                    }
                    AddTorrent::from_bytes(m.torrent_bytes)
                }
                None => AddTorrent::from_url(magnet),
            };
            let result = engine.session.add_torrent(add, Some(opts)).await;
            match result {
                Ok(resp) => match resp.into_handle() {
                    // Removed while resolving (normally aborted before this point, see `remove`):
                    // the late torrent is deleted instead of downloading unlisted.
                    Some(handle) if !engine.owns(&entry) => {
                        engine.discard_late(&entry, &handle).await;
                        return;
                    }
                    Some(handle) => {
                        // Select the requested file (or the largest video) so only it is downloaded.
                        let files: Vec<(String, u64)> = handle
                            .with_metadata(|m| {
                                m.file_infos
                                    .iter()
                                    .map(|f| (f.relative_filename.to_string_lossy().into_owned(), f.len))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let selected = entry
                            .requested_file
                            .filter(|i| *i < files.len())
                            .or_else(|| pick_file(&files));
                        // Selected until the player's first request opens its stream: the peers
                        // connected meanwhile stay interested (an empty selection would make librqbit
                        // drop the seeders before the stream exists). `sync_selection` narrows it then.
                        if let Some(i) = selected {
                            match engine.session.update_only_files(&handle, &HashSet::from([i])).await {
                                Ok(()) => entry.selection.store(SELECTION_WHOLE_FILE, Ordering::Relaxed),
                                Err(e) => warn!("update_only_files failed: {e:#}"),
                            }
                        }
                        *entry.selected_file.write() = selected;
                        if entry.display_name.read().is_none() {
                            *entry.display_name.write() = handle.name();
                        }
                        // Ownership re-checked under the registry lock: `remove` takes the write
                        // lock, so it either sees `Ready` (and deletes the handle) or we see it gone.
                        let adopted = {
                            let map = engine.entries.read();
                            let owned = map.get(&entry.hex).is_some_and(|e| Arc::ptr_eq(e, &entry));
                            if owned {
                                *entry.state.write() = EntryState::Ready(handle.clone());
                            }
                            owned
                        };
                        if !adopted {
                            engine.discard_late(&entry, &handle).await;
                            return;
                        }
                        entry.timeline.mark_meta(from);
                    }
                    None => {
                        *entry.state.write() = EntryState::Failed("torrent added in list-only mode".into());
                    }
                },
                Err(e) => {
                    warn!("add_torrent failed: {e:#}");
                    *entry.state.write() = EntryState::Failed(format!("{e:#}"));
                }
            }
            entry.ready.notify_waiters();
            entry.ready.notify_one();
            engine.persist_entries();
            // No eviction here (it used to run right now, during the first player requests, with a
            // directory walk): the janitor keeps `CACHE_HEADROOM` free ahead of time.
        });
        *entry.resolver.lock() = Some(task);
        self.spawn_start_watcher(&entry);

        let file = if url_ext.is_some() { probed_file } else { req.file_idx };
        Ok(StartStreamResponse { id: hex.clone(), url: self.url_for(&hex, file, url_ext), info_hash: hex })
    }

    /// Fills the startup marks librqbit has no callback for (first connected peer, first piece of
    /// the played file, piece size) by polling the torrent every 100 ms until they are known, the
    /// first byte was served, a new start begins, or 90 s passed. Cheap: one `stats()` per tick,
    /// for one torrent, only during a start.
    pub fn spawn_start_watcher(self: &Arc<Self>, entry: &Arc<Entry>) {
        if !entry.timeline.try_start_watching() {
            return;
        }
        // Weak references only: a removed torrent or a stopped engine is never kept alive by it.
        let weak = Arc::downgrade(self);
        let weak_entry = Arc::downgrade(entry);
        let epoch = entry.timeline.epoch();
        self.runtime.spawn(async move {
            const WATCH_FOR: Duration = Duration::from_secs(90);
            let mut deadline = tokio::time::Instant::now() + WATCH_FOR;
            let mut epoch = epoch;
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let (Some(engine), Some(entry)) = (weak.upgrade(), weak_entry.upgrade()) else { return };
                let t = &entry.timeline;
                if t.epoch() != epoch {
                    // A new start of the same torrent: same watcher, new marks, new budget.
                    epoch = t.epoch();
                    deadline = tokio::time::Instant::now() + WATCH_FOR;
                }
                let done = !engine.owns(&entry)
                    || tokio::time::Instant::now() >= deadline
                    || (t.has_first_peer() && t.has_first_piece() && t.has_first_byte());
                if done {
                    t.stop_watching();
                    return;
                }
                let Some(handle) = entry.handle() else { continue };
                let stats = handle.stats();
                if stats.live.as_ref().is_some_and(|l| l.snapshot.peer_stats.live > 0) {
                    t.mark_first_peer();
                }
                let file = *entry.selected_file.read();
                if let Some(g) = file.and_then(|i| crate::streaming::Geometry::of(&handle, i)) {
                    t.set_piece_len(g.piece_len);
                }
                if file.and_then(|i| stats.file_progress.get(i).copied()).unwrap_or(0) > 0 {
                    t.mark_first_piece();
                }
            }
        });
    }

    pub fn focus(&self) -> Option<String> {
        self.focus.read().clone()
    }

    /// The focused torrent started less than `START_QUIET` ago (its first pieces are coming in).
    pub fn starting_now(&self) -> bool {
        let Some(e) = self.focus().and_then(|h| self.entry(&h)) else { return false };
        let since = crate::timeline::epoch_ms().saturating_sub(e.timeline.started_at_ms());
        since < START_QUIET.as_millis() as u64
    }

    /// A new torrent took the focus: the others stop their natural-order download at once (only
    /// what an open player response still reads continues: a next-episode prefetch started while
    /// one plays). Parking (peers, announces) follows once their player left (`park`).
    fn background_others(self: &Arc<Self>, focus: &str) {
        for e in self.entries() {
            if e.hex == focus || e.selection.load(Ordering::Acquire) != SELECTION_WHOLE_FILE {
                continue;
            }
            let Some(h) = e.handle() else { continue };
            let engine = self.clone();
            self.runtime.spawn(async move { engine.sync_selection(&e, &h, false).await });
        }
    }

    /// The app left this torrent's player (`release` API call): parked at once, and no longer the
    /// focus. A later `start_stream` brings it back (unpause, selection, the probe's peers).
    /// `decided_at` (ms since the Unix epoch, the app's clock): a start of this torrent after that
    /// moment wins (the release of a screen that was left arrived after the next screen started
    /// the same torrent: same pack, next-episode prefetch, pre-warm taken over by the tap).
    pub fn release(self: &Arc<Self>, hex: &str, decided_at: Option<u64>) -> Result<bool> {
        let entry = self.entry(hex).context("unknown torrent")?;
        if decided_at.is_some_and(|at| entry.timeline.started_at_ms() > at) {
            return Ok(false);
        }
        {
            let mut focus = self.focus.write();
            if focus.as_deref() == Some(hex) {
                *focus = None;
            }
        }
        self.park(&entry);
        Ok(true)
    }

    /// Stops everything a torrent runs for a player that left: playback (walker, anchor, tail
    /// prefetch, open responses), selection (nothing), and the torrent itself (paused: peers
    /// disconnected, no announce). Non-blocking; pieces on disk and the probe metadata stay, so a
    /// return to it starts like the first time. No-op for a paused torrent.
    pub fn park(self: &Arc<Self>, entry: &Arc<Entry>) {
        self.streaming.release(&entry.hex);
        let Some(handle) = entry.handle() else { return };
        if handle.is_paused() {
            return;
        }
        info!(hex = %entry.hex, "parking a torrent the player left");
        let (engine, entry) = (self.clone(), entry.clone());
        self.runtime.spawn(async move {
            // Another start of this torrent meanwhile: leave it alone.
            if engine.focus().as_deref() == Some(entry.hex.as_str()) {
                return;
            }
            engine.sync_selection(&entry, &handle, false).await;
            if engine.focus().as_deref() == Some(entry.hex.as_str()) || entry.active_streams.load(Ordering::Relaxed) > 0 {
                return;
            }
            if let Err(e) = engine.session.pause(&handle).await {
                warn!("parking pause failed: {e:#}");
            }
        });
    }

    /// Selects the played file in librqbit (`whole_file`) or nothing (only the open streams'
    /// windows download). Called by the HTTP server for every request and by the streaming monitor
    /// once a window has its first bytes. No-op when already in that state.
    pub async fn sync_selection(&self, entry: &Entry, handle: &ManagedTorrentHandle, whole_file: bool) {
        let want = if whole_file { SELECTION_WHOLE_FILE } else { SELECTION_STREAMS_ONLY };
        if entry.selection.load(Ordering::Acquire) == want {
            return;
        }
        let Some(file) = *entry.selected_file.read() else { return };
        let set = if whole_file { HashSet::from([file]) } else { HashSet::new() };
        match self.session.update_only_files(handle, &set).await {
            Ok(()) => entry.selection.store(want, Ordering::Release),
            Err(e) => warn!("update_only_files({set:?}) failed: {e:#}"),
        }
    }

    pub fn status(&self, hex: &str) -> Result<TorrentStatus> {
        let entry = self.entry(hex).context("unknown torrent")?;
        Ok(self.status_of(&entry))
    }

    pub fn status_of(&self, entry: &Entry) -> TorrentStatus {
        let selected = *entry.selected_file.read();
        let ext = entry.handle().and_then(|h| selected.and_then(|i| file_ext_of(&h, i)));
        let url = self.url_for(&entry.hex, selected, ext);
        let mut st = TorrentStatus {
            id: entry.hex.clone(),
            info_hash: entry.hex.clone(),
            name: entry.display_name.read().clone(),
            state: "resolving".into(),
            error: None,
            progress: 0.0,
            progress_bytes: 0,
            total_bytes: 0,
            download_bps: 0,
            upload_bps: 0,
            peers_live: 0,
            peers_connecting: 0,
            peers_seen: 0,
            files: Vec::new(),
            selected_file: *entry.selected_file.read(),
            url,
            active_streams: entry.active_streams.load(Ordering::Relaxed),
            added_at: entry.added_at,
            last_access: entry.last_access.load(Ordering::Relaxed),
            size_on_disk: 0,
            health: self.streaming.health_of(&entry.hex),
            recoveries: self.streaming.recoveries_of(&entry.hex),
            start: entry.timeline.view(),
        };

        let handle = match &*entry.state.read() {
            EntryState::Resolving => return st,
            EntryState::Failed(e) => {
                st.state = "error".into();
                st.error = Some(e.clone());
                return st;
            }
            EntryState::Ready(h) => h.clone(),
        };

        let stats = handle.stats();
        st.total_bytes = stats.total_bytes;
        st.progress_bytes = stats.progress_bytes;
        // With nothing selected (startup window, metered network) librqbit reports `finished`:
        // only the played file being complete counts.
        let file_done = selected_file_complete(&stats.file_progress, &handle, *entry.selected_file.read()).unwrap_or(stats.finished);
        st.state = match stats.state {
            TorrentStatsState::Initializing { .. } => "initializing",
            TorrentStatsState::Live => {
                if file_done {
                    "finished"
                } else {
                    "live"
                }
            }
            TorrentStatsState::Paused => "paused",
            TorrentStatsState::Error => "error",
        }
        .into();
        st.error = stats.error.clone();
        if let Some(live) = &stats.live {
            st.download_bps = live.download_speed.as_bytes();
            st.upload_bps = live.upload_speed.as_bytes();
            st.peers_live = live.snapshot.peer_stats.live;
            st.peers_connecting = live.snapshot.peer_stats.connecting;
            st.peers_seen = live.snapshot.peer_stats.seen;
        }
        st.files = handle
            .with_metadata(|m| {
                m.file_infos
                    .iter()
                    .enumerate()
                    .map(|(idx, f)| FileStatus {
                        idx,
                        name: f.relative_filename.to_string_lossy().into_owned(),
                        size: f.len,
                        progress_bytes: stats.file_progress.get(idx).copied().unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Only the selected file is wanted: report progress relative to it.
        if let Some(sel) = st.selected_file.and_then(|i| st.files.get(i)) {
            st.total_bytes = sel.size;
            st.progress_bytes = sel.progress_bytes;
        }
        st.progress = if st.total_bytes > 0 { st.progress_bytes as f64 / st.total_bytes as f64 } else { 0.0 };
        st.size_on_disk = stats.file_progress.iter().sum();
        st
    }

    pub fn list(&self) -> Vec<TorrentStatus> {
        self.entries().iter().map(|e| self.status_of(e)).collect()
    }

    pub fn stats(&self) -> EngineStats {
        let cfg = self.config();
        EngineStats {
            version: crate::VERSION,
            port: self.port(),
            cache_limit_bytes: cfg.cache_limit_bytes,
            cache_used_bytes: self.cache_used_bytes(),
            evictions: self.evictions.lock().clone(),
            seeding: cfg.seeding,
            torrents: self.list(),
        }
    }

    pub async fn pause(&self, hex: &str) -> Result<()> {
        let entry = self.entry(hex).context("unknown torrent")?;
        let handle = entry.handle().context("torrent not resolved yet")?;
        self.session.pause(&handle).await
    }

    pub async fn resume(self: &Arc<Self>, hex: &str) -> Result<()> {
        let entry = self.entry(hex).context("unknown torrent")?;
        let handle = entry.handle().context("torrent not resolved yet")?;
        entry.touch();
        if handle.is_paused() {
            self.session.unpause(&handle).await?;
        }
        Ok(())
    }

    /// True while `entry` is the registered one for its hash (not removed, not replaced by a retry).
    fn owns(&self, entry: &Arc<Entry>) -> bool {
        self.entries.read().get(&entry.hex).is_some_and(|e| Arc::ptr_eq(e, entry))
    }

    /// A resolution finished for an entry that was removed meanwhile: delete what it added, unless
    /// a newer entry for the same hash exists (its own resolution adopts the same session torrent).
    async fn discard_late(&self, entry: &Entry, handle: &ManagedTorrentHandle) {
        *entry.state.write() = EntryState::Failed("removed".into());
        entry.ready.notify_waiters();
        if self.entry(&entry.hex).is_none() {
            if let Err(e) = self.session.delete(TorrentIdOrHash::Id(handle.id()), true).await {
                warn!("deleting late torrent {} failed: {e:#}", entry.hex);
            }
        }
    }

    /// Removes the torrent from the session and deletes its files.
    pub async fn remove(&self, hex: &str) -> Result<()> {
        let entry = self.entries.write().remove(hex).context("unknown torrent")?;
        self.streaming.forget(hex);
        let resolving = matches!(&*entry.state.read(), EntryState::Resolving);
        let task = entry.resolver.lock().take();
        if let Some(task) = task {
            // Still resolving: stop it and wait until it is really gone, so anything it registered
            // in the session is visible to the delete below. (A finished resolution is left alone:
            // it may be running this very removal through `enforce_quota`.)
            if resolving && tokio::task::try_id() != Some(task.id()) {
                task.abort();
                let _ = task.await;
            }
        }
        if let Some(handle) = entry.handle() {
            self.session.delete(TorrentIdOrHash::Id(handle.id()), true).await?;
        } else {
            // Never resolved: nothing in the session unless librqbit registered it; ignore "not found".
            let _ = self.session.delete(TorrentIdOrHash::Hash(entry.id20), true).await;
        }
        self.persist_entries();
        Ok(())
    }

    /// Deletes every torrent that is not being streamed right now. Returns bytes freed.
    pub async fn clear_cache(&self) -> Result<u64> {
        let before = cache::dir_size(&self.torrents_dir);
        let idle: Vec<String> = self
            .entries()
            .iter()
            .filter(|e| e.active_streams.load(Ordering::Relaxed) == 0)
            .map(|e| e.hex.clone())
            .collect();
        for hex in idle {
            if let Err(e) = self.remove(&hex).await {
                warn!("removing {hex} failed: {e:#}");
            }
        }
        let after = cache::dir_size(&self.torrents_dir);
        Ok(before.saturating_sub(after))
    }

    /// Torrent data on disk: the pieces librqbit has (per-file progress, in memory). No directory
    /// walk (a sparse, preallocated file also counted for its full length there).
    pub fn cache_used_bytes(&self) -> u64 {
        self.entries().iter().filter_map(|e| e.handle()).map(|h| h.stats().file_progress.iter().sum::<u64>()).sum()
    }

    /// Evicts least-recently-used idle torrents until the cache is `CACHE_HEADROOM` under the
    /// quota, so a new start always has room without evicting on its own path. Never the focused
    /// torrent, one with an open player response, or one touched in the last `EVICT_MIN_IDLE`.
    /// Runs from the janitor (in the background); each eviction is timed (`EngineStats.evictions`).
    pub async fn enforce_quota(&self) -> Result<u64> {
        let limit = self.config.read().cache_limit_bytes;
        if limit == 0 {
            return Ok(0);
        }
        let target = limit.saturating_sub(CACHE_HEADROOM.min(limit / 10));
        let mut used = self.cache_used_bytes();
        if used <= target {
            return Ok(0);
        }
        let focus = self.focus();
        let now = now_secs();
        let mut candidates: Vec<Arc<Entry>> = self
            .entries()
            .into_iter()
            .filter(|e| {
                e.active_streams.load(Ordering::Relaxed) == 0
                    && e.handle().is_some()
                    && focus.as_deref() != Some(e.hex.as_str())
                    && now.saturating_sub(e.last_access.load(Ordering::Relaxed)) >= EVICT_MIN_IDLE.as_secs()
            })
            .collect();
        candidates.sort_by_key(|e| e.last_access.load(Ordering::Relaxed));
        let mut freed = 0;
        for e in candidates {
            if used <= target {
                break;
            }
            let size = e.handle().map(|h| h.stats().file_progress.iter().sum::<u64>()).unwrap_or(0);
            let t = std::time::Instant::now();
            info!("cache quota: evicting {} ({} bytes)", e.hex, size);
            if self.remove(&e.hex).await.is_ok() {
                used = used.saturating_sub(size);
                freed += size;
                let ms = t.elapsed().as_millis() as u64;
                let mut ev = self.evictions.lock();
                ev.count += 1;
                ev.bytes += size;
                ev.total_ms += ms;
                ev.max_ms = ev.max_ms.max(ms);
            }
        }
        Ok(freed)
    }

    /// Runtime-updatable settings. `seeding` needs a restart and is only stored.
    pub fn update_config(&self, patch: ConfigPatch) -> Config {
        let mut cfg = self.config.write();
        if let Some(v) = patch.cache_limit_bytes {
            cfg.cache_limit_bytes = v;
        }
        if let Some(v) = patch.download_bps {
            cfg.download_bps = if v == 0 { None } else { Some(v) };
            self.session.ratelimits.set_download_bps(std::num::NonZeroU32::new(v));
        }
        if let Some(v) = patch.upload_bps {
            cfg.upload_bps = if v == 0 { None } else { Some(v) };
            self.session.ratelimits.set_upload_bps(std::num::NonZeroU32::new(v));
        }
        if let Some(v) = patch.seeding {
            cfg.seeding = v;
        }
        cfg.clone()
    }

    /// Stops everything that keeps the engine alive: the HTTP server (its task owns an
    /// `Arc<Engine>`), the magnet resolutions still running, then the librqbit session.
    pub fn shutdown(&self) {
        self.persist_entries();
        let server = self.server.lock().take();
        let resolvers: Vec<_> = self.entries.read().values().filter_map(|e| e.resolver.lock().take()).collect();
        let probes = self.probes.take_tasks();
        let background: Vec<_> = self.background.lock().drain(..).collect();
        self.runtime.block_on(async {
            for t in background {
                t.abort();
                let _ = t.await;
            }
            for t in probes {
                t.abort();
                let _ = t.await;
            }
            if let Some(ServerHandle { stop, mut task }) = server {
                let _ = stop.send(());
                // Graceful first (in-flight responses end); a video stream can last for ever, so
                // the listener is dropped after a short grace period anyway.
                if tokio::time::timeout(Duration::from_secs(2), &mut task).await.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
            for t in resolvers {
                t.abort();
                let _ = t.await;
            }
            self.session.stop().await;
        });
        self.port.store(0, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub cache_limit_bytes: Option<u64>,
    pub download_bps: Option<u32>,
    pub upload_bps: Option<u32>,
    pub seeding: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_to_trackers() {
        let src = vec![
            "tracker:udp://tracker.example:1337/announce".to_string(),
            "dht:abcdef".to_string(),
            "https://t.example/announce".to_string(),
            "tracker:udp://tracker.example:1337/announce".to_string(),
            "garbage".to_string(),
        ];
        assert_eq!(
            trackers_from_sources(&src),
            vec!["udp://tracker.example:1337/announce".to_string(), "https://t.example/announce".to_string()]
        );
    }

    #[test]
    fn magnet_is_built_and_encoded() {
        let m = build_magnet("0123456789abcdef0123456789abcdef01234567", &["udp://a:1/x".into()], Some("A B"));
        assert_eq!(m, "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=A%20B&tr=udp%3A%2F%2Fa%3A1%2Fx");
    }

    #[test]
    fn hash_normalisation() {
        let (_, hex) = normalize_hash("0123456789ABCDEF0123456789ABCDEF01234567").unwrap();
        assert_eq!(hex, "0123456789abcdef0123456789abcdef01234567");
        assert!(normalize_hash("nope").is_err());
        assert!(normalize_hash("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567").is_ok());
    }

    fn test_engine(tag: &str) -> Arc<Engine> {
        let dir = std::env::temp_dir().join(format!("huwa-torrent-test-{tag}-{}-{}", std::process::id(), now_secs()));
        let _ = std::fs::remove_dir_all(&dir);
        let config: Config = serde_json::from_value(serde_json::json!({ "dataDir": dir })).unwrap();
        Engine::new(config).unwrap()
    }

    fn session_torrents(engine: &Engine) -> usize {
        engine.session.with_torrents(|it| it.count())
    }

    #[test]
    fn removing_a_resolving_torrent_stops_its_resolution() {
        let engine = test_engine("remove");
        // No peer will ever answer for this hash: it stays in `Resolving`.
        let hex = "00112233445566778899aabbccddeeff00112233";
        engine
            .start_stream(StartStreamRequest { info_hash: hex.into(), file_idx: None, sources: vec![], name: Some("x".into()), metered: false })
            .unwrap();
        let entry = engine.entry(hex).unwrap();
        assert!(matches!(&*entry.state.read(), EntryState::Resolving));
        assert!(entry.resolver.lock().is_some());
        engine.runtime.block_on(engine.remove(hex)).unwrap();
        assert!(engine.entry(hex).is_none());
        assert!(entry.resolver.lock().is_none(), "resolution task taken, aborted and awaited");
        // Only `entry` (this test) still references it: the aborted task dropped its clone.
        assert_eq!(Arc::strong_count(&entry), 1);
        assert_eq!(session_torrents(&engine), 0);
        engine.shutdown();
    }

    #[test]
    fn a_magnet_still_resolving_restarts_from_the_probe_metadata() {
        let engine = test_engine("stuck");
        let hex = "00112233445566778899aabbccddeeff00112244";
        let req = || StartStreamRequest { info_hash: hex.into(), file_idx: None, sources: vec![], name: None, metered: false };
        engine.start_stream(req()).unwrap();
        let first = engine.entry(hex).unwrap();
        assert_eq!(first.resolving_from.load(Ordering::Relaxed), META_MAGNET);
        // Same hash again, still nothing from the magnet: kept as is (no restart loop).
        engine.start_stream(req()).unwrap();
        assert!(Arc::ptr_eq(&first, &engine.entry(hex).unwrap()));
        // The probe has the metadata by now: the stuck resolution is replaced.
        let files = vec![("Show - 01.mkv".to_string(), 1000)];
        engine.meta_cache.insert(hex, crate::probe::CachedMeta::new(bytes::Bytes::from_static(b"d4:infod6:lengthi1000eee"), files, vec![], std::time::Instant::now()));
        let resp = engine.start_stream(req()).unwrap();
        let second = engine.entry(hex).unwrap();
        assert!(!Arc::ptr_eq(&first, &second), "new entry");
        assert_eq!(second.resolving_from.load(Ordering::Relaxed), META_PROBE);
        assert!(first.resolver.lock().is_none(), "old resolution aborted");
        assert!(resp.url.ends_with("/0.mkv"), "{}", resp.url);
        engine.shutdown();
    }

    #[test]
    fn shutdown_stops_the_http_server_and_releases_the_engine() {
        let engine = test_engine("shutdown");
        let port = engine.runtime.block_on(crate::server::start(engine.clone())).unwrap();
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
        assert!(Arc::strong_count(&engine) >= 2, "the server task holds the engine");
        engine.shutdown();
        assert_eq!(Arc::strong_count(&engine), 1, "server task gone: nothing else keeps the engine alive");
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "listener closed");
        drop(engine); // runtime shut down without blocking
    }

    #[test]
    fn probes_get_the_public_trackers_too() {
        let engine = test_engine("trackers");
        // What `probe::run` announces to for a magnet without trackers: the public list.
        let list = engine.torrent_trackers(&["dht:x".to_string()]);
        assert_eq!(list.len(), crate::trackers::MAX_ADDED);
        assert!(list.iter().all(|t| crate::trackers::PUBLIC_TRACKERS.contains(&t.as_str())));
        engine.shutdown();
    }

    #[test]
    fn picks_largest_video() {
        let files = vec![
            ("readme.txt".to_string(), 10),
            ("sample.mkv".to_string(), 50),
            ("episode.MKV".to_string(), 500),
            ("huge.iso".to_string(), 9000),
        ];
        assert_eq!(pick_file(&files), Some(2));
        let none_video = vec![("a.bin".to_string(), 1), ("b.bin".to_string(), 2)];
        assert_eq!(pick_file(&none_video), Some(1));
        assert_eq!(pick_file(&[]), None);
    }

    fn files(list: &[(&str, u64)]) -> Vec<(String, u64)> {
        list.iter().map(|(n, s)| (n.to_string(), *s)).collect()
    }

    #[test]
    fn more_containers_are_videos() {
        for name in ["a.mk3d", "a.M2TS", "a.mts", "a.vob", "a.mpg", "a.ogm", "a.rmvb", "a.divx", "a.3gp", "a.asf", "a.f4v", "BDMV/STREAM/00001.m2ts"] {
            assert!(is_video_name(name), "{name}");
            assert!(video_ext(name).is_some(), "{name}");
        }
        for name in ["a.srt", "a.ass", "a.idx", "a.sub", "a.nfo", "a.rar", "a.r00", "a.r17", "a.001", "a.iso", "a.mka", "a.flac", "cover.jpg"] {
            assert!(!is_video_name(name) && is_junk_name(name), "{name}");
        }
        assert!(!is_junk_name("video") && !is_junk_name("video.bin") && !is_junk_name("Show - 01.mkv.part"));
    }

    #[test]
    fn extras_are_recognized_by_whole_words() {
        for name in [
            "Show - NCOP1.mkv",
            "Show/Extras/NCED 02 [1080p].mkv",
            "[Grp] Show - NCOP1a.mkv",
            "Show [BD]/Creditless/OP1.mkv",
            "Show - ED2.mkv",
            "movie.sample.mkv",
            "Sample/movie-sample.mkv",
            "Show - Trailer.mp4",
            "Show [Menu].m2ts",
            "Show - PV 01.mkv",
        ] {
            assert!(is_extra_name(name), "{name}");
        }
        for name in ["Show - 01.mkv", "Opening Night (2007).mkv", "Edens Zero - 05.mkv", "Sampler Story - 01.mkv", "Show S01E02.mkv", "Show - 07 [ED2K].mkv"] {
            assert!(!is_extra_name(name), "{name}");
        }
    }

    #[test]
    fn picks_the_episode_over_bigger_extras_and_skips_junk() {
        // A BD episode with a long creditless OP+ED file next to it: the episode, even if smaller.
        let f = files(&[("Show - 03.mkv", 300), ("Extras/NCOP.mkv", 900), ("Extras/Menu 01.m2ts", 50)]);
        assert_eq!(pick_file(&f), Some(0));
        // Only extras: still something to play.
        assert_eq!(pick_file(&files(&[("NCOP.mkv", 10), ("NCED.mkv", 20)])), Some(1));
        // Unknown / missing extension: the largest file that is not known to be something else.
        let f = files(&[("release.nfo", 5), ("cover.jpg", 900), ("video", 700), ("subs.srt", 1)]);
        assert_eq!(pick_file(&f), Some(2));
        // RAR'd release, ISO only: nothing playable rather than a wrong file.
        assert_eq!(pick_file(&files(&[("x.rar", 50), ("x.r00", 50), ("x.r01", 50), ("x.sfv", 1)])), None);
        assert_eq!(pick_file(&files(&[("disc.iso", 9000), ("readme.txt", 1)])), None);
        // Season pack in nested folders: the largest episode, wherever it lives.
        let f = files(&[("S1/Disc1/Show - 01.mkv", 500), ("S1/Disc2/Show - 02.mkv", 520), ("S1/Disc2/Sample/Show - 02 sample.mkv", 30)]);
        assert_eq!(pick_file(&f), Some(1));
    }
}
