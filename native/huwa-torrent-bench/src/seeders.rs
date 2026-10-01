//! Seeders: real librqbit sessions (upload enabled — this crate does not turn on the engine's
//! `disable-upload` feature), each seeding the same torrent from the shared media folder and
//! listening on a loopback TCP port. No DHT, no trackers, no LSD: they never talk to each other,
//! only to the engine through the shaping proxies.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use librqbit::{AddTorrent, AddTorrentOptions, ConnectionOptions, ListenerMode, ListenerOptions, Session, SessionOptions};

use crate::media::MediaProfile;

pub struct Seeder {
    pub session: Arc<Session>,
    pub addr: SocketAddr,
}

pub struct SeederPool {
    pub seeders: Vec<Seeder>,
}

impl SeederPool {
    pub async fn start(media: &MediaProfile, count: usize) -> Result<Self> {
        let torrent = std::fs::read(&media.torrent_path)?;
        let mut seeders = Vec::with_capacity(count);
        let mut handles = Vec::new();
        for i in 0..count {
            let opts = SessionOptions {
                dht: None,
                disable_trackers: true,
                fastresume: false,
                persistence: None,
                listen: Some(ListenerOptions {
                    mode: ListenerMode::TcpOnly,
                    listen_addr: "127.0.0.1:0".parse().unwrap(),
                    enable_upnp_port_forwarding: false,
                    ipv4_only: true,
                    ..Default::default()
                }),
                // No outgoing connections: the engine sends PEX, and seeders would otherwise dial
                // each other through the proxies (seed↔seed connections, pure noise here).
                // librqbit refuses a session without any connector, so outgoing connections go
                // through a SOCKS proxy on a closed loopback port (they all fail immediately).
                connect: Some(ConnectionOptions {
                    proxy_url: Some("socks5://127.0.0.1:9".into()),
                    enable_tcp: true,
                    ..Default::default()
                }),
                disable_local_service_discovery: true,
                ipv4_only: true,
                client_name_and_version: Some(format!("tbench-seeder-{i}")),
                ..Default::default()
            };
            let session = Session::new_with_opts(media.dir.clone(), opts).await.context("seeder session")?;
            let resp = session
                .add_torrent(
                    AddTorrent::from_bytes(torrent.clone()),
                    Some(AddTorrentOptions {
                        overwrite: true,
                        output_folder: Some(media.dir.to_string_lossy().into_owned()),
                        disable_trackers: true,
                        ..Default::default()
                    }),
                )
                .await
                .context("seeder add_torrent")?;
            let handle = resp.into_handle().context("seeder: list-only?")?;
            let addr = session.listen_addr().context("seeder has no listen addr")?;
            let addr: SocketAddr = format!("127.0.0.1:{}", addr.port()).parse()?;
            handles.push(handle);
            seeders.push(Seeder { session, addr });
        }
        // Wait for the initial hash check of every seeder (data is complete on disk).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
        for (i, h) in handles.iter().enumerate() {
            loop {
                let st = h.stats();
                if st.finished {
                    break;
                }
                if tokio::time::Instant::now() > deadline {
                    anyhow::bail!("seeder {i} did not finish its check: {:?}", st.state);
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        Ok(Self { seeders })
    }

    pub async fn stop(self) {
        for s in self.seeders {
            s.session.stop().await;
        }
    }
}
