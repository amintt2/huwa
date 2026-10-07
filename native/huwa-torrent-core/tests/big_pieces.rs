//! Big pieces (8–16 MiB, common for batches and 1080p/4K releases), offline: a rate-limited local
//! seeder, 8 MiB pieces. Pins the start fixes of vendor/librqbit (HUWA_PATCHES.md):
//! - with `unverifiedStart`, the player's first bytes are served as their blocks land, long
//!   before the 8 MiB piece is complete and verified;
//! - the bytes served that way are the file's (and the piece still verifies afterwards);
//! - without it, the first bytes wait for the whole verified piece (the old behaviour, kept).

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};

use huwa_torrent_core::{
    engine::{now_secs, Config, Engine, StartStreamRequest},
    probe::CachedMeta,
};
use librqbit::{
    limits::LimitsConfig, spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session,
    SessionOptions,
};

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

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

struct Setup {
    engine: Arc<Engine>,
    seeder: Arc<Session>,
    port: u16,
    path: String,
    data: Vec<u8>,
}

impl Drop for Setup {
    fn drop(&mut self) {
        let seeder = self.seeder.clone();
        self.engine.runtime.block_on(async move { seeder.stop().await });
        self.engine.shutdown();
    }
}

/// 32 MiB file in 8 MiB pieces, seeded at 1 MiB/s: a piece takes 8 s.
fn setup(tag: &str, unverified: bool) -> Setup {
    let root = std::env::temp_dir().join(format!("huwa-big-{tag}-{}-{}", std::process::id(), now_secs()));
    let _ = std::fs::remove_dir_all(&root);
    let seed_dir = root.join("seed");
    std::fs::create_dir_all(&seed_dir).unwrap();
    let data = pseudo_random(32 * MIB, 0xB16_B16);
    let file = seed_dir.join("episode.mkv");
    std::fs::write(&file, &data).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({ "dataDir": root.join("leech"), "unverifiedStart": unverified })).unwrap();
    let engine = Engine::new(config).unwrap();
    let port = engine.runtime.block_on(huwa_torrent_core::server::start(engine.clone())).unwrap();
    let seed_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let seed_addr = SocketAddr::from(([127, 0, 0, 1], seed_port));
    let (seeder, hex) = engine.runtime.block_on(async {
        let created = librqbit::create_torrent(&file, CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some((8 * MIB) as u32) }, &BlockingSpawner::new(2))
            .await
            .unwrap();
        let bytes = created.as_bytes().unwrap();
        let seeder = Session::new_with_opts(
            seed_dir.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                listen: Some(ListenerOptions { listen_addr: seed_addr, ipv4_only: true, ..Default::default() }),
                ratelimits: LimitsConfig { upload_bps: std::num::NonZeroU32::new(MIB as u32), download_bps: None },
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let h = seeder
            .add_torrent(
                AddTorrent::from_bytes(bytes.clone()),
                Some(AddTorrentOptions { overwrite: true, output_folder: Some(seed_dir.to_string_lossy().into_owned()), ..Default::default() }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        h.wait_until_completed().await.unwrap();
        let hex = created.info_hash().as_string().to_lowercase();
        engine.meta_cache.insert(&hex, CachedMeta::new(bytes, vec![("episode.mkv".into(), (32 * MIB) as u64)], vec![seed_addr], Instant::now()));
        (seeder, hex)
    });
    let resp = engine
        .start_stream(StartStreamRequest { info_hash: hex, file_idx: None, sources: vec![], name: None, metered: false })
        .unwrap();
    let path = format!("/{}", resp.url.splitn(4, '/').nth(3).unwrap());
    Setup { engine, seeder, port, path, data }
}

/// GET `bytes=0-(len-1)`: the body and when its first `first` bytes had arrived.
fn get_head(s: &Setup, len: usize, first: usize, budget: Duration) -> (Vec<u8>, Option<Duration>) {
    let t = Instant::now();
    let mut c = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
    c.set_read_timeout(Some(budget)).unwrap();
    write!(c, "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-{}\r\nConnection: close\r\n\r\n", s.path, len - 1).unwrap();
    let mut raw = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    let mut first_at = None;
    loop {
        match c.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
        }
        if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            if first_at.is_none() && raw.len() - (i + 4) >= first {
                first_at = Some(t.elapsed());
            }
            if raw.len() - (i + 4) >= len {
                break;
            }
        }
    }
    let i = raw.windows(4).position(|w| w == b"\r\n\r\n").map_or(raw.len(), |i| i + 4);
    (raw[i..].to_vec(), first_at)
}

#[test]
fn unverified_start_serves_the_first_blocks_before_the_piece_is_verified() {
    let s = setup("unverified", true);
    let (body, first) = get_head(&s, 256 * KIB, 256 * KIB, Duration::from_secs(30));
    let first = first.expect("first 256 KiB served");
    // An 8 MiB piece at 1 MiB/s takes 8 s; 256 KiB of it a fraction of a second (+ connection).
    assert!(first < Duration::from_secs(4), "first 256 KiB after {first:?}");
    assert_eq!(body, s.data[..256 * KIB], "bytes served before verification are the file's");
    // The piece is still verified in the end (and read back identical).
    let (body, _) = get_head(&s, 8 * MIB, 8 * MIB, Duration::from_secs(30));
    assert_eq!(body, s.data[..8 * MIB]);
}

#[test]
fn without_the_flag_the_first_bytes_wait_for_the_verified_piece() {
    let s = setup("verified", false);
    let (body, first) = get_head(&s, 64 * KIB, 64 * KIB, Duration::from_secs(30));
    let first = first.expect("first bytes served");
    assert!(first > Duration::from_secs(5), "served before its 8 MiB piece could be verified: {first:?}");
    assert_eq!(body, s.data[..64 * KIB]);
}
