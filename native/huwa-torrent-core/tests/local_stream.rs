//! Offline end-to-end tests of the loopback server on a torrent whose data is already on disk:
//! a file is written to the data folder, a `.torrent` is created for it and handed to
//! `start_stream` through the probe metadata cache (the same path as a probed torrent), so the
//! real `start_stream` → initialisation → `FileStream` → HTTP path runs without any network.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    sync::Arc,
    time::{Duration, Instant},
};

use huwa_torrent_core::{
    engine::{now_secs, Config, Engine, StartStreamRequest},
    probe::CachedMeta,
};
use librqbit::{spawn_utils::BlockingSpawner, CreateTorrentOptions};

const MIB: usize = 1024 * 1024;

struct Fixture {
    engine: Arc<Engine>,
    port: u16,
    hex: String,
    path: String,
    data: Vec<u8>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.engine.shutdown();
    }
}

fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

fn fixture(tag: &str, len: usize) -> Fixture {
    fixture_on(tag, len, false)
}

fn fixture_on(tag: &str, len: usize, metered: bool) -> Fixture {
    let dir = std::env::temp_dir().join(format!("huwa-local-{tag}-{}-{}", std::process::id(), now_secs()));
    let _ = std::fs::remove_dir_all(&dir);
    let config: Config = serde_json::from_value(serde_json::json!({ "dataDir": dir })).unwrap();
    let engine = Engine::new(config).unwrap();

    // Single-file torrents land directly in `<dataDir>/torrents/<file name>`.
    let file = dir.join("torrents").join("episode.mkv");
    let data = pseudo_random(len, 0x9E37_79B9_7F4A_7C15);
    std::fs::write(&file, &data).unwrap();
    let created = engine
        .runtime
        .block_on(async {
            librqbit::create_torrent(
                &file,
                CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(MIB as u32) },
                &BlockingSpawner::new(2),
            )
            .await
        })
        .unwrap();
    let hex = created.info_hash().as_string().to_lowercase();
    let bytes = created.as_bytes().unwrap();
    engine.meta_cache.insert(&hex, CachedMeta::new(bytes, vec![("episode.mkv".into(), len as u64)], vec![], Instant::now()));

    let port = engine.runtime.block_on(huwa_torrent_core::server::start(engine.clone())).unwrap();
    let resp = engine
        .start_stream(StartStreamRequest { info_hash: hex.clone(), file_idx: None, sources: vec![], name: None, metered })
        .unwrap();
    let path = format!("/{}", resp.url.splitn(4, '/').nth(3).unwrap());
    Fixture { engine, port, hex, path, data }
}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Sends one GET on `conn` and reads exactly one response (Content-Length framed).
fn request(conn: &mut BufReader<TcpStream>, path: &str, range: Option<&str>) -> Response {
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    if let Some(r) = range {
        req.push_str(&format!("Range: {r}\r\n"));
    }
    req.push_str("\r\n");
    conn.get_mut().write_all(req.as_bytes()).unwrap();
    let mut line = String::new();
    conn.read_line(&mut line).unwrap();
    let status = line.split_whitespace().nth(1).unwrap().parse().unwrap();
    let mut headers = Vec::new();
    loop {
        line.clear();
        conn.read_line(&mut line).unwrap();
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        let (k, v) = l.split_once(':').unwrap();
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map(|(_, v)| v.parse().unwrap())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    conn.read_exact(&mut body).unwrap();
    Response { status, headers, body }
}

fn connect(port: u16) -> BufReader<TcpStream> {
    let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    BufReader::new(s)
}

#[test]
fn first_request_waits_for_initialisation_instead_of_503() {
    let f = fixture("init", 24 * MIB);
    // Sent right after start_stream: the torrent is still being added / checked.
    let mut c = connect(f.port);
    let r = request(&mut c, &f.path, Some("bytes=0-1"));
    assert_eq!(r.status, 206, "cold first request must not fail");
    assert_eq!(r.body, &f.data[..2]);
    assert_eq!(r.header("content-range"), Some(format!("bytes 0-1/{}", f.data.len()).as_str()));
}

#[test]
fn avplayer_probe_pattern_on_one_keep_alive_connection() {
    let f = fixture("probe", 24 * MIB);
    let len = f.data.len();
    let mut c = connect(f.port);
    // AVPlayer: 2-byte probe, tail probes, then the head and a jump, all on one connection.
    let cases: Vec<(String, usize, usize)> = vec![
        ("bytes=0-1".into(), 0, 2),
        (format!("bytes={}-{}", len - 65536, len - 1), len - 65536, len),
        ("bytes=-1024".into(), len - 1024, len),
        ("bytes=0-1048575".into(), 0, MIB),
        (format!("bytes={}-{}", len / 2, len / 2 + 3 * MIB - 1), len / 2, len / 2 + 3 * MIB),
        (format!("bytes={}-", len - 10), len - 10, len),
    ];
    for (range, start, end) in cases {
        let r = request(&mut c, &f.path, Some(&range));
        assert_eq!(r.status, 206, "{range}");
        assert_eq!(r.header("accept-ranges"), Some("bytes"));
        assert_eq!(r.header("content-range"), Some(format!("bytes {start}-{}/{len}", end - 1).as_str()), "{range}");
        assert!(r.body == f.data[start..end], "{range}: wrong bytes");
    }
    let r = request(&mut c, &f.path, Some(&format!("bytes={len}-")));
    assert_eq!(r.status, 416);
    assert_eq!(r.header("content-range"), Some(format!("bytes */{len}").as_str()));
    // Still the same connection.
    let r = request(&mut c, &f.path, None);
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), len);
}

#[test]
fn many_concurrent_streams_do_not_exhaust_librqbit_permits() {
    let f = fixture("permits", 8 * MIB);
    let entry = f.engine.entry(&f.hex).unwrap();
    let handle = f.engine.runtime.block_on(entry.wait_ready(Duration::from_secs(10))).unwrap();
    f.engine.runtime.block_on(async {
        handle.wait_until_initialized().await.unwrap();
        // A player with several connections + walkers + tail prefetches of a few torrents: with
        // librqbit's default of 8 permits the 9th `stream()` blocked until another one closed.
        let mut held = Vec::new();
        for i in 0..32 {
            let s = tokio::time::timeout(Duration::from_secs(5), handle.clone().stream(0))
                .await
                .unwrap_or_else(|_| panic!("stream #{i} blocked"))
                .unwrap();
            held.push(s);
        }
    });
    // And the HTTP server still answers while they are open.
    let mut c = connect(f.port);
    assert_eq!(request(&mut c, &f.path, Some("bytes=0-1")).status, 206);
}

#[test]
fn health_is_reported_in_status() {
    let f = fixture("health", 4 * MIB);
    let mut c = connect(f.port);
    assert_eq!(request(&mut c, &f.path, Some("bytes=0-1")).status, 206);
    let st = f.engine.status(&f.hex).unwrap();
    assert!(["ok", "idle"].contains(&st.health), "{}", st.health);
    assert_eq!(st.recoveries, 0);
    let json = serde_json::to_value(&st).unwrap();
    assert!(json.get("health").is_some() && json.get("recoveries").is_some());
}

/// Unmetered: the window narrows librqbit to the stream queues until its first bytes are served,
/// then the whole file is selected again. Metered: never (only the windows download).
#[test]
fn selection_follows_the_window_and_the_network() {
    use huwa_torrent_core::engine::{SELECTION_STREAMS_ONLY, SELECTION_WHOLE_FILE};
    use std::sync::atomic::Ordering;
    let wait_for = |f: &Fixture, want: u8| {
        let entry = f.engine.entry(&f.hex).unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        while entry.selection.load(Ordering::Acquire) != want && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        entry.selection.load(Ordering::Acquire)
    };
    let f = fixture_on("sel-wifi", 8 * MIB, false);
    let mut c = connect(f.port);
    assert_eq!(request(&mut c, &f.path, Some("bytes=0-1")).status, 206);
    assert_eq!(wait_for(&f, SELECTION_WHOLE_FILE), SELECTION_WHOLE_FILE, "first bytes served: natural order resumes");
    assert_eq!(f.engine.status(&f.hex).unwrap().state, "finished");

    let f = fixture_on("sel-cell", 8 * MIB, true);
    let mut c = connect(f.port);
    assert_eq!(request(&mut c, &f.path, Some("bytes=0-1")).status, 206);
    std::thread::sleep(Duration::from_millis(2500)); // two monitor ticks
    assert_eq!(wait_for(&f, SELECTION_STREAMS_ONLY), SELECTION_STREAMS_ONLY, "metered: windows only");
    // Nothing selected must not hide progress: the file is complete on disk.
    assert_eq!(f.engine.status(&f.hex).unwrap().state, "finished");
}

/// The start timeline (status `start`) follows the request path, and a replay is a new start.
#[test]
fn start_timeline_is_reported_and_reset_by_a_replay() {
    let f = fixture("timeline", 8 * MIB);
    assert!(f.path.ends_with("/0.mkv"), "URL carries the container: {}", f.path);
    let mut c = connect(f.port);
    let r = request(&mut c, &f.path, Some("bytes=0-4095"));
    assert_eq!((r.status, r.body.len()), (206, 4096));
    let tail = format!("bytes={}-{}", f.data.len() - 1024, f.data.len() - 1);
    assert_eq!(request(&mut c, &f.path, Some(&tail)).status, 206);

    let st = f.engine.status(&f.hex).unwrap();
    let t = &st.start;
    assert_eq!(t.meta_from, "probe");
    assert!(t.meta_ms.is_some() && t.first_request_ms.is_some() && t.first_byte_ms.is_some(), "{t:?}");
    assert!(t.first_request_ms.unwrap() <= t.first_byte_ms.unwrap());
    assert_eq!((t.requests, t.tail_requests), (2, 1));
    assert_eq!(t.bytes_served, 4096 + 1024);
    assert!(t.started_at > 0);
    let json = serde_json::to_value(&st).unwrap();
    assert!(json["start"]["firstByteMs"].is_u64() && json["start"]["metaFrom"] == "probe", "{json}");

    // Played again: same torrent, new start.
    let resp = f
        .engine
        .start_stream(StartStreamRequest { info_hash: f.hex.clone(), file_idx: None, sources: vec![], name: None, metered: false })
        .unwrap();
    assert!(resp.url.ends_with("/0.mkv"), "{}", resp.url);
    let t = f.engine.status(&f.hex).unwrap().start;
    assert_eq!((t.meta_from, t.meta_ms, t.bytes_served, t.requests, t.first_byte_ms), ("engine", Some(t.meta_ms.unwrap()), 0, 0, None));
    assert!(request(&mut c, &f.path, Some("bytes=0-1")).status == 206);
    assert_eq!(f.engine.status(&f.hex).unwrap().start.bytes_served, 2);
}

/// Loopback throughput of a fully available file (body chunking / `FileStream` read path).
/// `cargo test --release --test local_stream -- --ignored --nocapture`
#[test]
#[ignore = "throughput measurement"]
fn loopback_throughput() {
    let f = fixture("throughput", 256 * MIB);
    let mut c = connect(f.port);
    request(&mut c, &f.path, Some("bytes=0-1"));
    let mut best = f64::MAX;
    for _ in 0..5 {
        let t = Instant::now();
        let r = request(&mut c, &f.path, Some("bytes=0-"));
        assert_eq!(r.body.len(), f.data.len());
        best = best.min(t.elapsed().as_secs_f64());
    }
    println!("BENCH loopback 256 MiB best {:.3}s = {:.0} MiB/s", best, 256.0 / best);
}
