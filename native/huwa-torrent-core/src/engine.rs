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
}

fn default_cache_limit() -> u64 {
    5 * 1024 * 1024 * 1024
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStats {
    pub version: &'static str,
    pub port: u16,
    pub cache_limit_bytes: u64,
    pub cache_used_bytes: u64,
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

const VIDEO_EXT: &[&str] = &["mkv", "mp4", "webm", "m4v", "mov", "avi", "ts", "m2ts", "wmv", "flv"];

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

/// Picks the largest video file, else the largest file.
pub fn pick_file(files: &[(String, u64)]) -> Option<usize> {
    let best_video = files
        .iter()
        .enumerate()
        .filter(|(_, (n, _))| is_video_name(n))
        .max_by_key(|(_, (_, len))| *len)
        .map(|(i, _)| i);
    best_video.or_else(|| files.iter().enumerate().max_by_key(|(_, (_, len))| *len).map(|(i, _)| i))
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
        });
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

    pub fn url_for(&self, hex: &str, file: Option<usize>) -> String {
        match file {
            Some(i) => format!("http://127.0.0.1:{}/{}/{}", self.port(), hex, i),
            None => format!("http://127.0.0.1:{}/{}/auto", self.port(), hex),
        }
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
            });
            map.insert(hex, entry);
        }
        info!("restored {} torrent(s)", map.len());
    }

    /// Periodic cache-quota enforcement and persistence.
    fn spawn_janitor(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(self);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(engine) = weak.upgrade() else { return };
                if let Err(e) = engine.enforce_quota().await {
                    warn!("quota enforcement failed: {e:#}");
                }
                engine.persist_entries();
            }
        })
    }

    /// Registers the torrent (if new), starts the magnet resolution in the background and
    /// returns the loopback URL immediately. The HTTP handler waits for readiness.
    pub fn start_stream(self: &Arc<Self>, req: StartStreamRequest) -> Result<StartStreamResponse> {
        let (id20, hex) = normalize_hash(&req.info_hash)?;
        let trackers = self.torrent_trackers(&req.sources);

        if let Some(existing) = self.entry(&hex) {
            existing.touch();
            existing.metered.store(req.metered, Ordering::Relaxed);
            if let Some(name) = req.name.as_ref() {
                if existing.display_name.read().is_none() {
                    *existing.display_name.write() = Some(name.clone());
                }
            }
            // A previously failed resolution is retried.
            let failed = matches!(&*existing.state.read(), EntryState::Failed(_));
            if failed {
                self.entries.write().remove(&hex);
            } else {
                if let Some(h) = existing.handle() {
                    if h.is_paused() {
                        let session = self.session.clone();
                        let h2 = h.clone();
                        self.runtime.spawn(async move {
                            if let Err(e) = session.unpause(&h2).await {
                                warn!("unpause failed: {e:#}");
                            }
                        });
                    }
                }
                let file = req.file_idx.or(*existing.selected_file.read());
                return Ok(StartStreamResponse { id: hex.clone(), url: self.url_for(&hex, file), info_hash: hex });
            }
        }

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
        });
        self.entries.write().insert(hex.clone(), entry.clone());
        self.persist_entries();

        let engine = self.clone();
        let magnet = build_magnet(&hex, &trackers, req.name.as_deref());
        // Probed a moment ago (torrent race): no magnet resolution, the peers that answered the
        // probe are dialled first, and only the wanted file is allocated.
        let probed = self.meta_cache.get(&hex, std::time::Instant::now());
        let max_peers = self.config.read().max_peers;
        let task_entry = entry.clone();
        let task = self.runtime.spawn(async move {
            let entry = task_entry;
            let mut opts = AddTorrentOptions {
                overwrite: true,
                trackers: if trackers.is_empty() { None } else { Some(trackers.clone()) },
                ..Default::default()
            };
            let add = match probed {
                Some(m) => {
                    opts.only_files = entry.requested_file.filter(|i| *i < m.files.len()).or_else(|| pick_file(&m.files)).map(|i| vec![i]);
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
            if let Err(e) = engine.enforce_quota().await {
                warn!("quota enforcement failed: {e:#}");
            }
        });
        *entry.resolver.lock() = Some(task);

        Ok(StartStreamResponse { id: hex.clone(), url: self.url_for(&hex, req.file_idx), info_hash: hex })
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
        let url = self.url_for(&entry.hex, *entry.selected_file.read());
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
            cache_used_bytes: cache::dir_size(&self.torrents_dir),
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

    /// Evicts least-recently-used idle torrents until the data folder fits the quota.
    pub async fn enforce_quota(&self) -> Result<u64> {
        let limit = self.config.read().cache_limit_bytes;
        if limit == 0 {
            return Ok(0);
        }
        let mut used = cache::dir_size(&self.torrents_dir);
        if used <= limit {
            return Ok(0);
        }
        let mut candidates: Vec<Arc<Entry>> = self
            .entries()
            .into_iter()
            .filter(|e| e.active_streams.load(Ordering::Relaxed) == 0 && e.handle().is_some())
            .collect();
        candidates.sort_by_key(|e| e.last_access.load(Ordering::Relaxed));
        let mut freed = 0;
        for e in candidates {
            if used <= limit {
                break;
            }
            let size = e.handle().map(|h| h.stats().file_progress.iter().sum::<u64>()).unwrap_or(0);
            info!("cache quota: evicting {} ({} bytes)", e.hex, size);
            if self.remove(&e.hex).await.is_ok() {
                used = used.saturating_sub(size);
                freed += size;
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
}
