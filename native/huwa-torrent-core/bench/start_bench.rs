//! End-to-end start benchmark, offline (see `bench/README.md`):
//! synthetic videos → torrents → local librqbit seeders behind bandwidth/latency-shaping TCP
//! proxies + dead addresses → a local HTTP tracker → the real engine API (probe → `startStream` →
//! loopback HTTP) → the mpv CLI (same options as `MpvCore.swift`, `vo=null`), timing the first
//! frame (`playback-restart` after `file-loaded`, the event the app reports as "first frame").
//!
//! ```sh
//! bench/run.sh --profiles popular,mid,obscure --files h264.mkv --scenarios start,resume,seek --repeat 5
//! ```

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::SocketAddr,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

use huwa_torrent_core::{
    engine::{now_secs, Config, Engine, StartStreamRequest},
    probe::{self, ProbeRequest},
};
use librqbit::{
    spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session, SessionOptions,
    SessionPersistenceConfig,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;

// ------------------------------------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Args {
    fixtures: PathBuf,
    work: PathBuf,
    profiles: Vec<String>,
    files: Vec<String>,
    scenarios: Vec<String>,
    repeat: usize,
    resume_at: f64,
    seek_to: f64,
    play_secs: f64,
    downlink_mbps: f64,
    piece_kib: Option<u64>,
    mpv_opts: Vec<(String, String)>,
    cache_cap: Option<u64>,
    prefill: Option<String>,
    switches: usize,
    switch_every: Duration,
    switch_hard: bool,
    /// Storm: no `release` of the torrent left behind (the app's holds, src/torrent/hold.ts).
    no_release: bool,
    /// Storm: a new mpv per switch (the app creates a player view per watch screen).
    fresh_mpv: bool,
    race_ms: u64,
    presearched: bool,
    prewarm_ms: u64,
    trace: bool,
    out: Option<PathBuf>,
    timeout: Duration,
    seed: u64,
}

fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let (num, mult) = match s.chars().last() {
        Some('G' | 'g') => (&s[..s.len() - 1], 1024 * MIB),
        Some('M' | 'm') => (&s[..s.len() - 1], MIB),
        Some('K' | 'k') => (&s[..s.len() - 1], KIB),
        _ => (s, 1),
    };
    (num.parse::<f64>().unwrap_or_else(|_| panic!("bad size {s}")) * mult as f64) as u64
}

fn parse_duration(s: &str) -> Duration {
    let s = s.trim();
    if let Some(ms) = s.strip_suffix("ms") {
        Duration::from_millis(ms.parse().unwrap())
    } else {
        Duration::from_secs_f64(s.trim_end_matches('s').parse().unwrap())
    }
}

fn parse_args() -> Args {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut a = Args {
        fixtures: root.join("target/bench-fixtures"),
        work: root.join("target/bench-work"),
        profiles: vec!["popular".into(), "mid".into(), "obscure".into()],
        files: vec!["h264.mkv".into()],
        scenarios: vec!["start".into()],
        repeat: 3,
        resume_at: 605.0,
        seek_to: 605.0,
        play_secs: 0.0,
        downlink_mbps: 100.0,
        piece_kib: None,
        mpv_opts: Vec::new(),
        cache_cap: None,
        prefill: None,
        switches: 20,
        switch_every: Duration::from_secs(2),
        switch_hard: false,
        no_release: false,
        fresh_mpv: false,
        race_ms: 2500,
        presearched: false,
        prewarm_ms: 0,
        trace: false,
        out: None,
        timeout: Duration::from_secs(45),
        seed: 7,
    };
    let list = |v: &str| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut val = || it.next().unwrap_or_else(|| panic!("{flag} needs a value"));
        match flag.as_str() {
            "--fixtures" => a.fixtures = val().into(),
            "--work" => a.work = val().into(),
            "--profiles" | "--profile" => a.profiles = list(&val()),
            "--files" | "--file" => a.files = list(&val()),
            "--scenarios" | "--scenario" => a.scenarios = list(&val()),
            "--repeat" => a.repeat = val().parse().unwrap(),
            "--resume-at" => a.resume_at = val().parse().unwrap(),
            "--seek-to" => a.seek_to = val().parse().unwrap(),
            "--play-secs" => a.play_secs = val().parse().unwrap(),
            "--downlink" => a.downlink_mbps = val().trim_end_matches(['M', 'm']).parse().unwrap(),
            "--piece-kib" => a.piece_kib = Some(val().parse().unwrap()),
            "--mpv-opt" => {
                let v = val();
                let (k, v) = v.split_once('=').expect("--mpv-opt key=value");
                a.mpv_opts.push((k.into(), v.into()));
            }
            "--cache-cap" => a.cache_cap = Some(parse_size(&val())),
            "--prefill" => a.prefill = Some(val()),
            "--switches" => a.switches = val().parse().unwrap(),
            "--switch-every" => a.switch_every = parse_duration(&val()),
            "--switch-hard" => a.switch_hard = true,
            "--no-release" => a.no_release = true,
            "--fresh-mpv" => a.fresh_mpv = true,
            "--race-ms" => a.race_ms = val().parse().unwrap(),
            "--presearched" => a.presearched = true,
            "--prewarm-ms" => a.prewarm_ms = val().parse().unwrap(),
            "--trace" => a.trace = true,
            "--out" => a.out = Some(val().into()),
            "--timeout" => a.timeout = parse_duration(&val()),
            "--seed" => a.seed = val().parse().unwrap(),
            "--help" | "-h" => {
                println!("see bench/README.md");
                std::process::exit(0);
            }
            other => panic!("unknown flag {other} (see bench/README.md)"),
        }
    }
    a
}

/// Deterministic xorshift.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn range_f(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() % 10_000) as f64 / 10_000.0
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Swarm profiles
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Profile {
    name: String,
    live: usize,
    rate: (f64, f64),
    rtt_ms: (f64, f64),
    dead: usize,
}

fn profile(name: &str) -> Profile {
    let (base, dead) = match name.strip_suffix("-dead") {
        Some(b) => (b, true),
        None => (name, false),
    };
    let (live, rate, rtt) = match base {
        "popular" => (30, (1e6, 3e6), (20.0, 80.0)),
        "mid" => (6, (5e5, 5e5), (40.0, 100.0)),
        "obscure" => (1, (3e5, 3e5), (150.0, 150.0)),
        "obscure2" => (2, (3e5, 3e5), (150.0, 150.0)),
        // Network out of the way (engine + mpv floor).
        "lan" => (3, (50e6, 50e6), (1.0, 1.0)),
        other => panic!("unknown profile {other}"),
    };
    // 80 % of the peer list dead: 4 dead addresses per live one.
    Profile { name: name.into(), live, rate, rtt_ms: rtt, dead: if dead { live * 4 } else { 0 } }
}

// ------------------------------------------------------------------------------------------------
// Network shaping: one TCP proxy per simulated seeder
// ------------------------------------------------------------------------------------------------

/// The client's access link (Wi-Fi), shared by every peer.
struct Downlink {
    rate: f64,
    next: Mutex<tokio::time::Instant>,
}

impl Downlink {
    async fn pass(&self, bytes: usize) {
        let at = {
            let mut next = self.next.lock();
            let now = tokio::time::Instant::now();
            let start = (*next).max(now);
            *next = start + Duration::from_secs_f64(bytes as f64 / self.rate);
            *next
        };
        tokio::time::sleep_until(at).await;
    }
}

#[derive(Default)]
struct NetStats {
    /// Peer connections open right now (through the proxies).
    conns: AtomicUsize,
    /// Bytes sent by the seeders and not yet delivered to the client (requested, in flight).
    queued: AtomicU64,
    delivered: AtomicU64,
}

#[derive(Clone)]
struct Link {
    rate: f64,
    one_way: Duration,
    /// When the peer's uplink is free again: shared by all its connections (probe handshake,
    /// metadata, stream).
    uplink_free: Arc<Mutex<tokio::time::Instant>>,
}

async fn proxy_conn(client: TcpStream, upstream: SocketAddr, link: Link, downlink: Option<Arc<Downlink>>, stats: Arc<NetStats>) {
    let _ = client.set_nodelay(true);
    // TCP handshake of a real link: one RTT before the first byte can go out.
    tokio::time::sleep(link.one_way * 2).await;
    let Ok(up) = TcpStream::connect(upstream).await else { return };
    let _ = up.set_nodelay(true);
    stats.conns.fetch_add(1, Ordering::Relaxed);
    let (mut cr, mut cw) = client.into_split();
    let (mut ur, mut uw) = up.into_split();
    let one_way = link.one_way;

    // client → seeder: latency only (requests are small).
    let (tx_up, mut rx_up) = tokio::sync::mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
    let up_reader = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match cr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx_up.send((tokio::time::Instant::now() + one_way, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let up_writer = tokio::spawn(async move {
        while let Some((at, data)) = rx_up.recv().await {
            tokio::time::sleep_until(at).await;
            if uw.write_all(&data).await.is_err() {
                break;
            }
        }
        let _ = uw.shutdown().await;
    });

    // seeder → client: the peer's upload rate (queue at its uplink), latency, then the client downlink.
    let (tx_dn, mut rx_dn) = tokio::sync::mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
    let stats_r = stats.clone();
    let rate = link.rate;
    let uplink = link.uplink_free.clone();
    let dn_reader = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match ur.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let now = tokio::time::Instant::now();
                    let sent = {
                        let mut free = uplink.lock();
                        *free = (*free).max(now) + Duration::from_secs_f64(n as f64 / rate);
                        *free
                    };
                    stats_r.queued.fetch_add(n as u64, Ordering::Relaxed);
                    if tx_dn.send((sent + one_way, buf[..n].to_vec())).is_err() {
                        stats_r.queued.fetch_sub(n as u64, Ordering::Relaxed);
                        break;
                    }
                }
            }
        }
    });
    let stats_w = stats.clone();
    let dn_writer = tokio::spawn(async move {
        let mut open = true;
        while let Some((at, data)) = rx_dn.recv().await {
            if open {
                tokio::time::sleep_until(at).await;
                if let Some(d) = &downlink {
                    d.pass(data.len()).await;
                }
                if cw.write_all(&data).await.is_err() {
                    open = false;
                }
            }
            stats_w.queued.fetch_sub(data.len() as u64, Ordering::Relaxed);
            stats_w.delivered.fetch_add(data.len() as u64, Ordering::Relaxed);
            if !open {
                break;
            }
        }
        // What the seeder sent for a closed connection never reaches anyone: not in flight any more.
        rx_dn.close();
        while let Ok((_, data)) = rx_dn.try_recv() {
            stats_w.queued.fetch_sub(data.len() as u64, Ordering::Relaxed);
        }
        let _ = cw.shutdown().await;
    });
    let _ = tokio::join!(up_reader, up_writer, dn_reader, dn_writer);
    stats.conns.fetch_sub(1, Ordering::Relaxed);
}

struct Swarm {
    peers: Vec<SocketAddr>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Swarm {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

async fn spawn_swarm(p: &Profile, seeder: SocketAddr, downlink: Option<Arc<Downlink>>, stats: Arc<NetStats>, rng: &mut Rng) -> Swarm {
    let mut peers = Vec::new();
    let mut tasks = Vec::new();
    for _ in 0..p.live {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        peers.push(listener.local_addr().unwrap());
        let link = Link {
            rate: rng.range_f(p.rate.0, p.rate.1),
            one_way: Duration::from_secs_f64(rng.range_f(p.rtt_ms.0, p.rtt_ms.1) / 2000.0),
            uplink_free: Arc::new(Mutex::new(tokio::time::Instant::now())),
        };
        let (downlink, stats) = (downlink.clone(), stats.clone());
        tasks.push(tokio::spawn(async move {
            let mut conns = Vec::new();
            while let Ok((c, _)) = listener.accept().await {
                conns.push(tokio::spawn(proxy_conn(c, seeder, link.clone(), downlink.clone(), stats.clone())));
            }
            for c in conns {
                c.abort();
            }
        }));
    }
    for i in 0..p.dead {
        if i % 2 == 0 {
            // No such host: 127.0.0.x (x ≥ 2) is not configured on macOS's lo0, a connect times out.
            let ip = [127, 0, 0, 2 + (rng.next() % 250) as u8];
            peers.push(SocketAddr::from((ip, 10_000 + (rng.next() % 50_000) as u16)));
        } else {
            // Host up, port closed: connection refused.
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            peers.push(l.local_addr().unwrap());
        }
    }
    rng.shuffle(&mut peers);
    Swarm { peers, tasks }
}

// ------------------------------------------------------------------------------------------------
// Local HTTP tracker
// ------------------------------------------------------------------------------------------------

type PeerTable = Arc<Mutex<HashMap<String, Vec<SocketAddr>>>>;

fn url_decode_bytes(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(0));
            i += 3;
        } else if b[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

async fn run_tracker(listener: TcpListener, table: PeerTable) {
    loop {
        let Ok((mut c, _)) = listener.accept().await else { return };
        let table = table.clone();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 2048];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match c.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let req = String::from_utf8_lossy(&buf).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("");
            let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let hash = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("info_hash="))
                .map(|v| hex::encode(url_decode_bytes(v)))
                .unwrap_or_default();
            let peers = table.lock().get(&hash).cloned().unwrap_or_default();
            let mut compact = Vec::new();
            for p in &peers {
                if let SocketAddr::V4(v4) = p {
                    compact.extend_from_slice(&v4.ip().octets());
                    compact.extend_from_slice(&v4.port().to_be_bytes());
                }
            }
            let mut body = format!("d8:completei{}e10:incompletei0e8:intervali1800e5:peers{}:", peers.len(), compact.len()).into_bytes();
            body.extend_from_slice(&compact);
            body.push(b'e');
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = c.write_all(head.as_bytes()).await;
            let _ = c.write_all(&body).await;
            let _ = c.shutdown().await;
        });
    }
}

// ------------------------------------------------------------------------------------------------
// Fixtures: torrents and the seeder session
// ------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Fixture {
    name: String,
    hex: String,
    bytes: bytes::Bytes,
}

fn default_piece(len: u64) -> u64 {
    if len > 800 * MIB {
        MIB
    } else {
        512 * KIB
    }
}

/// `.torrent` for `path` (cached next to the fixtures: hashing a GiB takes a while).
async fn torrent_for(args: &Args, path: &Path) -> Fixture {
    let len = std::fs::metadata(path).unwrap_or_else(|e| panic!("{path:?}: {e} (run bench/make-fixtures.sh)")).len();
    let piece = args.piece_kib.map(|k| k * KIB).unwrap_or_else(|| default_piece(len));
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    let cache = args.fixtures.join("torrents").join(format!("{name}.{}k.torrent", piece / KIB));
    let bytes = match std::fs::read(&cache) {
        Ok(b) => bytes::Bytes::from(b),
        Err(_) => {
            let created = librqbit::create_torrent(
                path,
                CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(piece as u32) },
                &BlockingSpawner::new(4),
            )
            .await
            .unwrap();
            let b = created.as_bytes().unwrap();
            std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
            std::fs::write(&cache, &b).unwrap();
            b
        }
    };
    let info = librqbit::torrent_from_bytes(&bytes).unwrap();
    let hex = info.info_hash.as_string().to_lowercase();
    Fixture { name, hex, bytes }
}

async fn seeder_session(args: &Args, dir: &Path) -> (Arc<Session>, SocketAddr) {
    let addr = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let state = args.work.join("seeder-session");
    std::fs::create_dir_all(&state).unwrap();
    let session = Session::new_with_opts(
        dir.to_path_buf(),
        SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json { folder: Some(state) }),
            listen: Some(ListenerOptions { listen_addr: addr, ipv4_only: true, ..Default::default() }),
            concurrent_init_limit: Some(8),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    (session, addr)
}

async fn seed(session: &Arc<Session>, f: &Fixture, dir: &Path) {
    let added = session
        .add_torrent(
            AddTorrent::from_bytes(f.bytes.clone()),
            Some(AddTorrentOptions { overwrite: true, output_folder: Some(dir.to_string_lossy().into_owned()), ..Default::default() }),
        )
        .await
        .unwrap();
    let h = added.into_handle().unwrap();
    h.wait_until_completed().await.unwrap();
}

// ------------------------------------------------------------------------------------------------
// mpv, driven like MpvCore.swift
// ------------------------------------------------------------------------------------------------

/// `MpvCore.start()` options, minus the iOS render path (`wid`, gpu-next/vulkan/moltenvk): `vo=null`.
fn mpv_core_options() -> Vec<(String, String)> {
    [
        ("vo", "null"),
        ("ao", "null"),
        ("hwdec", "auto-safe"),
        ("profile", "fast"),
        ("video-rotate", "no"),
        ("cache", "yes"),
        ("demuxer-max-bytes", "48MiB"),
        ("demuxer-max-back-bytes", "16MiB"),
        ("demuxer-readahead-secs", "20"),
        ("cache-pause-initial", "no"),
        ("cache-pause-wait", "2"),
        ("demuxer-lavf-analyzeduration", "1"),
        ("demuxer-lavf-probesize", "2097152"),
        ("network-timeout", "20"),
        ("keep-open", "yes"),
        ("idle", "yes"),
        ("sub-ass", "yes"),
        ("embeddedfonts", "yes"),
        ("sub-use-margins", "yes"),
        ("sub-ass-force-margins", "yes"),
        ("sid", "no"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("terminal", "no"),
        ("load-scripts", "no"),
        ("config", "no"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

const LUA: &str = r#"
local loaded = false
local first = false
local function out(s) io.stdout:write(s .. "\n"); io.stdout:flush() end
mp.register_event("start-file", function() loaded = false; first = false end)
mp.register_event("file-loaded", function() loaded = true; out("LOADED") end)
mp.register_event("playback-restart", function()
  if not loaded then return end
  -- MpvCore: precise seeks again after the first frame (a resume opens on the keyframe).
  if not first then first = true; mp.set_property("hr-seek", "default") end
  out("RESTART")
end)
mp.register_event("end-file", function(e) out("END " .. tostring(e.reason) .. " " .. tostring(e.error)) end)
mp.observe_property("paused-for-cache", "bool", function(_, v) out("CACHE " .. tostring(v)) end)
"#;

struct Mpv {
    child: Child,
    ipc: UnixStream,
    rx: mpsc::Receiver<(Instant, String)>,
    sock: PathBuf,
}

impl Mpv {
    fn spawn(args: &Args, tag: &str) -> Mpv {
        let dir = std::env::temp_dir();
        let script = dir.join("huwa-bench.lua");
        std::fs::write(&script, LUA).unwrap();
        let sock = dir.join(format!("huwa-mpv-{}-{tag}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let mut opts = mpv_core_options();
        for (k, v) in &args.mpv_opts {
            opts.retain(|(ok, _)| ok != k);
            opts.push((k.clone(), v.clone()));
        }
        let mut cmd = Command::new("mpv");
        for (k, v) in &opts {
            cmd.arg(format!("--{k}={v}"));
        }
        cmd.arg(format!("--script={}", script.display()));
        cmd.arg(format!("--input-ipc-server={}", sock.display()));
        let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null()).spawn().expect("mpv");
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send((Instant::now(), line)).is_err() {
                    break;
                }
            }
        });
        let end = Instant::now() + Duration::from_secs(10);
        let ipc = loop {
            if let Ok(s) = UnixStream::connect(&sock) {
                break s;
            }
            assert!(Instant::now() < end, "mpv IPC socket never appeared");
            std::thread::sleep(Duration::from_millis(20));
        };
        let reader = ipc.try_clone().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                if line.is_err() {
                    break;
                }
            }
        });
        Mpv { child, ipc, rx, sock }
    }

    fn cmd(&mut self, c: Value) {
        let mut s = json!({ "command": c }).to_string();
        s.push('\n');
        self.ipc.write_all(s.as_bytes()).unwrap();
    }

    /// `MpvCore.load`: `start`, `pause=no`, loopback network timeout, then `loadfile … replace`.
    fn load(&mut self, url: &str, start: f64) {
        self.cmd(json!(["set_property", "start", if start > 1.0 { format!("{start:.3}") } else { "none".into() }]));
        // MpvCore since the start fixes: a resume opens on the keyframe (the baseline build of
        // the bench, `--cfg huwa_baseline`, keeps mpv's default like the app before them).
        #[cfg(not(huwa_baseline))]
        self.cmd(json!(["set_property", "hr-seek", if start > 1.0 { "no" } else { "default" }]));
        self.cmd(json!(["set_property", "pause", "no"]));
        self.cmd(json!(["set_property", "network-timeout", "120"]));
        self.cmd(json!(["loadfile", url, "replace"]));
    }

    /// Next line starting with `prefix` (other lines are passed to `other`).
    fn wait(&self, prefix: &str, until: Instant, other: &mut dyn FnMut(Instant, &str)) -> Option<Instant> {
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.rx.recv_timeout(left) {
                Ok((t, line)) if line.starts_with(prefix) => return Some(t),
                Ok((t, line)) => other(t, &line),
                Err(mpsc::RecvTimeoutError::Timeout) => return None,
                Err(_) => return None,
            }
        }
    }

    fn drain(&self, other: &mut dyn FnMut(Instant, &str)) {
        while let Ok((t, line)) = self.rx.try_recv() {
            other(t, &line);
        }
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.sock);
    }
}

/// Counts `paused-for-cache` stalls after the first frame.
#[derive(Default, Debug, Clone)]
struct Stalls {
    count: u32,
    total: Duration,
    since: Option<Instant>,
}

impl Stalls {
    fn on_line(&mut self, t: Instant, line: &str, after: Option<Instant>) {
        let Some(after) = after else { return };
        if t < after {
            return;
        }
        match line {
            "CACHE true" => {
                if self.since.is_none() {
                    self.since = Some(t);
                    self.count += 1;
                }
            }
            "CACHE false" => {
                if let Some(s) = self.since.take() {
                    self.total += t - s;
                }
            }
            _ => {}
        }
    }
}

// ------------------------------------------------------------------------------------------------
// HTTP trace between mpv and the engine (`--trace`)
// ------------------------------------------------------------------------------------------------

async fn run_trace_proxy(listener: TcpListener, target: u16, t0: Arc<Mutex<Instant>>) {
    let mut id = 0u32;
    while let Ok((c, _)) = listener.accept().await {
        id += 1;
        let t0 = t0.clone();
        tokio::spawn(async move {
            let Ok(s) = TcpStream::connect(("127.0.0.1", target)).await else { return };
            let (mut cr, mut cw) = c.into_split();
            let (mut sr, mut sw) = s.into_split();
            let t0b = t0.clone();
            let a = tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                while let Ok(n) = cr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&buf[..n]);
                    for l in text.lines().filter(|l| l.starts_with("GET") || l.to_ascii_lowercase().starts_with("range")) {
                        println!("    [trace +{:>5}ms c{id}] {l}", t0.lock().elapsed().as_millis());
                    }
                    if sw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
            let b = tokio::spawn(async move {
                let mut buf = vec![0u8; 256 * 1024];
                let mut first = true;
                let mut total = 0u64;
                while let Ok(n) = sr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if first {
                        println!("    [trace +{:>5}ms c{id}] first response bytes", t0b.lock().elapsed().as_millis());
                        first = false;
                    }
                    total += n as u64;
                    if cw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
                println!("    [trace +{:>5}ms c{id}] closed after {} KiB", t0b.lock().elapsed().as_millis(), total / 1024);
            });
            let _ = tokio::join!(a, b);
        });
    }
}

// ------------------------------------------------------------------------------------------------
// Runs
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, serde::Serialize)]
struct RunResult {
    profile: String,
    file: String,
    scenario: String,
    rep: usize,
    /// Probe start → race decision.
    probe_ms: u64,
    probe_state: String,
    /// `startStream` → first frame (the tap when the race result was presearched).
    start_to_frame_ms: Option<u64>,
    /// Probe start → first frame (the race runs at the tap).
    tap_to_frame_ms: Option<u64>,
    seek_ms: Option<u64>,
    stalls: u32,
    stall_ms: u64,
    /// `Engine::new` + server start (restores every cached torrent; the app does it lazily at the
    /// first torrent play of a session, before the race).
    launch_ms: u64,
    /// Data folder size (allocated) before the start, at the first frame, and at the end.
    disk_before_mib: u64,
    disk_at_frame_mib: u64,
    disk_end_mib: u64,
    /// Cache evictions the engine did during the run (count, bytes, time; `EngineStats`).
    evictions: Value,
    timeline: Value,
    note: String,
    /// Diagnostics: peer connections still open through the proxies when the run started, and the
    /// seeder session's live peers then.
    net_conns_before: usize,
    seeder_peers_before: u32,
}

struct Bench {
    args: Args,
    rt: tokio::runtime::Runtime,
    tracker_url: String,
    table: PeerTable,
    seeder: Arc<Session>,
    seeder_addr: SocketAddr,
    seed_dir: PathBuf,
    downlink: Option<Arc<Downlink>>,
    net: Arc<NetStats>,
    rng: Mutex<Rng>,
    fixtures: Mutex<HashMap<String, Fixture>>,
    run_id: AtomicUsize,
}

impl Bench {
    fn new(args: Args) -> Bench {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
        std::fs::create_dir_all(&args.work).unwrap();
        let seed_dir = args.work.join("seed");
        std::fs::create_dir_all(&seed_dir).unwrap();
        let table: PeerTable = Default::default();
        let (tracker_url, seeder, seeder_addr) = rt.block_on(async {
            let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let url = format!("http://127.0.0.1:{}/announce", l.local_addr().unwrap().port());
            tokio::spawn(run_tracker(l, table.clone()));
            let (s, a) = seeder_session(&args, &seed_dir).await;
            (url, s, a)
        });
        let downlink = (args.downlink_mbps > 0.0)
            .then(|| Arc::new(Downlink { rate: args.downlink_mbps * 1e6 / 8.0, next: Mutex::new(tokio::time::Instant::now()) }));
        let seed = args.seed;
        Bench {
            args,
            rt,
            tracker_url,
            table,
            seeder,
            seeder_addr,
            seed_dir,
            downlink,
            net: Default::default(),
            rng: Mutex::new(Rng(seed | 1)),
            fixtures: Default::default(),
            run_id: AtomicUsize::new(0),
        }
    }

    /// Torrent for fixture `file` under the name `alias` (a hard link: a distinct info hash for
    /// the same bytes, for the switch storm).
    fn fixture(&self, file: &str, alias: &str) -> Fixture {
        if let Some(f) = self.fixtures.lock().get(alias) {
            return f.clone();
        }
        let src = self.args.fixtures.join(file);
        let link = self.seed_dir.join(alias);
        if !link.exists() {
            std::fs::hard_link(&src, &link).unwrap_or_else(|e| panic!("link {src:?}: {e} (run bench/make-fixtures.sh)"));
        }
        let f = self.rt.block_on(async {
            let f = torrent_for(&self.args, &link).await;
            seed(&self.seeder, &f, &self.seed_dir).await;
            f
        });
        self.fixtures.lock().insert(alias.to_string(), f.clone());
        f
    }

    fn swarm_for(&self, f: &Fixture, p: &Profile) -> Swarm {
        let mut rng = Rng(self.rng.lock().next() | 1);
        let swarm = self.rt.block_on(spawn_swarm(p, self.seeder_addr, self.downlink.clone(), self.net.clone(), &mut rng));
        self.table.lock().insert(f.hex.clone(), swarm.peers.clone());
        swarm
    }

    fn engine(&self, data_dir: &Path) -> Arc<Engine> {
        let mut cfg = json!({ "dataDir": data_dir, "defaultTrackers": [self.tracker_url] });
        if let Some(cap) = self.args.cache_cap {
            cfg["cacheLimitBytes"] = json!(cap);
        }
        let config: Config = serde_json::from_value(cfg).unwrap();
        let engine = Engine::new(config).unwrap();
        engine.runtime.block_on(huwa_torrent_core::server::start(engine.clone())).unwrap();
        engine
    }

    fn fresh_dir(&self, tag: &str) -> PathBuf {
        let n = self.run_id.fetch_add(1, Ordering::Relaxed);
        let d = self.args.work.join(format!("leech-{}-{n}-{tag}", now_secs()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// The torrent race at the tap: one probe (the winner), decision when it settles or at
    /// `race_ms`, like `src/torrent/peer-race.ts`.
    fn probe(&self, engine: &Arc<Engine>, f: &Fixture) -> (u64, String) {
        let t = Instant::now();
        let st = probe::start(
            engine,
            ProbeRequest {
                info_hash: f.hex.clone(),
                sources: vec![format!("tracker:{}", self.tracker_url)],
                name: Some(f.name.clone()),
                file_idx: None,
                filename: Some(f.name.clone()),
                episode: None,
                timeout_ms: Some(3000),
                min_peers: None,
            },
        )
        .unwrap();
        let p = engine.probes.get(st.id).unwrap();
        // `src/torrent/peer-race.ts` for one candidate, polled every `PEER_POLL_MS` (200 ms):
        // healthy → go; at `SOFT_COMMIT_MS` (1.5 s) with the file known and an answering peer;
        // at the deadline (`--race-ms`, 2.5 s) anyway.
        let state = loop {
            std::thread::sleep(Duration::from_millis(200));
            let s = p.status();
            let e = t.elapsed();
            let soft = e >= Duration::from_millis(1500) && s.connected > 0 && s.file_idx.is_some();
            if s.state.is_final() || soft || e >= Duration::from_millis(self.args.race_ms) {
                break format!("{:?}", s.state).to_lowercase() + &format!("/{}peers", s.connected);
            }
        };
        // The race commits: the app cancels the probes still running (use-peer-race.ts).
        engine.probes.cancel(st.id);
        (t.elapsed().as_millis() as u64, state)
    }

    fn start_stream(&self, engine: &Arc<Engine>, f: &Fixture) -> String {
        let resp = engine
            .start_stream(StartStreamRequest {
                info_hash: f.hex.clone(),
                file_idx: None,
                sources: vec![format!("tracker:{}", self.tracker_url)],
                name: Some(f.name.clone()),
                metered: false,
            })
            .unwrap();
        resp.url
    }

    /// One start / resume / seek / play run on a fresh engine.
    fn run_one(&self, profile_name: &str, file: &str, scenario: &str, rep: usize) -> RunResult {
        let p = profile(profile_name);
        let f = self.fixture(file, file);
        let _swarm = self.swarm_for(&f, &p);
        let dir = self.fresh_dir("run");
        if let Some(prefill) = &self.args.prefill {
            prefill_cache(self, &dir, prefill);
        }
        let disk_before = allocated_bytes(&dir) / MIB;
        let mut mpv = Mpv::spawn(&self.args, "run");
        let t_launch = Instant::now();
        let engine = self.engine(&dir);
        let mut r = RunResult { profile: p.name.clone(), file: file.into(), scenario: scenario.into(), rep, ..Default::default() };
        r.net_conns_before = self.net.conns.load(Ordering::Relaxed);
        r.seeder_peers_before = self.seeder.with_torrents(|it| it.map(|(_, h)| h.stats().live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0)).sum());
        r.launch_ms = t_launch.elapsed().as_millis() as u64;
        r.disk_before_mib = disk_before;

        let mut t_tap = Instant::now();
        let (probe_ms, state) = self.probe(&engine, &f);
        r.probe_ms = probe_ms;
        r.probe_state = state;
        if self.args.prewarm_ms > 0 {
            prewarm(self, &engine, &f);
        }
        if self.args.presearched || self.args.prewarm_ms > 0 {
            // The race ran in the pre-search, before the tap.
            t_tap = Instant::now();
        }
        let t_start = Instant::now();
        let url = self.start_stream(&engine, &f);
        let trace_t0 = Arc::new(Mutex::new(t_start));
        let url = if self.args.trace {
            let port = engine.port();
            let l = self.rt.block_on(TcpListener::bind(("127.0.0.1", 0))).unwrap();
            let tp = l.local_addr().unwrap().port();
            self.rt.spawn(run_trace_proxy(l, port, trace_t0.clone()));
            url.replace(&format!(":{port}/"), &format!(":{tp}/"))
        } else {
            url
        };
        let start_pos = if scenario == "resume" { self.args.resume_at } else { 0.0 };
        mpv.load(&url, start_pos);
        let mut stalls = Stalls::default();
        let deadline = t_start + self.args.timeout;
        let mut first: Option<Instant> = None;
        let ff = mpv.wait("RESTART", deadline, &mut |_, l| {
            if l.starts_with("END") {
                println!("    mpv: {l}");
            }
        });
        if let Some(t) = ff {
            first = Some(t);
            r.start_to_frame_ms = Some((t - t_start).as_millis() as u64);
            r.tap_to_frame_ms = Some((t - t_tap).as_millis() as u64);
            r.disk_at_frame_mib = allocated_bytes(&dir) / MIB;
        } else {
            r.note = format!("no first frame (proxied conns before {}, seeder peers before {})", r.net_conns_before, r.seeder_peers_before);
        }
        if scenario == "seek" && first.is_some() {
            std::thread::sleep(Duration::from_secs(1));
            mpv.drain(&mut |t, l| stalls.on_line(t, l, first));
            let ts = Instant::now();
            *trace_t0.lock() = ts;
            mpv.cmd(json!(["seek", format!("{:.3}", self.args.seek_to), "absolute"]));
            match mpv.wait("RESTART", ts + self.args.timeout, &mut |t, l| stalls.on_line(t, l, first)) {
                Some(t) => r.seek_ms = Some((t - ts).as_millis() as u64),
                None => r.note = "seek: no frame".into(),
            }
        }
        if self.args.play_secs > 0.0 {
            if let Some(f0) = first {
                let until = f0 + Duration::from_secs_f64(self.args.play_secs);
                let _ = mpv.wait("\u{1}never", until, &mut |t, l| stalls.on_line(t, l, first));
                if let Some(s) = stalls.since.take() {
                    stalls.total += Instant::now() - s;
                }
            }
        }
        r.stalls = stalls.count;
        r.stall_ms = stalls.total.as_millis() as u64;
        r.disk_end_mib = allocated_bytes(&dir) / MIB;
        #[cfg(not(huwa_baseline))]
        {
            r.evictions = serde_json::to_value(engine.stats().evictions).unwrap_or(Value::Null);
        }
        r.timeline = engine.status(&f.hex).map(|s| serde_json::to_value(s.start).unwrap()).unwrap_or(Value::Null);
        drop(mpv);
        engine.shutdown();
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
        r
    }
}

/// Default cache cap of the engine (`Config::cache_limit_bytes`).
const DEFAULT_CAP: u64 = 5 * 1024 * MIB;

fn prefill_target(b: &Bench, spec: &str) -> u64 {
    let cap = b.args.cache_cap.unwrap_or(DEFAULT_CAP);
    match spec.strip_suffix('%') {
        Some(p) => (cap as f64 * p.parse::<f64>().unwrap() / 100.0) as u64,
        None => parse_size(spec),
    }
}

fn write_random(path: &Path, len: u64, seed: u64) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut f = std::io::BufWriter::with_capacity(8 * MIB as usize, std::fs::File::create(path).unwrap());
    let mut rng = Rng(seed | 1);
    let mut buf = vec![0u8; 4 * MIB as usize];
    for c in buf.chunks_mut(8) {
        c.copy_from_slice(&rng.next().to_le_bytes()[..c.len()]);
    }
    let mut left = len;
    let mut block = 0u64;
    while left > 0 {
        // Every 4 MiB block differs (its first bytes), like real media.
        buf[..8].copy_from_slice(&(block ^ seed).to_le_bytes());
        let n = left.min(buf.len() as u64) as usize;
        f.write_all(&buf[..n]).unwrap();
        left -= n as u64;
        block += 1;
    }
    f.flush().unwrap();
}

/// A cache filled the way the engine fills it: torrents streamed earlier (single episodes and
/// season packs, real piece files under `<dataDir>/torrents`, librqbit's session + fastresume
/// state, `huwa-entries.json`), built once per size through a real engine, then cloned (APFS
/// `cp -c`, instant) for every run.
fn prefill_cache(b: &Bench, dir: &Path, spec: &str) {
    let target = prefill_target(b, spec);
    if target == 0 {
        return;
    }
    let tpl = b.args.work.join(format!("prefill-{}M", target / MIB));
    if !tpl.join("done").exists() {
        let t = Instant::now();
        let _ = std::fs::remove_dir_all(&tpl);
        let engine = b.engine(&tpl);
        let mut rng = Rng(0xC0FFEE);
        let (mut total, mut i) = (0u64, 0usize);
        let mut hashes = Vec::new();
        while total < target {
            let left = target - total;
            let pack = i % 3 == 2;
            let name = if pack { format!("[Bench] Show {i:03} (S01 1080p)") } else { format!("[Bench] Show {i:03} - 01 (1080p).mkv") };
            let root = tpl.join("torrents").join(&name);
            let mut files = Vec::new();
            if pack {
                let count = 12;
                let each = ((rng.range_f(250.0, 400.0) * MIB as f64) as u64).min(left / count).max(MIB);
                for e in 1..=count {
                    let fname = format!("Show {i:03} - {e:02}.mkv");
                    write_random(&root.join(&fname), each, (i * 100 + e as usize) as u64);
                    files.push((format!("{name}/{fname}"), each));
                }
                // Subtitles / extras next to the episodes.
                write_random(&root.join("Extras/readme.txt"), 4096, i as u64);
                files.push((format!("{name}/Extras/readme.txt"), 4096));
            } else {
                let len = ((rng.range_f(350.0, 1400.0) * MIB as f64) as u64).min(left).max(MIB);
                write_random(&root, len, i as u64);
                files.push((name.clone(), len));
            }
            let size: u64 = files.iter().map(|(_, l)| *l).sum();
            let piece = if size > 800 * MIB { MIB } else { 512 * KIB };
            // (The spawner needs the runtime: built inside it.)
            let created = b
                .rt
                .block_on(async {
                    librqbit::create_torrent(&root, CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(piece as u32) }, &BlockingSpawner::new(4))
                        .await
                })
                .unwrap();
            let hex = created.info_hash().as_string().to_lowercase();
            let bytes = created.as_bytes().unwrap();
            // (Only used to pick the played file: the order does not matter here.)
            let meta_files = files.clone();
            engine.meta_cache.insert(&hex, huwa_torrent_core::probe::CachedMeta::new(bytes, meta_files, vec![], Instant::now()));
            engine
                .start_stream(StartStreamRequest { info_hash: hex.clone(), file_idx: None, sources: vec![], name: Some(name), metered: false })
                .unwrap();
            hashes.push(hex);
            total += size;
            i += 1;
        }
        for hex in &hashes {
            let entry = engine.entry(hex).unwrap();
            let h = engine.runtime.block_on(entry.wait_ready(Duration::from_secs(600))).unwrap();
            engine.runtime.block_on(h.wait_until_initialized()).unwrap();
        }
        engine.shutdown();
        drop(engine);
        std::fs::write(tpl.join("done"), format!("{} torrents, {} MiB", hashes.len(), total / MIB)).unwrap();
        println!("prefill: {} torrents, {} MiB built in {:.1} s", hashes.len(), total / MIB, t.elapsed().as_secs_f64());
    }
    let _ = std::fs::remove_dir_all(dir);
    let ok = Command::new("cp").arg("-cR").arg(&tpl).arg(dir).status().unwrap().success();
    assert!(ok, "cp -c failed");
    let _ = std::fs::remove_file(dir.join("done"));
    // librqbit's session files hold absolute output folders: point them at the clone.
    let (from, to) = (tpl.to_string_lossy().to_string(), dir.to_string_lossy().to_string());
    for e in std::fs::read_dir(dir.join("session")).unwrap().flatten() {
        if e.path().extension().is_some_and(|x| x == "json") {
            let s = std::fs::read_to_string(e.path()).unwrap();
            if s.contains(&from) {
                std::fs::write(e.path(), s.replace(&from, &to)).unwrap();
            }
        }
    }
}

/// Pre-search on Wi-Fi (src/addons/use-source.ts): the race winner is pre-warmed while the user
/// is still on the detail page (`--prewarm-ms` of browsing), then the tap starts it.
fn prewarm(b: &Bench, engine: &Arc<Engine>, f: &Fixture) {
    #[cfg(huwa_baseline)]
    let _ = (b, engine, f);
    #[cfg(not(huwa_baseline))]
    engine
        .prewarm(StartStreamRequest {
            info_hash: f.hex.clone(),
            file_idx: None,
            sources: vec![format!("tracker:{}", b.tracker_url)],
            name: Some(f.name.clone()),
            metered: false,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(b.args.prewarm_ms));
}

fn median(v: &mut [u64]) -> Option<u64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    Some(v[v.len() / 2])
}

fn fmt_ms(v: Option<u64>) -> String {
    v.map(|m| format!("{:.2}", m as f64 / 1000.0)).unwrap_or_else(|| "—".into())
}

fn summarize(results: &[RunResult]) {
    println!("\n| profile | file | scenario | n | start→frame median (s) | worst | tap→frame median (s) | worst | seek median (s) | worst | probe (s) | stalls |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut keys: Vec<(String, String, String)> = Vec::new();
    for r in results {
        let k = (r.profile.clone(), r.file.clone(), r.scenario.clone());
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    for (p, f, s) in keys {
        let rs: Vec<&RunResult> = results.iter().filter(|r| r.profile == p && r.file == f && r.scenario == s).collect();
        let miss = rs.iter().filter(|r| r.start_to_frame_ms.is_none()).count();
        let worst = |v: &Vec<u64>| if miss > 0 { None } else { v.iter().max().copied() };
        let mut st: Vec<u64> = rs.iter().filter_map(|r| r.start_to_frame_ms).collect();
        let mut tap: Vec<u64> = rs.iter().filter_map(|r| r.tap_to_frame_ms).collect();
        let mut sk: Vec<u64> = rs.iter().filter_map(|r| r.seek_ms).collect();
        let mut pr: Vec<u64> = rs.iter().map(|r| r.probe_ms).collect();
        let stalls: u32 = rs.iter().map(|r| r.stalls).sum();
        println!(
            "| {p} | {f} | {s} | {}{} | {} | {} | {} | {} | {} | {} | {} | {stalls} |",
            rs.len(),
            if miss > 0 { format!(" ({miss} no frame)") } else { String::new() },
            fmt_ms(median(&mut st.clone())),
            if miss > 0 { "timeout".into() } else { fmt_ms(worst(&st)) },
            fmt_ms(median(&mut tap)),
            if miss > 0 { "timeout".into() } else { fmt_ms(worst(&tap)) },
            fmt_ms(median(&mut sk.clone())),
            fmt_ms(sk.iter().max().copied()),
            fmt_ms(median(&mut pr)),
        );
        st.clear();
        sk.clear();
    }
}

/// Minimal `tracing` subscriber for debugging (`HUWA_BENCH_LOG=librqbit::torrent_state=debug,huwa=debug`):
/// prints events whose target starts with one of the prefixes, at or above the level.
struct LogSub {
    filters: Vec<(String, tracing::Level)>,
    t0: Instant,
    next: AtomicU64,
}

impl LogSub {
    fn level_for(&self, target: &str) -> Option<tracing::Level> {
        self.filters.iter().filter(|(p, _)| target.starts_with(p.as_str())).map(|(_, l)| *l).max()
    }
}

struct FieldFmt(String);
impl tracing::field::Visit for FieldFmt {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0.push_str(&format!("{value:?} "));
        } else {
            self.0.push_str(&format!("{}={value:?} ", field.name()));
        }
    }
}

impl tracing::Subscriber for LogSub {
    fn enabled(&self, m: &tracing::Metadata<'_>) -> bool {
        m.is_span() || self.level_for(m.target()).is_some_and(|l| *m.level() <= l)
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(self.next.fetch_add(1, Ordering::Relaxed) + 1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, e: &tracing::Event<'_>) {
        let mut f = FieldFmt(String::new());
        e.record(&mut f);
        println!("    [log {:>7.3}] {} {}: {}", self.t0.elapsed().as_secs_f64(), e.metadata().level(), e.metadata().target(), f.0);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

fn init_log() {
    let Ok(spec) = std::env::var("HUWA_BENCH_LOG") else { return };
    let filters = spec
        .split(',')
        .filter_map(|kv| {
            let (t, l) = kv.split_once('=').unwrap_or((kv, "debug"));
            Some((t.to_string(), l.parse().ok()?))
        })
        .collect();
    let _ = tracing::subscriber::set_global_default(LogSub { filters, t0: Instant::now(), next: AtomicU64::new(0) });
}

fn main() {
    init_log();
    let args = parse_args();
    assert!(Command::new("mpv").arg("--version").output().is_ok(), "mpv not found (brew install mpv)");
    let bench = Bench::new(args.clone());
    let mut results = Vec::new();
    let mut out = args.out.as_ref().map(|p| {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap()
    });
    for scenario in &args.scenarios {
        if scenario == "storm" {
            storm(&bench, &mut results, out.as_mut());
            continue;
        }
        for file in &args.files {
            for prof in &args.profiles {
                for rep in 0..args.repeat {
                    let r = bench.run_one(prof, file, scenario, rep);
                    println!(
                        "{prof:>12} {file:>14} {scenario:>6} #{rep}: start→frame {} s, tap→frame {} s, probe {} ms ({}), seek {} s, stalls {} ({} ms), launch {} ms, disk MiB {}→{}→{}, evictions {} {}\n      timeline {}",
                        fmt_ms(r.start_to_frame_ms),
                        fmt_ms(r.tap_to_frame_ms),
                        r.probe_ms,
                        r.probe_state,
                        fmt_ms(r.seek_ms),
                        r.stalls,
                        r.stall_ms,
                        r.launch_ms,
                        r.disk_before_mib,
                        r.disk_at_frame_mib,
                        r.disk_end_mib,
                        r.evictions,
                        r.note,
                        r.timeline
                    );
                    if let Some(o) = out.as_mut() {
                        writeln!(o, "{}", serde_json::to_string(&r).unwrap()).unwrap();
                    }
                    results.push(r);
                }
            }
        }
    }
    summarize(&results);
}

// ------------------------------------------------------------------------------------------------
// Switch storm
// ------------------------------------------------------------------------------------------------

fn now_ms_epoch() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Engine and process resources after a switch.
#[derive(Debug, Clone, Default, serde::Serialize)]
struct Resources {
    /// Torrents registered in the engine, and how many are live (not paused).
    torrents: usize,
    live: usize,
    /// librqbit peers connected / connecting, summed over torrents.
    peers: u32,
    connecting: u32,
    /// Peer TCP connections open through the shaping proxies (the network's view).
    net_conns: usize,
    /// Bytes requested by the engine and still in flight on the simulated links.
    inflight_kib: u64,
    /// Open HTTP responses (player connections) and tokio tasks of the engine runtime.
    responses: usize,
    tasks: usize,
    rss_mib: u64,
    fds: usize,
    disk_mib: u64,
}

fn allocated_bytes(p: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(md) = std::fs::symlink_metadata(p) else { return 0 };
    if md.is_dir() {
        std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| allocated_bytes(&e.path())).sum()).unwrap_or(0)
    } else {
        md.blocks() * 512
    }
}

fn rss_mib() -> u64 {
    Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .unwrap_or(0)
        / 1024
}

fn resources(b: &Bench, engine: &Engine, dir: &Path) -> Resources {
    let list = engine.list();
    Resources {
        torrents: list.len(),
        live: list.iter().filter(|s| s.state == "live" || s.state == "finished" || s.state == "initializing").count(),
        peers: list.iter().map(|s| s.peers_live).sum(),
        connecting: list.iter().map(|s| s.peers_connecting).sum(),
        net_conns: b.net.conns.load(Ordering::Relaxed),
        inflight_kib: b.net.queued.load(Ordering::Relaxed) / 1024,
        responses: list.iter().map(|s| s.active_streams).sum(),
        tasks: engine.runtime.metrics().num_alive_tasks(),
        rss_mib: rss_mib(),
        fds: std::fs::read_dir("/dev/fd").map(|r| r.count()).unwrap_or(0),
        disk_mib: allocated_bytes(dir) / MIB,
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
struct SwitchResult {
    n: usize,
    torrent: String,
    profile: String,
    probe_ms: u64,
    start_to_frame_ms: Option<u64>,
    tap_to_frame_ms: Option<u64>,
    /// `startStream` call duration (it blocks for torrents already in the engine).
    start_call_ms: u64,
    /// Engine timeline: `startStream` → first byte served to the player.
    first_byte_ms: Option<u64>,
    timeline: Value,
    res: Resources,
}

/// Start A, then switch every `--switch-every` to a new torrent (popular and obscure in turn) for
/// `--switches` switches, then back to A. One engine and one mpv for the whole storm, like the app.
/// Default: each switch waits for the first frame, then dwells `--switch-every` (every start is
/// timed). `--switch-hard`: switch exactly every `--switch-every` after the tap, frame or not.
fn storm(b: &Bench, _results: &mut Vec<RunResult>, mut out: Option<&mut std::fs::File>) {
    let mut plan: Vec<(String, &str, &str)> = Vec::new();
    for i in 0..=b.args.switches {
        // `--profiles` in turn (default popular, obscure): popular ones on the H.264 file, others on x265.
        let mix: Vec<&str> = if b.args.profiles.len() >= 2 && b.args.profiles != ["popular", "mid", "obscure"] { b.args.profiles.iter().map(String::as_str).collect() } else { vec!["popular", "obscure"] };
        let prof = mix[i % mix.len()];
        let file = if prof.starts_with("popular") || prof.starts_with("mid") { "h264.mkv" } else { "x265.mkv" };
        plan.push((format!("storm{i:02}-{file}"), file, prof));
    }
    plan.push(plan[0].clone());
    // Fixtures and swarms before the clock starts.
    let mut swarms = Vec::new();
    for (alias, file, prof) in &plan {
        if swarms.iter().any(|(a, _): &(String, Swarm)| a == alias) {
            continue;
        }
        let f = b.fixture(file, alias);
        swarms.push((alias.clone(), b.swarm_for(&f, &profile(prof))));
    }
    let dir = b.fresh_dir("storm");
    if let Some(prefill) = &b.args.prefill {
        prefill_cache(b, &dir, prefill);
    }
    let engine = b.engine(&dir);
    let mut mpv = Mpv::spawn(&b.args, "storm");
    let mut rows = Vec::new();
    println!("\n| # | torrent | profile | probe ms | startStream ms | 1st byte s | start→frame s | tap→frame s | torrents | live | peers | net conns | in flight KiB | responses | tasks | RSS MiB | fds | disk MiB |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut prev: Option<String> = None;
    for (n, (alias, _file, prof)) in plan.iter().enumerate() {
        let f = b.fixture("", alias);
        if b.args.fresh_mpv && n > 0 {
            // A new player view per screen, as in the app (its core is created before the tap here).
            drop(mpv);
            mpv = Mpv::spawn(&b.args, "storm");
        }
        let t_tap = Instant::now();
        // The app drops the torrent of the screen it left and releases it `RELEASE_DELAY_MS`
        // later (src/torrent/hold.ts), with the moment it decided to.
        #[cfg(not(huwa_baseline))]
        if let Some(old) = prev.take().filter(|o| *o != f.hex && !b.args.no_release) {
            let (engine, at) = (engine.clone(), now_ms_epoch());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let _ = engine.release(&old, Some(at));
            });
        }
        prev = Some(f.hex.clone());
        let (probe_ms, _state) = b.probe(&engine, &f);
        let t_start = Instant::now();
        let url = b.start_stream(&engine, &f);
        let start_call_ms = t_start.elapsed().as_millis() as u64;
        mpv.load(&url, 0.0);
        let until = if b.args.switch_hard { t_tap + b.args.switch_every } else { t_start + b.args.timeout };
        let ff = mpv.wait("RESTART", until, &mut |_, _| {});
        let first_byte_ms = engine.status(&f.hex).ok().and_then(|s| s.start.first_byte_ms);
        let timeline = engine.status(&f.hex).map(|s| serde_json::to_value(s.start).unwrap()).unwrap_or(Value::Null);
        if b.args.switch_hard {
            std::thread::sleep(until.saturating_duration_since(Instant::now()));
        } else {
            std::thread::sleep(b.args.switch_every);
        }
        let row = SwitchResult {
            n,
            torrent: alias.clone(),
            profile: prof.to_string(),
            probe_ms,
            start_to_frame_ms: ff.map(|t| (t - t_start).as_millis() as u64),
            tap_to_frame_ms: ff.map(|t| (t - t_tap).as_millis() as u64),
            start_call_ms,
            first_byte_ms,
            timeline,
            res: resources(b, &engine, &dir),
        };
        let r = &row.res;
        println!(
            "| {n} | {alias} | {prof} | {probe_ms} | {start_call_ms} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            fmt_ms(row.first_byte_ms),
            fmt_ms(row.start_to_frame_ms),
            fmt_ms(row.tap_to_frame_ms),
            r.torrents,
            r.live,
            r.peers + r.connecting,
            r.net_conns,
            r.inflight_kib,
            r.responses,
            r.tasks,
            r.rss_mib,
            r.fds,
            r.disk_mib
        );
        if let Some(o) = out.as_mut() {
            writeln!(o, "{}", json!({ "storm": &row, "hard": b.args.switch_hard, "prefill": b.args.prefill, "cap": b.args.cache_cap })).unwrap();
        }
        rows.push(row);
    }
    for prof in ["popular", "obscure"] {
        let v: Vec<&SwitchResult> = rows.iter().filter(|r| r.profile == prof).collect();
        let first = v.first().and_then(|r| r.start_to_frame_ms);
        let mut rest: Vec<u64> = v.iter().skip(1).filter_map(|r| r.start_to_frame_ms).collect();
        let missed = v.iter().filter(|r| r.start_to_frame_ms.is_none()).count();
        let worst = rest.iter().max().copied();
        println!(
            "storm {prof}: first start {} s, later starts median {} s, worst {} s, no frame {missed}/{}",
            fmt_ms(first),
            fmt_ms(median(&mut rest)),
            fmt_ms(worst),
            v.len()
        );
    }
    drop(mpv);
    engine.shutdown();
    drop(engine);
    drop(swarms);
    let _ = std::fs::remove_dir_all(&dir);
}
