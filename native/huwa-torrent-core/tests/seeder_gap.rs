//! Offline, loopback-only: a second librqbit session seeds a generated file on 127.0.0.1 (upload
//! rate-limited so the download lasts), and the Huwa engine streams it through the probe path.
//!
//! Pins the librqbit 9.0.1 behaviour behind the 15 s+ first frames measured on the device, and its
//! fixes: with nothing selected (startup window not settled yet, metered network) and no stream
//! open — the gap between two player requests — librqbit takes the torrent for finished, drops the
//! seeder as "not needed" and never re-dials it while the selection stays empty.
//! - the anchor stream of a playback (`streaming::spawn_anchor`) keeps that state from happening;
//! - selecting the file again (`start_stream` on a known torrent) brings the seeder back.

use std::{
    net::{SocketAddr, TcpListener},
    sync::Arc,
    time::{Duration, Instant},
};

use huwa_torrent_core::{
    engine::{now_secs, Config, Engine, Entry, StartStreamRequest},
    priorities::{ContainerIndex, PlaybackIntent},
    probe::CachedMeta,
};
use librqbit::{
    limits::LimitsConfig, spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session,
    SessionOptions,
};

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

struct Swarm {
    engine: Arc<Engine>,
    seeder: Arc<Session>,
    hex: String,
}

impl Drop for Swarm {
    fn drop(&mut self) {
        let seeder = self.seeder.clone();
        self.engine.runtime.block_on(async move { seeder.stop().await });
        self.engine.shutdown();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
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

/// 32 MiB file in 256 KiB pieces, seeded at 256 KiB/s: about a piece per second.
fn swarm(tag: &str) -> Swarm {
    let root = std::env::temp_dir().join(format!("huwa-gap-{tag}-{}-{}", std::process::id(), now_secs()));
    let _ = std::fs::remove_dir_all(&root);
    let seed_dir = root.join("seed");
    std::fs::create_dir_all(&seed_dir).unwrap();
    let file = seed_dir.join("episode.mkv");
    std::fs::write(&file, pseudo_random(32 * MIB, 0xA5A5_5A5A_1234_5678)).unwrap();

    let config: Config = serde_json::from_value(serde_json::json!({ "dataDir": root.join("leech") })).unwrap();
    let engine = Engine::new(config).unwrap();
    let port = free_port();
    let (seeder, hex, bytes) = engine.runtime.block_on(async {
        let created = librqbit::create_torrent(
            &file,
            CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(256 * KIB as u32) },
            &BlockingSpawner::new(2),
        )
        .await
        .unwrap();
        let bytes = created.as_bytes().unwrap();
        let seeder = Session::new_with_opts(
            seed_dir.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                listen: Some(ListenerOptions { listen_addr: SocketAddr::from(([127, 0, 0, 1], port)), ipv4_only: true, ..Default::default() }),
                ratelimits: LimitsConfig { upload_bps: std::num::NonZeroU32::new(256 * KIB as u32), download_bps: None },
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let added = seeder
            .add_torrent(AddTorrent::from_bytes(bytes.clone()), Some(AddTorrentOptions { overwrite: true, output_folder: Some(seed_dir.to_string_lossy().into_owned()), ..Default::default() }))
            .await
            .unwrap();
        added.into_handle().unwrap().wait_until_completed().await.unwrap();
        (seeder, created.info_hash().as_string().to_lowercase(), bytes)
    });
    // The probe's metadata and its answering peer, as after a torrent race.
    engine.meta_cache.insert(&hex, CachedMeta::new(bytes, vec![("episode.mkv".into(), (32 * MIB) as u64)], vec![SocketAddr::from(([127, 0, 0, 1], port))], Instant::now()));
    Swarm { engine, seeder, hex }
}

impl Swarm {
    /// Metered: the monitor never selects the whole file, the selection stays as the test sets it.
    fn start(&self) -> Arc<Entry> {
        self.engine
            .start_stream(StartStreamRequest { info_hash: self.hex.clone(), file_idx: None, sources: vec![], name: None, metered: true })
            .unwrap();
        let entry = self.engine.entry(&self.hex).unwrap();
        let h = self.engine.runtime.block_on(entry.wait_ready(Duration::from_secs(20))).unwrap();
        self.engine.runtime.block_on(h.wait_until_initialized()).unwrap();
        entry
    }

    fn peers(&self) -> u32 {
        self.engine.status(&self.hex).unwrap().peers_live
    }

    /// Polls `peers()` until `ok` or the deadline; returns the last value.
    fn wait_peers(&self, within: Duration, ok: impl Fn(u32) -> bool) -> u32 {
        let end = Instant::now() + within;
        loop {
            let p = self.peers();
            if ok(p) || Instant::now() >= end {
                return p;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn select(&self, entry: &Entry, whole_file: bool) {
        let h = entry.handle().unwrap();
        self.engine.runtime.block_on(self.engine.sync_selection(entry, &h, whole_file));
    }
}

#[test]
fn empty_selection_without_stream_drops_the_seeder_until_the_file_is_selected_again() {
    let s = swarm("drop");
    let entry = s.start();
    assert!(s.wait_peers(Duration::from_secs(15), |p| p >= 1) >= 1, "seeder connected");

    // The gap: nothing selected, no stream open (no playback either, so no anchor).
    s.select(&entry, false);
    assert_eq!(s.wait_peers(Duration::from_secs(10), |p| p == 0), 0, "librqbit drops the seeder");
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(s.peers(), 0, "and never re-dials it while nothing is selected");

    // What `start_stream` now does for a torrent it knows: select the file again.
    s.select(&entry, true);
    assert!(s.wait_peers(Duration::from_secs(15), |p| p >= 1) >= 1, "seeder re-dialled");
}

#[test]
fn the_anchor_keeps_the_seeder_between_two_player_requests() {
    let s = swarm("anchor");
    let entry = s.start();
    assert!(s.wait_peers(Duration::from_secs(15), |p| p >= 1) >= 1, "seeder connected");
    let handle = entry.handle().unwrap();

    // A player request opened a window far in the file (playback + anchor created), its response
    // ended before any byte (aborted sniff, AVPlayer's probe, an mpv seek): window not settled,
    // so the selection is empty, and no HTTP stream is open any more.
    let playback = s
        .engine
        .streaming
        .on_request(&s.engine.runtime, &s.hex, &handle, 0, (24 * MIB) as u64, PlaybackIntent::DirectInitial, 0, true, ContainerIndex::Other, false)
        .map(|(p, _)| p)
        .unwrap();
    s.select(&entry, false);
    std::thread::sleep(Duration::from_millis(500));
    // (Without it — checked by disabling `spawn_anchor` — the seeder is gone within ~3 s.)
    assert!(playback.has_anchor(), "anchor running");

    // Long enough for librqbit's peer tasks to see the state several times (a piece per second).
    let end = Instant::now() + Duration::from_secs(6);
    while Instant::now() < end {
        assert!(s.peers() >= 1, "seeder dropped despite the anchor");
        std::thread::sleep(Duration::from_millis(200));
    }

    // The next player request is served by the peer that stayed.
    let byte = s.engine.runtime.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut f = handle.clone().stream(0).await.unwrap();
        f.seek(std::io::SeekFrom::Start((24 * MIB) as u64)).await.unwrap();
        let mut b = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(20), f.read_exact(&mut b)).await
    });
    assert!(matches!(byte, Ok(Ok(_))), "window bytes after the gap: {byte:?}");
    drop(playback);
}
