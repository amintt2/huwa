//! Rapid switching (the user changes episode / series every ~2 s), offline: a local librqbit
//! session seeds several generated files on 127.0.0.1, and one engine starts them one after the
//! other, a player request each, abandoned right after its first bytes. Pins that:
//! - every start gets its first bytes as fast as the first one (nothing of the abandoned ones
//!   competes: they are deselected at the next start and parked once released);
//! - abandoned torrents end up paused, with no playback (walker, anchor) left running;
//! - probes started and cancelled in bulk free their slots, FileStream permits are not exhausted;
//! - going back to the first torrent starts at once (pieces kept on disk, probe peers redialled).

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};

use huwa_torrent_core::{
    engine::{now_secs, Config, Engine, StartStreamRequest},
    probe::{self, CachedMeta, ProbeRequest},
};
use librqbit::{
    limits::LimitsConfig, spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session,
    SessionOptions,
};

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;
const TORRENTS: usize = 6;

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

struct Swarm {
    engine: Arc<Engine>,
    seeder: Arc<Session>,
    hashes: Vec<String>,
    port: u16,
}

impl Drop for Swarm {
    fn drop(&mut self) {
        let seeder = self.seeder.clone();
        self.engine.runtime.block_on(async move { seeder.stop().await });
        self.engine.shutdown();
    }
}

/// `TORRENTS` files of 16 MiB in 256 KiB pieces, one seeder at 4 MiB/s for all of them.
fn swarm() -> Swarm {
    let root = std::env::temp_dir().join(format!("huwa-churn-{}-{}", std::process::id(), now_secs()));
    let _ = std::fs::remove_dir_all(&root);
    let seed_dir = root.join("seed");
    std::fs::create_dir_all(&seed_dir).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({ "dataDir": root.join("leech") })).unwrap();
    let engine = Engine::new(config).unwrap();
    let port = engine.runtime.block_on(huwa_torrent_core::server::start(engine.clone())).unwrap();
    let seed_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let seed_addr = SocketAddr::from(([127, 0, 0, 1], seed_port));
    let (seeder, hashes) = engine.runtime.block_on(async {
        let seeder = Session::new_with_opts(
            seed_dir.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                listen: Some(ListenerOptions { listen_addr: seed_addr, ipv4_only: true, ..Default::default() }),
                ratelimits: LimitsConfig { upload_bps: std::num::NonZeroU32::new((4 * MIB) as u32), download_bps: None },
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut hashes = Vec::new();
        for i in 0..TORRENTS {
            let file = seed_dir.join(format!("episode-{i:02}.mkv"));
            std::fs::write(&file, pseudo_random(16 * MIB, 0x5EED + i as u64)).unwrap();
            let created = librqbit::create_torrent(
                &file,
                CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(256 * KIB as u32) },
                &BlockingSpawner::new(2),
            )
            .await
            .unwrap();
            let bytes = created.as_bytes().unwrap();
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
            // As after a torrent race: metadata and the answering peer cached.
            engine.meta_cache.insert(&hex, CachedMeta::new(bytes, vec![(format!("episode-{i:02}.mkv"), (16 * MIB) as u64)], vec![seed_addr], Instant::now()));
            hashes.push(hex);
        }
        (seeder, hashes)
    });
    Swarm { engine, seeder, hashes, port }
}

impl Swarm {
    fn start(&self, i: usize) -> String {
        let resp = self
            .engine
            .start_stream(StartStreamRequest { info_hash: self.hashes[i].clone(), file_idx: None, sources: vec![], name: None, metered: false })
            .unwrap();
        format!("/{}", resp.url.splitn(4, '/').nth(3).unwrap())
    }

    /// A player request from 0: time to its first 64 KiB, then the connection is dropped.
    fn first_bytes(&self, path: &str) -> Duration {
        let t = Instant::now();
        let mut s = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-\r\n\r\n").unwrap();
        let mut got = 0usize;
        let mut buf = [0u8; 16 * 1024];
        while got < 64 * KIB {
            let n = s.read(&mut buf).expect("first bytes within 30 s");
            assert!(n > 0, "response ended early");
            got += n;
        }
        t.elapsed()
    }

    fn paused(&self, i: usize) -> bool {
        self.engine.entry(&self.hashes[i]).and_then(|e| e.handle()).is_some_and(|h| h.is_paused())
    }
}

#[test]
fn rapid_switching_keeps_every_start_fast_and_releases_what_was_left() {
    let s = swarm();
    let mut times = Vec::new();
    for i in 0..TORRENTS {
        let path = s.start(i);
        times.push(s.first_bytes(&path));
        // The app releases the screen it left (src/torrent/hold.ts) — here at once, half the time;
        // the other half is left to the engine's own focus rule.
        if i > 0 && i % 2 == 0 {
            s.engine.release(&s.hashes[i - 1], None).unwrap();
        }
    }
    let first = times[0];
    for (i, t) in times.iter().enumerate() {
        assert!(*t <= first * 3 + Duration::from_secs(2), "start #{i} took {t:?} (first: {first:?}): {times:?}");
    }

    // Everything left behind is parked: paused, no playback running.
    let end = Instant::now() + huwa_torrent_core::streaming::RELEASE_GRACE + Duration::from_secs(5);
    while Instant::now() < end && !(0..TORRENTS - 1).all(|i| s.paused(i)) {
        std::thread::sleep(Duration::from_millis(100));
    }
    for i in 0..TORRENTS - 1 {
        assert!(s.paused(i), "torrent #{i} still running after the switch");
    }
    assert!(!s.paused(TORRENTS - 1), "the focused torrent is never parked");
    assert!(s.engine.streaming.playback_count() <= 1, "playbacks left: {}", s.engine.streaming.playback_count());
    assert_eq!(s.engine.focus().as_deref(), Some(s.hashes[TORRENTS - 1].as_str()));

    // Probes started and cancelled in bulk (each switch cancels the old race) leave no slot taken.
    let ids: Vec<u64> = (0..24)
        .map(|k| {
            probe::start(&s.engine, ProbeRequest {
                info_hash: s.hashes[k % TORRENTS].clone(),
                sources: vec![],
                name: None,
                file_idx: None,
                filename: None,
                episode: None,
                timeout_ms: Some(3000),
                min_peers: Some(1),
            })
            .unwrap()
            .id
        })
        .collect();
    for id in &ids {
        s.engine.probes.cancel(*id);
    }
    assert_eq!(s.engine.probes.running(), 0);
    let fresh = probe::start(&s.engine, ProbeRequest {
        info_hash: s.hashes[0].clone(),
        sources: vec![],
        name: None,
        file_idx: None,
        filename: None,
        episode: None,
        timeout_ms: Some(3000),
        min_peers: Some(1),
    })
    .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    let p = s.engine.probes.get(fresh.id).unwrap();
    while !p.status().state.is_final() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(p.status().state.is_final(), "a probe after the churn never ran: {:?}", p.status());

    // Back to the first one: unparked, served from the pieces it kept.
    let back = s.start(0);
    let t = s.first_bytes(&back);
    assert!(t < Duration::from_secs(2), "return to the first torrent took {t:?}");
    assert!(!s.paused(0));
}
