//! Minimal loopback HTTP tracker (BEP 3 / BEP 23 compact) so peer discovery is deterministic.
//! Each peer has a reveal time: before it the tracker does not list it, which models peers
//! surfacing progressively (DHT lookups, PEX) when combined with a short announce interval.

use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub struct TrackerPeer {
    pub addr: SocketAddr,
    pub reveal_after: Duration,
}

pub struct Tracker {
    pub url: String,
    pub announces: AtomicU64,
}

pub async fn spawn_tracker(
    peers: Vec<TrackerPeer>,
    interval_s: u64,
    start: Instant,
    stop: CancellationToken,
) -> anyhow::Result<Arc<Tracker>> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let tracker = Arc::new(Tracker { url: format!("http://127.0.0.1:{port}/announce"), announces: AtomicU64::new(0) });
    let t = tracker.clone();
    let peers = Arc::new(peers);
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = stop.cancelled() => break,
                a = listener.accept() => a,
            };
            let Ok((mut sock, _)) = accepted else { continue };
            let peers = peers.clone();
            let t = t.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let mut n = 0;
                // Read the request head (GET only, no body).
                while n < buf.len() {
                    match sock.read(&mut buf[n..]).await {
                        Ok(0) | Err(_) => return,
                        Ok(k) => n += k,
                    }
                    if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                t.announces.fetch_add(1, Ordering::Relaxed);
                let elapsed = start.elapsed();
                let mut compact = Vec::new();
                for p in peers.iter().filter(|p| p.reveal_after <= elapsed) {
                    if let SocketAddr::V4(v4) = p.addr {
                        compact.extend_from_slice(&v4.ip().octets());
                        compact.extend_from_slice(&v4.port().to_be_bytes());
                    }
                }
                let mut body = Vec::new();
                body.extend_from_slice(format!("d8:intervali{interval_s}e12:min intervali{interval_s}e5:peers{}:", compact.len()).as_bytes());
                body.extend_from_slice(&compact);
                body.extend_from_slice(b"e");
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    Ok(tracker)
}
