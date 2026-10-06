//! Live benchmark against the public BitTorrent swarm (network required, so `#[ignore]`):
//!
//! ```sh
//! cargo test --release --test live_stream_bench -- --ignored --nocapture
//! # another torrent: HUWA_BENCH_HASH=<40 hex> HUWA_BENCH_TRACKERS="udp://a,udp://b" HUWA_BENCH_FILE=<idx>
//! ```
//!
//! Measures, through the loopback HTTP server exactly like the player:
//! - metadata resolution time (magnet → `live`),
//! - time to the first byte and to the first 2 MiB at offset 0,
//! - time to the first byte and 2 MiB after a seek to 50 % of the file,
//! - a tail probe (last 64 KiB, what AVPlayer asks for MP4 `moov` / MKV Cues).
//!
//! The data folder is fresh (cold DHT, no cache) unless `HUWA_BENCH_DIR` points to a kept one.

use std::{
    io::{Read, Write},
    net::TcpStream,
    time::{Duration, Instant},
};

use huwa_torrent_core::engine::{Config, Engine, StartStreamRequest};

/// Sintel (Blender Foundation, CC-BY), the WebTorrent demo torrent.
const SINTEL: &str = "08ada5a7a6183aae1e09d831df6748d566095a10";
const SINTEL_TRACKERS: &[&str] = &[
    "udp://explodie.org:6969",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
];

const TWO_MIB: u64 = 2 * 1024 * 1024;

struct Timing {
    first_byte: Duration,
    complete: Duration,
    status: u16,
    bytes: u64,
}

/// Minimal blocking HTTP/1.1 GET with a Range header (no client dependency needed).
fn get_range(port: u16, path: &str, start: u64, end_incl: u64, budget: Duration) -> std::io::Result<Timing> {
    let t0 = Instant::now();
    let mut s = TcpStream::connect(("127.0.0.1", port))?;
    s.set_read_timeout(Some(budget))?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes={start}-{end_incl}\r\nConnection: close\r\n\r\n")?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut byte)? == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let mut first_byte = None;
    let mut bytes = 0u64;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = s.read(&mut buf)?;
        if n == 0 {
            break;
        }
        first_byte.get_or_insert_with(|| t0.elapsed());
        bytes += n as u64;
    }
    Ok(Timing { first_byte: first_byte.unwrap_or_else(|| t0.elapsed()), complete: t0.elapsed(), status, bytes })
}

fn report(label: &str, t: &std::io::Result<Timing>) {
    match t {
        Ok(t) => println!(
            "BENCH {label:<12} status={} bytes={} first_byte={:.2}s complete={:.2}s",
            t.status,
            t.bytes,
            t.first_byte.as_secs_f64(),
            t.complete.as_secs_f64()
        ),
        Err(e) => println!("BENCH {label:<12} error: {e}"),
    }
}

#[test]
#[ignore = "needs the public BitTorrent network"]
fn live_time_to_first_bytes_and_seek() {
    let hash = std::env::var("HUWA_BENCH_HASH").unwrap_or_else(|_| SINTEL.to_string());
    let trackers: Vec<String> = std::env::var("HUWA_BENCH_TRACKERS")
        .map(|t| t.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| SINTEL_TRACKERS.iter().map(|t| format!("tracker:{t}")).collect());
    let file_idx: Option<usize> = std::env::var("HUWA_BENCH_FILE").ok().and_then(|f| f.parse().ok());
    let dir = std::env::var("HUWA_BENCH_DIR").map(Into::into).unwrap_or_else(|_| {
        std::env::temp_dir().join(format!("huwa-live-bench-{}-{}", std::process::id(), Instant::now().elapsed().as_nanos()))
    });
    let config: Config = serde_json::from_value(serde_json::json!({ "dataDir": dir, "maxPeers": 60 })).unwrap();

    let t_engine = Instant::now();
    let engine = Engine::new(config).unwrap();
    let port = engine.runtime.block_on(huwa_torrent_core::server::start(engine.clone())).unwrap();
    println!("BENCH engine-start {:.2}s", t_engine.elapsed().as_secs_f64());

    let t0 = Instant::now();
    let resp = engine
        .start_stream(StartStreamRequest { info_hash: hash.clone(), file_idx, sources: trackers, name: None })
        .unwrap();
    let path = resp.url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap();

    // Opening read, exactly like the player: the request itself waits for the metadata. A 503
    // (torrent not openable yet) is retried every 250 ms like a player would, and counted.
    let mut retries = 0;
    let head = loop {
        let t = get_range(port, &path, 0, TWO_MIB - 1, Duration::from_secs(180));
        if matches!(&t, Ok(t) if t.status == 503) && t0.elapsed() < Duration::from_secs(180) {
            retries += 1;
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }
        break t;
    };
    println!("BENCH head-503-retries {retries}");
    let resolved = engine.status(&resp.id).ok();
    report("head-2MiB", &head);
    let st = resolved.unwrap();
    println!(
        "BENCH resolve+head {:.2}s state={} peers_live={} seen={} size={}",
        t0.elapsed().as_secs_f64(),
        st.state,
        st.peers_live,
        st.peers_seen,
        st.total_bytes
    );
    let size = st.total_bytes;
    assert!(size > 4 * TWO_MIB, "file too small for the benchmark");

    let tail = get_range(port, &path, size - 64 * 1024, size - 1, Duration::from_secs(120));
    report("tail-64KiB", &tail);

    let mid = size / 2;
    let seek = get_range(port, &path, mid, mid + TWO_MIB - 1, Duration::from_secs(120));
    report("seek50-2MiB", &seek);

    let mid75 = size / 4 * 3;
    let seek75 = get_range(port, &path, mid75, mid75 + TWO_MIB - 1, Duration::from_secs(120));
    report("seek75-2MiB", &seek75);

    let st = engine.status(&resp.id).unwrap();
    println!(
        "BENCH total {:.2}s peers_live={} seen={} down={} B/s progress={} B",
        t0.elapsed().as_secs_f64(),
        st.peers_live,
        st.peers_seen,
        st.download_bps,
        st.progress_bytes
    );
    engine.shutdown();
}
