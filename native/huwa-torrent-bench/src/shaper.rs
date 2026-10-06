//! Userspace network shaping: one TCP proxy per simulated peer, in front of a real librqbit seeder.
//!
//! Per byte travelling seeder → engine (the download direction):
//! - per-peer token bucket (peer uplink), with a slow-start ramp per connection,
//! - optional shared bucket (a common uplink cap split by every peer of the swarm),
//! - client downlink bucket (Wi-Fi / 4G last mile, shared by all connections),
//! - random "stalls" (connection frozen for a while: models loss + retransmission timeouts),
//! - a delay line (one-way latency + jitter, FIFO so TCP ordering is kept).
//!
//! Engine → seeder (requests) only gets the latency. Peers can be switched off/on at runtime
//! (churn): switching off kills live connections, and new connections are reset immediately.

use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use parking_lot_like::Mutex;
use rand::Rng;
use tokio_util::sync::CancellationToken;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
    time::Instant,
};

/// Tiny std-mutex wrapper (no extra dependency).
mod parking_lot_like {
    pub struct Mutex<T>(std::sync::Mutex<T>);
    impl<T> Mutex<T> {
        pub fn new(v: T) -> Self {
            Self(std::sync::Mutex::new(v))
        }
        pub fn lock(&self) -> std::sync::MutexGuard<'_, T> {
            self.0.lock().unwrap_or_else(|e| e.into_inner())
        }
    }
}

/// Debt-based token bucket: `take(n)` always succeeds and sleeps for the time the debt needs to
/// be repaid, so concurrent users are served roughly FIFO and nobody starves.
pub struct Bucket {
    rate_bps: f64, // bytes per second
    burst: f64,
    state: Mutex<(f64, Instant)>,
}

impl Bucket {
    pub fn new(bits_per_sec: f64) -> Arc<Self> {
        let rate = bits_per_sec / 8.0;
        // 30 ms worth of burst, at least one 16 KiB block.
        let burst = (rate * 0.03).max(16384.0);
        Arc::new(Self { rate_bps: rate, burst, state: Mutex::new((burst, Instant::now())) })
    }

    pub fn bytes_per_sec(&self) -> f64 {
        self.rate_bps
    }

    pub async fn take(&self, n: usize) {
        let wait = {
            let mut st = self.state.lock();
            let now = Instant::now();
            let elapsed = now.duration_since(st.1).as_secs_f64();
            st.0 = (st.0 + elapsed * self.rate_bps).min(self.burst);
            st.1 = now;
            st.0 -= n as f64;
            if st.0 < 0.0 {
                Some(Duration::from_secs_f64(-st.0 / self.rate_bps))
            } else {
                None
            }
        };
        if let Some(w) = wait {
            tokio::time::sleep(w).await;
        }
    }
}

#[derive(Debug, Clone)]
pub struct LinkProfile {
    /// Peer uplink in bit/s (None = unlimited).
    pub peer_bps: Option<f64>,
    /// Round-trip time added between this peer and the client (both directions, half each).
    pub rtt_ms: f64,
    /// Uniform jitter amplitude added to each chunk's one-way delay (± ms).
    pub jitter_ms: f64,
    /// Mean seconds between stalls (None = no stalls) and stall duration range (ms).
    pub stall_every_s: Option<f64>,
    pub stall_ms: (u64, u64),
    /// Slow-start ramp: the per-connection rate grows linearly from 10 % to 100 % in this time.
    pub ramp_s: f64,
}

impl Default for LinkProfile {
    fn default() -> Self {
        Self { peer_bps: None, rtt_ms: 60.0, jitter_ms: 5.0, stall_every_s: None, stall_ms: (200, 1500), ramp_s: 3.0 }
    }
}

/// Client last mile (shared by every connection of the run).
#[derive(Debug, Clone)]
pub struct ClientProfile {
    pub name: &'static str,
    pub down_bps: f64,
    pub rtt_ms: f64,
    pub jitter_ms: f64,
}

impl ClientProfile {
    pub fn wifi() -> Self {
        Self { name: "wifi", down_bps: 100e6, rtt_ms: 20.0, jitter_ms: 2.0 }
    }
    pub fn lte() -> Self {
        Self { name: "4g", down_bps: 8e6, rtt_ms: 150.0, jitter_ms: 30.0 }
    }
}

/// Counters shared by the whole run (all proxies).
#[derive(Default)]
pub struct NetCounters {
    pub down_bytes: AtomicU64,
    pub up_bytes: AtomicU64,
    pub connections_total: AtomicU64,
    pub connections_live: AtomicUsize,
    pub refused: AtomicU64,
}

pub struct Proxy {
    pub addr: SocketAddr,
    pub upstream: SocketAddr,
    pub profile: LinkProfile,
    pub online: AtomicBool,
    pub down_bytes: AtomicU64,
    pub live_conns: AtomicUsize,
    kill: Notify,
    /// Bumped on every switch-off so connections opened before it close.
    generation: AtomicU64,
}

pub struct ShapingCtx {
    pub client: ClientProfile,
    pub client_bucket: Arc<Bucket>,
    pub shared_uplink: Option<Arc<Bucket>>,
    pub counters: Arc<NetCounters>,
}

impl Proxy {
    pub fn set_online(&self, on: bool) {
        let was = self.online.swap(on, Ordering::SeqCst);
        if was && !on {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.kill.notify_waiters();
        }
    }
}

/// Starts a proxy listening on 127.0.0.1:0 that forwards to `upstream`.
pub async fn spawn_proxy(
    upstream: SocketAddr,
    profile: LinkProfile,
    online: bool,
    ctx: Arc<ShapingCtx>,
    stop: CancellationToken,
) -> anyhow::Result<Arc<Proxy>> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    let proxy = Arc::new(Proxy {
        addr,
        upstream,
        profile,
        online: AtomicBool::new(online),
        down_bytes: AtomicU64::new(0),
        live_conns: AtomicUsize::new(0),
        kill: Notify::new(),
        generation: AtomicU64::new(0),
    });
    let p = proxy.clone();
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = stop.cancelled() => break,
                a = listener.accept() => a,
            };
            let Ok((client, _)) = accepted else { continue };
            if !p.online.load(Ordering::SeqCst) {
                // Departed peer: reset the connection right away (like a closed port).
                ctx.counters.refused.fetch_add(1, Ordering::Relaxed);
                drop(client);
                continue;
            }
            let p2 = p.clone();
            let ctx2 = ctx.clone();
            let stop2 = stop.clone();
            tokio::spawn(async move {
                let _ = handle_conn(p2, ctx2, client, stop2).await;
            });
        }
    });
    Ok(proxy)
}

struct DelayedChunk {
    release: Instant,
    data: Vec<u8>,
}

fn one_way(rtt_ms: f64, jitter_ms: f64) -> Duration {
    let j = if jitter_ms > 0.0 { rand::rng().random_range(-jitter_ms..=jitter_ms) } else { 0.0 };
    Duration::from_secs_f64(((rtt_ms / 2.0) + j).max(0.0) / 1000.0)
}

async fn handle_conn(p: Arc<Proxy>, ctx: Arc<ShapingCtx>, client: TcpStream, stop: CancellationToken) -> anyhow::Result<()> {
    let gen = p.generation.load(Ordering::SeqCst);
    // Connection setup costs one RTT (SYN/SYN-ACK through the simulated path).
    let rtt = p.profile.rtt_ms + ctx.client.rtt_ms;
    tokio::time::sleep(Duration::from_secs_f64(rtt / 1000.0)).await;
    // Small receive buffer on the seeder → proxy hop: the shaped bottleneck is in this proxy, and
    // loopback autotuning (up to 4 MiB per socket on macOS) would otherwise hide megabytes of
    // already-requested data in kernel buffers, an artificial queue no real path has.
    let sock = tokio::net::TcpSocket::new_v4()?;
    sock.set_recv_buffer_size(64 * 1024)?;
    let upstream = sock.connect(p.upstream).await?;
    let _ = upstream.set_nodelay(true);
    let _ = client.set_nodelay(true);
    ctx.counters.connections_total.fetch_add(1, Ordering::Relaxed);
    ctx.counters.connections_live.fetch_add(1, Ordering::Relaxed);
    p.live_conns.fetch_add(1, Ordering::Relaxed);

    let (mut cr, mut cw) = client.into_split();
    let (mut ur, mut uw) = upstream.into_split();
    let path_rtt = p.profile.rtt_ms + ctx.client.rtt_ms;
    let path_jitter = p.profile.jitter_ms + ctx.client.jitter_ms;

    // ---- engine → seeder: latency only.
    let (utx, mut urx) = tokio::sync::mpsc::channel::<DelayedChunk>(1024);
    let up_reader = {
        let counters = ctx.counters.clone();
        async move {
            let mut buf = vec![0u8; 16384];
            let mut last = Instant::now();
            loop {
                let n = cr.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                counters.up_bytes.fetch_add(n as u64, Ordering::Relaxed);
                let release = (Instant::now() + one_way(path_rtt, path_jitter)).max(last);
                last = release;
                if utx.send(DelayedChunk { release, data: buf[..n].to_vec() }).await.is_err() {
                    break;
                }
            }
            anyhow::Ok(())
        }
    };
    let up_writer = async move {
        while let Some(c) = urx.recv().await {
            tokio::time::sleep_until(c.release).await;
            uw.write_all(&c.data).await?;
        }
        let _ = uw.shutdown().await;
        anyhow::Ok(())
    };

    // ---- seeder → engine: buckets, ramp, stalls, latency.
    let (dtx, mut drx) = tokio::sync::mpsc::channel::<DelayedChunk>(256);
    let down_reader = {
        let p = p.clone();
        let ctx = ctx.clone();
        async move {
            let started = Instant::now();
            let per_conn = p.profile.peer_bps.map(Bucket::new);
            let mut ramp_bucket: Option<(Arc<Bucket>, f64)> = None;
            let mut next_stall = p
                .profile
                .stall_every_s
                .map(|m| Instant::now() + Duration::from_secs_f64(rand_exp(m)));
            let mut last = Instant::now();
            loop {
                // Chunk size: ~20 ms of the slowest bucket, 1.4 KiB .. 16 KiB.
                let rate = per_conn.as_ref().map(|b| b.bytes_per_sec()).unwrap_or(f64::MAX)
                    .min(ctx.client_bucket.bytes_per_sec())
                    .min(ctx.shared_uplink.as_ref().map(|b| b.bytes_per_sec()).unwrap_or(f64::MAX));
                let chunk = ((rate * 0.02) as usize).clamp(1400, 16384);
                let mut buf = vec![0u8; chunk];
                let n = ur.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                buf.truncate(n);
                // Slow-start ramp (per connection): an extra bucket at the ramped rate.
                let elapsed = started.elapsed().as_secs_f64();
                if let Some(peer_bps) = p.profile.peer_bps.or(Some(ctx.client.down_bps)) {
                    if p.profile.ramp_s > 0.0 && elapsed < p.profile.ramp_s {
                        let frac = (0.1 + 0.9 * elapsed / p.profile.ramp_s).min(1.0);
                        let target = peer_bps * frac;
                        let refresh = match &ramp_bucket {
                            Some((_, r)) => (target - r).abs() / r > 0.1,
                            None => true,
                        };
                        if refresh {
                            ramp_bucket = Some((Bucket::new(target), target));
                        }
                        if let Some((b, _)) = &ramp_bucket {
                            b.take(n).await;
                        }
                    }
                }
                if let Some(b) = &per_conn {
                    b.take(n).await;
                }
                if let Some(b) = &ctx.shared_uplink {
                    b.take(n).await;
                }
                ctx.client_bucket.take(n).await;
                if let (Some(at), Some(mean)) = (next_stall, p.profile.stall_every_s) {
                    if Instant::now() >= at {
                        let (lo, hi) = p.profile.stall_ms;
                        let d = rand::rng().random_range(lo..=hi.max(lo));
                        tokio::time::sleep(Duration::from_millis(d)).await;
                        next_stall = Some(Instant::now() + Duration::from_secs_f64(rand_exp(mean)));
                    }
                }
                p.down_bytes.fetch_add(n as u64, Ordering::Relaxed);
                ctx.counters.down_bytes.fetch_add(n as u64, Ordering::Relaxed);
                let release = (Instant::now() + one_way(path_rtt, path_jitter)).max(last);
                last = release;
                if dtx.send(DelayedChunk { release, data: buf }).await.is_err() {
                    break;
                }
            }
            anyhow::Ok(())
        }
    };
    let down_writer = async move {
        while let Some(c) = drx.recv().await {
            tokio::time::sleep_until(c.release).await;
            cw.write_all(&c.data).await?;
        }
        let _ = cw.shutdown().await;
        anyhow::Ok(())
    };

    let killed = async {
        loop {
            let notified = p.kill.notified();
            if p.generation.load(Ordering::SeqCst) != gen {
                return;
            }
            notified.await;
        }
    };

    // Any side finishing (EOF / error / kill / stop) tears the connection down.
    let opened = Instant::now();
    let before = p.down_bytes.load(Ordering::Relaxed);
    let reason = tokio::select! {
        r = async { tokio::join!(up_reader, up_writer) } => format!("engine side ended: {:?} / {:?}", r.0.err(), r.1.err()),
        r = async { tokio::join!(down_reader, down_writer) } => format!("seeder side ended: {:?} / {:?}", r.0.err(), r.1.err()),
        _ = killed => "killed (peer offline)".to_string(),
        _ = stop.cancelled() => "run stopped".to_string(),
    };
    tracing::debug!(
        peer = %p.addr,
        secs = opened.elapsed().as_secs_f64(),
        down = p.down_bytes.load(Ordering::Relaxed) - before,
        "proxy connection closed: {reason}"
    );
    p.live_conns.fetch_sub(1, Ordering::Relaxed);
    ctx.counters.connections_live.fetch_sub(1, Ordering::Relaxed);
    Ok(())
}

fn rand_exp(mean: f64) -> f64 {
    let u: f64 = rand::rng().random_range(1e-9..1.0);
    -mean * u.ln()
}
