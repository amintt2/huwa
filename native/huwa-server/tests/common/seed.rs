//! A local seeder (upload on, loopback TCP) for a file, announced to the engine as the probe's
//! answering peer (the same path as a probed torrent; no tracker, no DHT needed).
#![allow(dead_code)]

use std::{
    net::SocketAddr,
    path::Path,
    sync::Arc,
    time::Instant,
};

use huwa_torrent_core::probe::CachedMeta;
use librqbit::{spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session, SessionOptions};

use super::{pseudo_random, Server};

pub struct Seeder {
    pub session: Arc<Session>,
    pub hex: String,
    pub data: Vec<u8>,
    pub torrent: Vec<u8>,
}

impl Seeder {
    pub fn stop(&self, s: &Server) {
        let session = self.session.clone();
        s.app.engine().runtime.block_on(async move { session.stop().await });
    }
}

/// Seeds `file` (or a directory: a multi-file torrent); its parent is the seeder's folder.
pub fn seed_file(s: &Server, file: &Path) -> Seeder {
    // librqbit puts a multi-file torrent's files directly in the output folder.
    let dir = if file.is_dir() { file.to_path_buf() } else { file.parent().unwrap().to_path_buf() };
    let data = std::fs::read(file).unwrap_or_default();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let engine = s.app.engine().clone();
    let path = file.to_path_buf();
    let (session, hex, bytes) = engine.runtime.block_on(async {
        let created = librqbit::create_torrent(&path, CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(256 * 1024) }, &BlockingSpawner::new(2)).await.unwrap();
        let bytes = created.as_bytes().unwrap();
        let session = Session::new_with_opts(
            dir.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                listen: Some(ListenerOptions { listen_addr: SocketAddr::from(([127, 0, 0, 1], port)), ipv4_only: true, ..Default::default() }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let added = session
            .add_torrent(AddTorrent::from_bytes(bytes.clone()), Some(AddTorrentOptions { overwrite: true, output_folder: Some(dir.to_string_lossy().into_owned()), ..Default::default() }))
            .await
            .unwrap();
        added.into_handle().unwrap().wait_until_completed().await.unwrap();
        (session, created.info_hash().as_string().to_lowercase(), bytes)
    });
    let t = librqbit::torrent_from_bytes(&bytes).unwrap();
    let info = t.info.data.validate().unwrap();
    let files: Vec<(String, u64)> = info.iter_file_details().map(|f| (f.filename.to_pathbuf().to_string_lossy().into_owned(), f.len)).collect();
    engine.meta_cache.insert(&hex, CachedMeta::new(bytes.clone(), files, vec![SocketAddr::from(([127, 0, 0, 1], port))], Instant::now()));
    Seeder { session, hex, data, torrent: bytes.to_vec() }
}

/// Seeds `len` bytes of synthetic data as `episode.mkv`.
pub fn seed(s: &Server, len: usize) -> Seeder {
    let dir = s.dir.join("seed");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("episode.mkv");
    std::fs::write(&file, pseudo_random(len, 0x5EED_1234_ABCD_0001)).unwrap();
    seed_file(s, &file)
}
