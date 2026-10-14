//! Local seeder for smoke tests (docker/smoke): seeds the given files with librqbit (upload on,
//! one loopback TCP listener) and runs a minimal HTTP tracker that always answers that listener.
//! Prints one JSON line per file: `{"file", "infoHash", "source": "tracker:http://…/announce"}`,
//! then `READY`, and seeds until killed. Synthetic media only (ffmpeg `testsrc` / `sine`).
//!
//!   cargo run --example seeder -- [--host 127.0.0.1] FILE...

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use librqbit::{spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session, SessionOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut host = "127.0.0.1".to_string();
    if args.first().map(String::as_str) == Some("--host") {
        host = args.get(1).cloned().unwrap_or(host);
        args.drain(..2);
    }
    if args.is_empty() {
        anyhow::bail!("usage: seeder [--host IP] FILE...");
    }
    let ip: std::net::IpAddr = host.parse()?;
    let tracker = tokio::net::TcpListener::bind((ip, 0)).await?;
    let tracker_url = format!("http://{}:{}/announce", host, tracker.local_addr()?.port());
    let peer_port = std::net::TcpListener::bind((ip, 0))?.local_addr()?.port();
    let session = Session::new_with_opts(
        std::env::temp_dir(),
        SessionOptions {
            dht: None,
            disable_trackers: true,
            listen: Some(ListenerOptions { listen_addr: SocketAddr::new(ip, peer_port), ipv4_only: ip.is_ipv4(), ..Default::default() }),
            ..Default::default()
        },
    )
    .await?;
    for f in &args {
        let path = PathBuf::from(f).canonicalize()?;
        let created = librqbit::create_torrent(&path, CreateTorrentOptions { name: None, trackers: vec![tracker_url.clone()], piece_length: Some(256 * 1024) }, &BlockingSpawner::new(2)).await?;
        let bytes = created.as_bytes()?;
        let out = if path.is_dir() { path.clone() } else { path.parent().unwrap().to_path_buf() };
        let added = session
            .add_torrent(AddTorrent::from_bytes(bytes), Some(AddTorrentOptions { overwrite: true, output_folder: Some(out.to_string_lossy().into_owned()), disable_trackers: true, ..Default::default() }))
            .await?;
        added.into_handle().ok_or_else(|| anyhow::anyhow!("list only"))?.wait_until_completed().await?;
        println!("{}", serde_json::json!({ "file": f, "infoHash": created.info_hash().as_string().to_lowercase(), "source": format!("tracker:{tracker_url}") }));
    }
    println!("READY");
    let peer = match ip {
        std::net::IpAddr::V4(v4) => [v4.octets().to_vec(), peer_port.to_be_bytes().to_vec()].concat(),
        std::net::IpAddr::V6(_) => anyhow::bail!("IPv4 only"),
    };
    let peer = Arc::new(peer);
    loop {
        let (mut c, _) = tracker.accept().await?;
        let peer = peer.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf).await;
            let mut body = b"d8:completei1e10:incompletei0e8:intervali30e5:peers6:".to_vec();
            body.extend_from_slice(&peer);
            body.push(b'e');
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = c.write_all(head.as_bytes()).await;
            let _ = c.write_all(&body).await;
        });
    }
}
