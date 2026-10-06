//! Swarm probes ("course des torrents"): several candidate torrents are checked in parallel before
//! one is streamed, so a dead or starved swarm no longer makes the user wait.
//!
//! A probe, bounded in time (8 s by default) and in number (`MAX_CONCURRENT_PROBES` at once):
//! - resolves the magnet's metadata with librqbit's `list_only` add: the info dictionary is fetched
//!   from peers (ut_metadata), nothing is registered in the session, no file is created, no piece
//!   is requested or written, nothing is announced on the DHT and nothing is seeded;
//! - checks that the wanted file exists (addon `fileIdx`, `behaviorHints.filename`, or the episode
//!   number for a season pack, see `pick_probe_file`);
//! - counts the peers discovered on the DHT (read-only lookup, no announce) and the ones that
//!   really answer: a 68-byte BitTorrent handshake for the same info hash, then the connection is
//!   closed (no bitfield, no `interested`, no data);
//! - ends `healthy` as soon as metadata + file + `minPeers` answering peers are there, otherwise at
//!   the deadline (`weak`: metadata but too few peers, `failed`: no metadata, `noFile`).
//!
//! The resolved metadata (`.torrent` bytes) and the peers that answered are kept a few minutes in
//! `MetaCache`: the stream started on the winner skips the magnet resolution and dials those
//! peers first (fast start).

use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures::{stream::FuturesUnordered, StreamExt};
use librqbit::{dht::Id20, AddTorrent, AddTorrentOptions, AddTorrentResponse};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
    task::JoinHandle,
};

use crate::engine::{build_magnet, is_video_name, normalize_hash, pick_file, Engine};

/// Probes actually running at once (more are queued). JS asks for 4 on Wi-Fi (8 once the race
/// widens because every candidate looks weak), 2 on cellular (3 widened).
pub const MAX_CONCURRENT_PROBES: usize = 8;
/// The race commits after 1.5 s (popular) / 2.5 s (obscure) at most, see `src/torrent/peer-race.ts`:
/// a probe running longer only matters for the sources menu.
pub const DEFAULT_TIMEOUT_MS: u64 = 3_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
/// Answering peers needed to call a swarm healthy.
pub const DEFAULT_MIN_PEERS: usize = 3;
/// Parallel handshakes and handshakes tried per probe, scaled to the swarm size (see
/// `handshake_concurrency` / `max_handshakes`). Most addresses a DHT returns for a popular torrent
/// are stale: with a fixed 10 slots × 2.5 s and 40 attempts, the slots were held by dead addresses
/// while the live ones waited, and the attempts ran out before 3 peers answered — popular swarms
/// came out slower than obscure ones, or `weak`.
const MIN_HANDSHAKE_CONCURRENCY: usize = 10;
const MAX_HANDSHAKE_CONCURRENCY: usize = 32;
const MIN_HANDSHAKES: usize = 40;
const MAX_HANDSHAKES: usize = 120;
/// A live peer answers a handshake within one round trip (< 1 s even on cellular); waiting longer
/// only keeps a slot on a dead address.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Finished / cancelled probe records kept for `probeStatus`, then dropped.
const FINISHED_TTL: Duration = Duration::from_secs(120);
const MAX_RECORDS: usize = 48;
/// Resolved metadata reused by `start_stream`.
const META_TTL: Duration = Duration::from_secs(20 * 60);
const META_CAP: usize = 24;
/// Peers handed to the stream as `initial_peers`.
const MAX_INITIAL_PEERS: usize = 60;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRequest {
    pub info_hash: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Addon's file index (Torrentio gives it for packs).
    #[serde(default)]
    pub file_idx: Option<usize>,
    /// Stremio `behaviorHints.filename`.
    #[serde(default)]
    pub filename: Option<String>,
    /// Episode number, used to find the file in a season pack without `fileIdx` / `filename`.
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub min_peers: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeState {
    /// Waiting for a free slot (`MAX_CONCURRENT_PROBES`).
    Queued,
    /// Metadata and/or peers still being looked for.
    Resolving,
    /// Metadata, wanted file present, at least `minPeers` peers answered.
    Healthy,
    /// Deadline reached with metadata but fewer answering peers.
    Weak,
    /// Metadata resolved but the wanted file is not in this torrent.
    NoFile,
    /// No metadata before the deadline, or an error.
    Failed,
    Cancelled,
}

impl ProbeState {
    pub fn is_final(self) -> bool {
        !matches!(self, ProbeState::Queued | ProbeState::Resolving)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStatus {
    pub id: u64,
    pub info_hash: String,
    pub state: ProbeState,
    /// Time to metadata since the probe started running (0 when already known).
    pub meta_ms: Option<u64>,
    /// Unique peers discovered (DHT lookup + trackers seen while resolving).
    pub peers: usize,
    /// Peers that completed a BitTorrent handshake for this info hash.
    pub connected: usize,
    pub file_idx: Option<usize>,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
    pub file_count: Option<usize>,
    /// The file is already complete on the device.
    pub local: bool,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

pub struct Probe {
    pub id: u64,
    pub hex: String,
    created: Instant,
    started: Mutex<Option<Instant>>,
    ended: Mutex<Option<Instant>>,
    status: RwLock<ProbeStatus>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Probe {
    fn new(id: u64, hex: String) -> Self {
        Self {
            id,
            hex: hex.clone(),
            created: Instant::now(),
            started: Mutex::new(None),
            ended: Mutex::new(None),
            status: RwLock::new(ProbeStatus {
                id,
                info_hash: hex,
                state: ProbeState::Queued,
                meta_ms: None,
                peers: 0,
                connected: 0,
                file_idx: None,
                file_name: None,
                file_size: None,
                file_count: None,
                local: false,
                elapsed_ms: 0,
                error: None,
            }),
            task: Mutex::new(None),
        }
    }

    pub fn status(&self) -> ProbeStatus {
        let mut st = self.status.read().clone();
        let start = (*self.started.lock()).unwrap_or(self.created);
        let end = (*self.ended.lock()).unwrap_or_else(Instant::now);
        st.elapsed_ms = end.saturating_duration_since(start).as_millis() as u64;
        st
    }

    fn begin(&self) {
        *self.started.lock() = Some(Instant::now());
        self.update(|st| st.state = ProbeState::Resolving);
    }

    fn update(&self, f: impl FnOnce(&mut ProbeStatus)) {
        let mut st = self.status.write();
        if !st.state.is_final() {
            f(&mut st);
        }
    }

    fn finish(&self, state: ProbeState, error: Option<String>) {
        {
            let mut st = self.status.write();
            if st.state.is_final() {
                return;
            }
            st.state = state;
            if error.is_some() {
                st.error = error;
            }
        }
        *self.ended.lock() = Some(Instant::now());
    }

    fn is_finished(&self) -> bool {
        self.status.read().state.is_final()
    }

    fn ended_before(&self, cutoff: Instant) -> bool {
        self.ended.lock().is_some_and(|e| e < cutoff)
    }
}

/// Registry of probes + the concurrency limit.
pub struct Probes {
    map: RwLock<HashMap<u64, Arc<Probe>>>,
    next: AtomicU64,
    slots: Arc<Semaphore>,
}

impl Default for Probes {
    fn default() -> Self {
        Self { map: RwLock::new(HashMap::new()), next: AtomicU64::new(1), slots: Arc::new(Semaphore::new(MAX_CONCURRENT_PROBES)) }
    }
}

impl Probes {
    pub fn get(&self, id: u64) -> Option<Arc<Probe>> {
        self.map.read().get(&id).cloned()
    }

    fn insert(&self, hex: String) -> Arc<Probe> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let probe = Arc::new(Probe::new(id, hex));
        let mut map = self.map.write();
        // Old finished records go first; past the cap, the oldest finished ones.
        if let Some(cutoff) = Instant::now().checked_sub(FINISHED_TTL) {
            map.retain(|_, p| !p.ended_before(cutoff));
        }
        if map.len() >= MAX_RECORDS {
            let mut done: Vec<(u64, Instant)> = map.values().filter(|p| p.is_finished()).map(|p| (p.id, p.created)).collect();
            done.sort_by_key(|(_, at)| *at);
            for (id, _) in done.into_iter().take(map.len() + 1 - MAX_RECORDS) {
                map.remove(&id);
            }
        }
        map.insert(id, probe.clone());
        probe
    }

    /// Stops a probe at once (its socket and DHT lookups are dropped with the task). The record
    /// stays readable as `cancelled` until it expires.
    pub fn cancel(&self, id: u64) -> bool {
        let Some(p) = self.get(id) else { return false };
        p.finish(ProbeState::Cancelled, None);
        if let Some(t) = p.task.lock().take() {
            t.abort();
        }
        true
    }

    /// Every running task, for `Engine::shutdown` (aborted and awaited there).
    pub fn take_tasks(&self) -> Vec<JoinHandle<()>> {
        let map = self.map.read();
        map.values()
            .filter_map(|p| {
                p.finish(ProbeState::Cancelled, None);
                p.task.lock().take()
            })
            .collect()
    }

    pub fn running(&self) -> usize {
        self.map.read().values().filter(|p| !p.is_finished()).count()
    }
}

// ---------- metadata reuse ----------

#[derive(Clone)]
pub struct CachedMeta {
    /// `.torrent` built from the info dictionary (+ the magnet's trackers).
    pub torrent_bytes: Bytes,
    pub files: Vec<(String, u64)>,
    /// Peers that answered first, then the other discovered ones.
    pub peers: Vec<SocketAddr>,
    at: Instant,
}

impl CachedMeta {
    pub fn new(torrent_bytes: Bytes, files: Vec<(String, u64)>, peers: Vec<SocketAddr>, at: Instant) -> Self {
        Self { torrent_bytes, files, peers, at }
    }
}

#[derive(Default)]
pub struct MetaCache {
    map: Mutex<HashMap<String, CachedMeta>>,
}

impl MetaCache {
    pub fn get(&self, hex: &str, now: Instant) -> Option<CachedMeta> {
        let mut map = self.map.lock();
        let fresh = map.get(hex).is_some_and(|m| now.saturating_duration_since(m.at) < META_TTL);
        if !fresh {
            map.remove(hex);
            return None;
        }
        map.get(hex).cloned()
    }

    pub fn insert(&self, hex: &str, meta: CachedMeta) {
        let mut map = self.map.lock();
        map.insert(hex.to_string(), meta);
        while map.len() > META_CAP {
            let Some(oldest) = map.iter().min_by_key(|(_, m)| m.at).map(|(k, _)| k.clone()) else { break };
            map.remove(&oldest);
        }
    }

    /// Answering peers first, then the others, without duplicates.
    pub fn set_peers(&self, hex: &str, good: &[SocketAddr], seen: &[SocketAddr]) {
        if let Some(m) = self.map.lock().get_mut(hex) {
            let mut out: Vec<SocketAddr> = Vec::new();
            for a in good.iter().chain(seen.iter()).chain(m.peers.iter()) {
                if out.len() >= MAX_INITIAL_PEERS {
                    break;
                }
                if !out.contains(a) {
                    out.push(*a);
                }
            }
            m.peers = out;
        }
    }

    pub fn remove(&self, hex: &str) {
        self.map.lock().remove(hex);
    }
}

// ---------- file selection ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilePick {
    File(usize),
    NoFile(&'static str),
}

fn base_name(name: &str) -> &str {
    Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or(name)
}

/// How strongly `name` designates episode `ep`: 2 = explicit (`E05`, `ep 5`, ` - 05`, `#5`,
/// `[05]`), 1 = a bare number, 0 = no. Years, resolutions, codecs (`x264`), seasons (`S01`),
/// bit depths and versions (`v2`) are ignored.
pub fn episode_match(name: &str, ep: u32) -> u8 {
    let base = base_name(name);
    let stem = Path::new(base).file_stem().and_then(|s| s.to_str()).unwrap_or(base);
    let b = stem.as_bytes();
    let mut best = 0u8;
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = &stem[start..i];
        if digits.len() >= 4 {
            continue;
        }
        let prev = if start > 0 { b[start - 1].to_ascii_lowercase() } else { b' ' };
        let next = b.get(i).map(|c| c.to_ascii_lowercase()).unwrap_or(b' ');
        let rest = stem[i..].to_ascii_lowercase();
        // Audio channels ("5.1", "2.0"): one digit after the dot. "E05.1080p" is not one.
        let decimal = next == b'.'
            && b.get(i + 1).is_some_and(u8::is_ascii_digit)
            && !b.get(i + 2).is_some_and(u8::is_ascii_digit);
        if matches!(prev, b'x' | b'h' | b's' | b'v') || next == b'p' || rest.starts_with("bit") || decimal {
            continue;
        }
        if digits.parse::<u32>().ok() != Some(ep) {
            continue;
        }
        let before = stem[..start].to_ascii_lowercase();
        let explicit = prev == b'e'
            || prev == b'#'
            || prev == b'['
            || before.trim_end().ends_with("ep")
            || before.trim_end().ends_with("ep.")
            || before.trim_end().ends_with("episode")
            || before.ends_with("- ")
            || before.ends_with("_-_");
        best = best.max(if explicit { 2 } else { 1 });
    }
    best
}

/// File the stream would play, or why this torrent does not have it.
/// Order: the addon's `fileIdx`, then its `filename`, then (season pack) the episode number, then
/// the largest video. Small extra videos (samples, NCOP/NCED: under a quarter of the largest one)
/// do not make a torrent a pack.
pub fn pick_probe_file(files: &[(String, u64)], file_idx: Option<usize>, filename: Option<&str>, episode: Option<u32>) -> FilePick {
    if files.is_empty() {
        return FilePick::NoFile("empty torrent");
    }
    if let Some(i) = file_idx {
        return match files.get(i) {
            Some((n, _)) if is_video_name(n) => FilePick::File(i),
            Some(_) => FilePick::NoFile("not a video"),
            None => FilePick::NoFile("file index out of range"),
        };
    }
    if let Some(f) = filename.map(str::trim).filter(|f| !f.is_empty()) {
        let f = base_name(f);
        if let Some(i) = files.iter().position(|(n, _)| base_name(n).eq_ignore_ascii_case(f)) {
            return FilePick::File(i);
        }
    }
    let videos: Vec<usize> = (0..files.len()).filter(|&i| is_video_name(&files[i].0)).collect();
    let Some(largest) = videos.iter().map(|&i| files[i].1).max() else {
        return FilePick::NoFile("no video file");
    };
    let main: Vec<usize> = videos.iter().copied().filter(|&i| files[i].1.saturating_mul(4) >= largest).collect();
    if let (Some(ep), true) = (episode, main.len() > 1) {
        let scored: Vec<(usize, u8)> = main.iter().map(|&i| (i, episode_match(&files[i].0, ep))).filter(|(_, s)| *s > 0).collect();
        let Some(top) = scored.iter().map(|(_, s)| *s).max() else {
            return FilePick::NoFile("episode not in this pack");
        };
        return scored
            .iter()
            .filter(|(_, s)| *s == top)
            .max_by_key(|(i, _)| files[*i].1)
            .map(|(i, _)| FilePick::File(*i))
            .unwrap_or(FilePick::NoFile("episode not in this pack"));
    }
    pick_file(files).map(FilePick::File).unwrap_or(FilePick::NoFile("no file"))
}

// ---------- state machine ----------

/// Final state once known, `None` while the probe should keep going.
/// `file_ok` is `None` until the metadata is there; `exhausted` = deadline reached, or nothing
/// left to try.
pub fn settle(meta: bool, file_ok: Option<bool>, connected: usize, min_peers: usize, exhausted: bool) -> Option<ProbeState> {
    if meta && file_ok == Some(false) {
        return Some(ProbeState::NoFile);
    }
    if meta && file_ok == Some(true) && connected >= min_peers {
        return Some(ProbeState::Healthy);
    }
    if !exhausted {
        return None;
    }
    Some(if meta { ProbeState::Weak } else { ProbeState::Failed })
}

/// Answering peers of a probe: the ones that completed our handshake, or — when the engine
/// already runs this torrent (watched before, partly cached) — the peers it is connected to.
/// Its metadata is known then, so no tracker is asked and a cold DHT alone often finds nobody:
/// the probe used to report "aucun pair" (`weak`, 0) for a swarm the engine was downloading from.
pub fn answering(handshakes: usize, engine_live: usize) -> usize {
    handshakes.max(engine_live)
}

/// Handshakes in flight for a swarm where `seen` addresses were discovered so far.
pub fn handshake_concurrency(seen: usize) -> usize {
    (MIN_HANDSHAKE_CONCURRENCY + seen / 4).min(MAX_HANDSHAKE_CONCURRENCY)
}

/// Handshakes tried at most for a swarm where `seen` addresses were discovered.
pub fn max_handshakes(seen: usize) -> usize {
    (MIN_HANDSHAKES + seen / 2).min(MAX_HANDSHAKES)
}

/// Adds discovered addresses to the handshake queue. `fresh` ones (trackers' answers, peers that
/// just served the metadata, peers that answered a previous probe) go before the DHT ones, which are
/// often stale.
pub fn enqueue(queue: &mut VecDeque<SocketAddr>, seen: &mut HashSet<SocketAddr>, order: &mut Vec<SocketAddr>, addrs: &[SocketAddr], fresh: bool) {
    let mut front = Vec::new();
    for a in addrs {
        if seen.insert(*a) {
            order.push(*a);
            if fresh {
                front.push(*a);
            } else {
                queue.push_back(*a);
            }
        }
    }
    for a in front.into_iter().rev() {
        queue.push_front(a);
    }
}

pub fn clamp_timeout(ms: Option<u64>) -> Duration {
    Duration::from_millis(ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS))
}

// ---------- BitTorrent handshake ----------

const PSTR: &[u8; 19] = b"BitTorrent protocol";

pub fn handshake_bytes(info_hash: &[u8; 20], peer_id: &[u8; 20]) -> [u8; 68] {
    let mut out = [0u8; 68];
    out[0] = 19;
    out[1..20].copy_from_slice(PSTR);
    // 8 reserved bytes stay zero: no extension (no ut_metadata, no DHT port) is advertised.
    out[28..48].copy_from_slice(info_hash);
    out[48..68].copy_from_slice(peer_id);
    out
}

/// The first 48 bytes of a peer's answer: same protocol, same torrent.
pub fn handshake_matches(resp: &[u8], info_hash: &[u8; 20]) -> bool {
    resp.len() >= 48 && resp[0] == 19 && &resp[1..20] == PSTR && &resp[28..48] == info_hash
}

/// Random-enough peer id ("-HW0100-" + 12 bytes), without an extra dependency.
pub fn probe_peer_id() -> [u8; 20] {
    use std::hash::{BuildHasher, Hasher};
    let mut id = [0u8; 20];
    id[..8].copy_from_slice(b"-HW0100-");
    let s = std::collections::hash_map::RandomState::new();
    for chunk in id[8..].chunks_mut(8) {
        let mut h = s.build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_usize(chunk.as_ptr() as usize);
        let v = h.finish().to_le_bytes();
        let n = chunk.len();
        chunk.copy_from_slice(&v[..n]);
    }
    id
}

/// Connects, exchanges handshakes and hangs up. True when the peer has this torrent.
pub async fn handshake(addr: SocketAddr, info_hash: [u8; 20], peer_id: [u8; 20], timeout: Duration) -> bool {
    let attempt = async {
        let mut s = TcpStream::connect(addr).await?;
        s.write_all(&handshake_bytes(&info_hash, &peer_id)).await?;
        let mut buf = [0u8; 48];
        s.read_exact(&mut buf).await?;
        anyhow::Ok(handshake_matches(&buf, &info_hash))
    };
    matches!(tokio::time::timeout(timeout, attempt).await, Ok(Ok(true)))
}

// ---------- the probe task ----------

/// Registers a probe and starts it in the background. Returns its id at once.
pub fn start(engine: &Arc<Engine>, req: ProbeRequest) -> Result<ProbeStatus> {
    let (id20, hex) = normalize_hash(&req.info_hash)?;
    let probe = engine.probes.insert(hex);
    let task = engine.runtime.spawn(run(engine.clone(), probe.clone(), req, id20));
    *probe.task.lock() = Some(task);
    // Cancelled between `insert` and here (shutdown): the task must not outlive it.
    if probe.is_finished() {
        if let Some(t) = probe.task.lock().take() {
            t.abort();
        }
    }
    Ok(probe.status())
}

struct Meta {
    files: Vec<(String, u64)>,
    from_list_only: bool,
}

async fn run(engine: Arc<Engine>, probe: Arc<Probe>, req: ProbeRequest, id20: Id20) {
    let slots = engine.probes.slots.clone();
    let Ok(_permit) = slots.acquire_owned().await else {
        probe.finish(ProbeState::Failed, Some("engine stopped".into()));
        return;
    };
    if probe.is_finished() {
        return;
    }
    probe.begin();
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + clamp_timeout(req.timeout_ms);
    let min_peers = req.min_peers.unwrap_or(DEFAULT_MIN_PEERS).max(1);
    let hex = probe.hex.clone();

    let mut meta: Option<Meta> = None;
    let mut file_ok: Option<bool> = None;
    let mut seen: HashSet<SocketAddr> = HashSet::new();
    let mut seen_order: Vec<SocketAddr> = Vec::new();
    let mut queue: VecDeque<SocketAddr> = VecDeque::new();
    let mut good: Vec<SocketAddr> = Vec::new();
    // Peers the engine's own copy of this torrent is connected to right now (0 if not running).
    let mut live_peers = 0usize;

    // Already in the engine: its metadata is known; a complete file needs no peer at all.
    if let Some(h) = engine.entry(&hex).and_then(|e| e.handle()) {
        let files: Vec<(String, u64)> = h
            .with_metadata(|m| m.file_infos.iter().map(|f| (f.relative_filename.to_string_lossy().into_owned(), f.len)).collect())
            .unwrap_or_default();
        if !files.is_empty() {
            let stats = h.stats();
            let pick = pick_probe_file(&files, req.file_idx, req.filename.as_deref(), req.episode);
            let complete = match pick {
                FilePick::File(i) => files.get(i).is_some_and(|(_, len)| stats.file_progress.get(i).copied().unwrap_or(0) >= *len),
                FilePick::NoFile(_) => false,
            };
            let live = stats.live.as_ref().map(|l| l.snapshot.peer_stats.live as usize).unwrap_or(0);
            live_peers = live;
            apply_meta(&probe, &files, &pick, Some(0));
            file_ok = Some(matches!(pick, FilePick::File(_)));
            if complete {
                probe.update(|st| {
                    st.local = true;
                    st.connected = live;
                });
                probe.finish(ProbeState::Healthy, None);
                return;
            }
            meta = Some(Meta { files, from_list_only: false });
        }
    }
    if meta.is_none() {
        if let Some(m) = engine.meta_cache.get(&hex, Instant::now()) {
            let pick = pick_probe_file(&m.files, req.file_idx, req.filename.as_deref(), req.episode);
            apply_meta(&probe, &m.files, &pick, Some(0));
            file_ok = Some(matches!(pick, FilePick::File(_)));
            enqueue(&mut queue, &mut seen, &mut seen_order, &m.peers, true);
            meta = Some(Meta { files: m.files, from_list_only: false });
        }
    }

    // Same list as the stream start (public trackers added to poor magnets): a probe that only had
    // the magnet's trackers + a cold DHT reported popular swarms as dead.
    let trackers = engine.torrent_trackers(&req.sources);
    let session = engine.session.clone();
    let mut add_fut = if meta.is_none() {
        let opts = AddTorrentOptions {
            list_only: true,
            trackers: if trackers.is_empty() { None } else { Some(trackers.clone()) },
            ..Default::default()
        };
        Some(session.add_torrent(AddTorrent::from_url(build_magnet(&hex, &trackers, req.name.as_deref())), Some(opts)))
    } else {
        None
    };
    // Read-only DHT lookup (no announce): live peer count while the metadata is fetched.
    let mut dht = session.get_dht().map(|d| d.get_peers(id20, None));
    let peer_id = probe_peer_id();
    let mut handshakes = FuturesUnordered::new();
    let mut attempts = 0usize;

    loop {
        while handshakes.len() < handshake_concurrency(seen.len()) && attempts < max_handshakes(seen.len()) {
            let Some(addr) = queue.pop_front() else { break };
            attempts += 1;
            handshakes.push(async move { (addr, handshake(addr, id20.0, peer_id, HANDSHAKE_TIMEOUT).await) });
        }
        probe.update(|st| {
            st.peers = seen.len();
            st.connected = answering(good.len(), live_peers);
        });
        let nothing_left = meta.is_some() && handshakes.is_empty() && (attempts >= max_handshakes(seen.len()) || (queue.is_empty() && dht.is_none()));
        if let Some(state) = settle(meta.is_some(), file_ok, answering(good.len(), live_peers), min_peers, nothing_left) {
            probe.finish(state, None);
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                let state = settle(meta.is_some(), file_ok, answering(good.len(), live_peers), min_peers, true).unwrap_or(ProbeState::Failed);
                let error = (state == ProbeState::Failed).then(|| "timeout: no metadata".to_string());
                probe.finish(state, error);
                break;
            }
            res = async { add_fut.as_mut().unwrap().await }, if add_fut.is_some() => {
                add_fut = None;
                match res {
                    Ok(AddTorrentResponse::ListOnly(lo)) => {
                        let files: Vec<(String, u64)> = lo
                            .info
                            .iter_file_details()
                            .map(|fd| (fd.filename.to_pathbuf().to_string_lossy().into_owned(), fd.len))
                            .collect();
                        let pick = pick_probe_file(&files, req.file_idx, req.filename.as_deref(), req.episode);
                        apply_meta(&probe, &files, &pick, Some(started.elapsed().as_millis() as u64));
                        file_ok = Some(matches!(pick, FilePick::File(_)));
                        // Tracker answers and the peers that served the metadata: alive a moment ago.
                        enqueue(&mut queue, &mut seen, &mut seen_order, &lo.seen_peers, true);
                        engine.meta_cache.insert(&hex, CachedMeta::new(lo.torrent_bytes.clone(), files.clone(), Vec::new(), Instant::now()));
                        meta = Some(Meta { files, from_list_only: true });
                    }
                    Ok(other) => {
                        // Not expected with `list_only`; an already managed torrent still has metadata.
                        let files: Vec<(String, u64)> = other
                            .into_handle()
                            .and_then(|h| h.with_metadata(|m| m.file_infos.iter().map(|f| (f.relative_filename.to_string_lossy().into_owned(), f.len)).collect()).ok())
                            .unwrap_or_default();
                        let pick = pick_probe_file(&files, req.file_idx, req.filename.as_deref(), req.episode);
                        apply_meta(&probe, &files, &pick, Some(started.elapsed().as_millis() as u64));
                        file_ok = Some(matches!(pick, FilePick::File(_)));
                        meta = Some(Meta { files, from_list_only: false });
                    }
                    Err(e) => {
                        probe.finish(ProbeState::Failed, Some(format!("{e:#}")));
                        break;
                    }
                }
            }
            next = async { dht.as_mut().unwrap().next().await }, if dht.is_some() => {
                match next {
                    Some(addr) => enqueue(&mut queue, &mut seen, &mut seen_order, &[addr], false),
                    None => dht = None,
                }
            }
            Some((addr, ok)) = handshakes.next(), if !handshakes.is_empty() => {
                if ok {
                    good.push(addr);
                }
            }
        }
    }
    {
        // Final counters (the loop may end before the last update).
        let mut st = probe.status.write();
        st.peers = seen.len();
        st.connected = st.connected.max(answering(good.len(), live_peers));
    }
    if meta.as_ref().is_some_and(|m| m.from_list_only || !m.files.is_empty()) {
        engine.meta_cache.set_peers(&hex, &good, &seen_order);
    }
}

fn apply_meta(probe: &Probe, files: &[(String, u64)], pick: &FilePick, meta_ms: Option<u64>) {
    probe.update(|st| {
        st.meta_ms = meta_ms;
        st.file_count = Some(files.len());
        match pick {
            FilePick::File(i) => {
                st.file_idx = Some(*i);
                st.file_name = files.get(*i).map(|(n, _)| base_name(n).to_string());
                st.file_size = files.get(*i).map(|(_, l)| *l);
            }
            FilePick::NoFile(why) => st.error = Some((*why).to_string()),
        }
    });
}

/// `{id}` or `{ids: [...]}` from the JSON args.
pub fn ids_of(args: &serde_json::Value) -> Result<Vec<u64>> {
    if let Some(id) = args.get("id").and_then(serde_json::Value::as_u64) {
        return Ok(vec![id]);
    }
    args.get("ids")
        .and_then(serde_json::Value::as_array)
        .map(|a| a.iter().filter_map(serde_json::Value::as_u64).collect())
        .ok_or_else(|| anyhow!("missing probe `id` / `ids`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(n: &str, len: u64) -> (String, u64) {
        (n.to_string(), len)
    }

    #[test]
    fn running_torrent_counts_its_live_peers() {
        // Already in the engine with 5 live peers, no handshake yet: healthy, not "no peer".
        assert_eq!(answering(0, 5), 5);
        assert_eq!(settle(true, Some(true), answering(0, 5), 3, false), Some(ProbeState::Healthy));
        // Not running: only handshakes count.
        assert_eq!(answering(2, 0), 2);
        assert_eq!(settle(true, Some(true), answering(2, 0), 3, false), None);
    }

    #[test]
    fn episode_numbers_are_recognised() {
        assert_eq!(episode_match("[Sub] Show - 05 [1080p].mkv", 5), 2);
        assert_eq!(episode_match("Show.S01E05.1080p.x264.mkv", 5), 2);
        assert_eq!(episode_match("Show S01E05", 1), 0, "season number is not an episode");
        assert_eq!(episode_match("Show Ep. 12 (2019).mkv", 12), 2);
        assert_eq!(episode_match("Show 12.mkv", 12), 1);
        assert_eq!(episode_match("Show - 05v2 [720p].mkv", 2), 0, "version suffix");
        assert_eq!(episode_match("Show - 05 [720p] [10bit].mkv", 10), 0, "bit depth");
        assert_eq!(episode_match("Show - 05 [x264].mkv", 264), 0, "codec");
        assert_eq!(episode_match("Show - 05 [1080p].mkv", 1080), 0, "resolution");
        assert_eq!(episode_match("Season 1/Show - 01.mkv", 1), 2);
        assert_eq!(episode_match("Show - 5.1 audio.mkv", 5), 0, "audio channels");
    }

    #[test]
    fn file_index_and_filename_win() {
        let files = vec![f("a/Show - 01.mkv", 500), f("a/Show - 02.mkv", 500), f("a/readme.txt", 1)];
        assert_eq!(pick_probe_file(&files, Some(1), None, Some(1)), FilePick::File(1));
        assert_eq!(pick_probe_file(&files, Some(2), None, None), FilePick::NoFile("not a video"));
        assert_eq!(pick_probe_file(&files, Some(9), None, None), FilePick::NoFile("file index out of range"));
        assert_eq!(pick_probe_file(&files, None, Some("show - 02.MKV"), Some(1)), FilePick::File(1));
    }

    #[test]
    fn packs_are_searched_by_episode() {
        let pack = vec![f("S/Show - 01 [1080p].mkv", 900), f("S/Show - 02 [1080p].mkv", 1000), f("S/Show - 03 [1080p].mkv", 950)];
        assert_eq!(pick_probe_file(&pack, None, None, Some(2)), FilePick::File(1));
        assert_eq!(pick_probe_file(&pack, None, None, Some(7)), FilePick::NoFile("episode not in this pack"));
        // No episode hint: the largest video, as `start_stream` would.
        assert_eq!(pick_probe_file(&pack, None, None, None), FilePick::File(1));
    }

    #[test]
    fn single_episode_with_extras_is_not_a_pack() {
        let files = vec![f("Show - 05.mkv", 1000), f("NCOP.mkv", 60), f("sample.mkv", 20)];
        // Even if the name does not carry the number (absolute vs season numbering).
        assert_eq!(pick_probe_file(&files, None, None, Some(17)), FilePick::File(0));
        assert_eq!(pick_probe_file(&[f("notes.txt", 3)], None, None, Some(1)), FilePick::NoFile("no video file"));
        assert_eq!(pick_probe_file(&[], None, None, None), FilePick::NoFile("empty torrent"));
    }

    #[test]
    fn probe_state_machine() {
        use ProbeState::*;
        // Still looking.
        assert_eq!(settle(false, None, 5, 3, false), None);
        assert_eq!(settle(true, Some(true), 2, 3, false), None);
        // Healthy as soon as metadata + file + enough answering peers.
        assert_eq!(settle(true, Some(true), 3, 3, false), Some(Healthy));
        // Peers without metadata are not enough.
        assert_eq!(settle(false, None, 9, 3, false), None);
        // Wrong torrent: decided at once.
        assert_eq!(settle(true, Some(false), 9, 3, false), Some(NoFile));
        // Deadline.
        assert_eq!(settle(true, Some(true), 1, 3, true), Some(Weak));
        assert_eq!(settle(false, None, 9, 3, true), Some(Failed));
        assert!(Healthy.is_final() && Cancelled.is_final() && !Queued.is_final() && !Resolving.is_final());
    }

    #[test]
    fn handshakes_scale_with_the_swarm() {
        assert_eq!(handshake_concurrency(0), MIN_HANDSHAKE_CONCURRENCY);
        assert_eq!(handshake_concurrency(40), 20);
        assert_eq!(handshake_concurrency(500), MAX_HANDSHAKE_CONCURRENCY);
        assert_eq!(max_handshakes(0), MIN_HANDSHAKES);
        assert_eq!(max_handshakes(1000), MAX_HANDSHAKES);
        assert!(HANDSHAKE_TIMEOUT <= Duration::from_millis(1_500), "a dead address must not hold a slot long");
    }

    #[test]
    fn fresh_peers_are_tried_before_dht_ones() {
        let a = |i: u8| -> SocketAddr { SocketAddr::from(([10, 0, 0, i], 6881)) };
        let (mut q, mut seen, mut order) = (VecDeque::new(), HashSet::new(), Vec::new());
        // DHT answers first (often stale)…
        enqueue(&mut q, &mut seen, &mut order, &[a(1), a(2)], false);
        // …then the metadata arrives with the peers that served it / the trackers' answers.
        enqueue(&mut q, &mut seen, &mut order, &[a(3), a(4), a(1)], true);
        // a(1) was already queued (not twice); the fresh ones go first, in their order.
        assert_eq!(q.iter().copied().collect::<Vec<_>>(), vec![a(3), a(4), a(1), a(2)]);
        assert_eq!(order, vec![a(1), a(2), a(3), a(4)], "discovery order kept for the meta cache");
    }

    #[test]
    fn timeouts_are_bounded() {
        assert_eq!(clamp_timeout(None), Duration::from_millis(DEFAULT_TIMEOUT_MS));
        assert_eq!(clamp_timeout(Some(10)), Duration::from_millis(MIN_TIMEOUT_MS));
        assert_eq!(clamp_timeout(Some(10_000_000)), Duration::from_millis(MAX_TIMEOUT_MS));
    }

    #[test]
    fn handshake_wire_format() {
        let ih = [7u8; 20];
        let pid = probe_peer_id();
        let hs = handshake_bytes(&ih, &pid);
        assert_eq!(hs[0], 19);
        assert_eq!(&hs[1..20], b"BitTorrent protocol");
        assert_eq!(&hs[20..28], &[0u8; 8], "no extension advertised");
        assert!(handshake_matches(&hs, &ih));
        assert!(!handshake_matches(&hs, &[8u8; 20]));
        assert!(!handshake_matches(&hs[..40], &ih));
        assert_eq!(&pid[..8], b"-HW0100-");
    }

    #[test]
    fn meta_cache_expires_and_orders_peers() {
        let c = MetaCache::default();
        let t0 = Instant::now();
        let a: SocketAddr = "1.1.1.1:1".parse().unwrap();
        let b: SocketAddr = "2.2.2.2:2".parse().unwrap();
        c.insert("h", CachedMeta::new(Bytes::from_static(b"x"), vec![f("a.mkv", 1)], vec![], t0));
        c.set_peers("h", &[b], &[a, b]);
        assert_eq!(c.get("h", t0).unwrap().peers, vec![b, a]);
        assert!(c.get("h", t0 + META_TTL + Duration::from_secs(1)).is_none());
        assert!(c.get("h", t0).is_none(), "expired entry dropped");
        for i in 0..META_CAP + 3 {
            c.insert(&format!("k{i}"), CachedMeta::new(Bytes::new(), vec![], vec![], t0 + Duration::from_secs(i as u64)));
        }
        assert!(c.get("k0", t0).is_none(), "oldest evicted");
        assert!(c.get(&format!("k{}", META_CAP + 2), t0).is_some());
    }

    #[test]
    fn probe_ids_from_args() {
        assert_eq!(ids_of(&serde_json::json!({ "id": 3 })).unwrap(), vec![3]);
        assert_eq!(ids_of(&serde_json::json!({ "ids": [1, 2] })).unwrap(), vec![1, 2]);
        assert!(ids_of(&serde_json::json!({})).is_err());
    }

    /// A fake peer on loopback: answers the handshake for one info hash only.
    #[test]
    fn handshake_against_a_local_peer() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let ih = [9u8; 20];
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                loop {
                    let Ok((mut s, _)) = listener.accept().await else { return };
                    tokio::spawn(async move {
                        let mut buf = [0u8; 68];
                        if s.read_exact(&mut buf).await.is_ok() && handshake_matches(&buf, &ih) {
                            let _ = s.write_all(&handshake_bytes(&ih, &[1u8; 20])).await;
                        }
                    });
                }
            });
            assert!(handshake(addr, ih, probe_peer_id(), Duration::from_secs(2)).await);
            assert!(!handshake(addr, [3u8; 20], probe_peer_id(), Duration::from_millis(500)).await, "other torrent");
            // Nobody listening.
            let closed: SocketAddr = "127.0.0.1:1".parse().unwrap();
            assert!(!handshake(closed, ih, probe_peer_id(), Duration::from_millis(500)).await);
        });
    }
    fn test_engine(tag: &str) -> (Arc<Engine>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("huwa-probe-test-{tag}-{}-{}", std::process::id(), crate::engine::now_secs()));
        let _ = std::fs::remove_dir_all(&dir);
        let config: crate::engine::Config = serde_json::from_value(serde_json::json!({ "dataDir": dir })).unwrap();
        (Engine::new(config).unwrap(), dir)
    }

    fn wait_final(engine: &Engine, id: u64, max: Duration) -> ProbeStatus {
        let end = Instant::now() + max;
        loop {
            let st = engine.probes.get(id).unwrap().status();
            if st.state.is_final() || Instant::now() > end {
                return st;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn files_under(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|it| it.flatten().count()).unwrap_or(0)
    }

    /// No peer will ever answer for this hash: the probe ends `failed` at its deadline, without
    /// anything left in the session or on disk.
    #[test]
    fn unreachable_swarm_fails_at_the_deadline_and_leaves_nothing() {
        let (engine, dir) = test_engine("deadline");
        let req: ProbeRequest = serde_json::from_value(serde_json::json!({
            "infoHash": "00112233445566778899aabbccddeeff00112233", "timeoutMs": 1200
        }))
        .unwrap();
        let st = start(&engine, req).unwrap();
        assert!(matches!(st.state, ProbeState::Queued | ProbeState::Resolving));
        let st = wait_final(&engine, st.id, Duration::from_secs(5));
        assert_eq!(st.state, ProbeState::Failed);
        assert!(st.elapsed_ms >= 1000 && st.elapsed_ms < 4000, "{}", st.elapsed_ms);
        assert_eq!(engine.session.with_torrents(|it| it.count()), 0, "list-only: nothing registered");
        assert_eq!(files_under(&dir.join("torrents")), 0, "nothing written");
        assert_eq!(engine.probes.running(), 0);
        engine.shutdown();
    }

    #[test]
    fn cancel_stops_a_probe_and_slots_are_bounded() {
        let (engine, _dir) = test_engine("cancel");
        let ids: Vec<u64> = (0..MAX_CONCURRENT_PROBES + 2)
            .map(|i| {
                let req: ProbeRequest =
                    serde_json::from_value(serde_json::json!({ "infoHash": format!("{:040x}", i + 1), "timeoutMs": 20000 })).unwrap();
                start(&engine, req).unwrap().id
            })
            .collect();
        std::thread::sleep(Duration::from_millis(300));
        let queued = ids.iter().filter(|id| engine.probes.get(**id).unwrap().status().state == ProbeState::Queued).count();
        assert_eq!(queued, 2, "only MAX_CONCURRENT_PROBES run at once");
        for id in &ids {
            assert!(engine.probes.cancel(*id));
        }
        assert_eq!(engine.probes.get(ids[0]).unwrap().status().state, ProbeState::Cancelled);
        assert_eq!(engine.probes.running(), 0);
        assert!(!engine.probes.cancel(999_999));
        // Slots are given back: a new probe runs at once.
        std::thread::sleep(Duration::from_millis(100));
        let req: ProbeRequest = serde_json::from_value(serde_json::json!({ "infoHash": format!("{:040x}", 77), "timeoutMs": 20000 })).unwrap();
        let id = start(&engine, req).unwrap().id;
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(engine.probes.get(id).unwrap().status().state, ProbeState::Resolving);
        engine.shutdown();
        assert_eq!(engine.probes.get(id).unwrap().status().state, ProbeState::Cancelled);
    }

    /// Real swarm (network): Big Buck Bunny, Blender Foundation, CC-BY (webtorrent's example).
    /// `cargo test -- --ignored probe_public_domain_swarm`
    #[test]
    #[ignore]
    fn probe_public_domain_swarm() {
        let (engine, dir) = test_engine("bbb");
        let hash = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";
        let req: ProbeRequest = serde_json::from_value(serde_json::json!({
            "infoHash": hash,
            "name": "Big Buck Bunny",
            "sources": ["tracker:udp://tracker.opentrackr.org:1337/announce", "tracker:udp://explodie.org:6969", "tracker:udp://tracker.torrent.eu.org:451/announce"],
            "timeoutMs": 30000,
            "minPeers": 2
        }))
        .unwrap();
        let id = start(&engine, req).unwrap().id;
        let st = wait_final(&engine, id, Duration::from_secs(35));
        eprintln!("{}", serde_json::to_string_pretty(&st).unwrap());
        assert!(matches!(st.state, ProbeState::Healthy | ProbeState::Weak), "{:?}", st.state);
        assert!(st.meta_ms.is_some());
        assert!(st.file_name.as_deref().is_some_and(|n| n.ends_with(".mp4")), "{:?}", st.file_name);
        assert_eq!(engine.session.with_torrents(|it| it.count()), 0, "nothing added by the probe");
        assert_eq!(files_under(&dir.join("torrents")), 0, "no piece written by the probe");
        // The stream reuses the metadata: the torrent is ready without a magnet resolution.
        let cached = engine.meta_cache.get(hash, Instant::now()).expect("metadata cached");
        assert!(!cached.files.is_empty());
        let t0 = Instant::now();
        engine
            .start_stream(crate::engine::StartStreamRequest { info_hash: hash.into(), file_idx: st.file_idx, sources: vec![], name: None, metered: false })
            .unwrap();
        let entry = engine.entry(hash).unwrap();
        engine.runtime.block_on(entry.wait_ready(Duration::from_secs(10))).unwrap();
        eprintln!("stream ready in {:?} (metadata reused)", t0.elapsed());
        engine.runtime.block_on(engine.remove(hash)).unwrap();
        engine.shutdown();
    }
}
