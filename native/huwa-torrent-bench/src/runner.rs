//! One run = one scenario repetition against a fresh engine process.

use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use anyhow::{Context, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    enginehost::{EngineHost, ProcUsage},
    media::MediaProfile,
    player::{Player, PlayerCfg, PlayerResult},
    scenarios::Scenario,
    seeders::SeederPool,
    shaper::{spawn_proxy, Bucket, LinkProfile, NetCounters, ShapingCtx},
    tracker::{spawn_tracker, TrackerPeer},
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t: f64,
    pub state: String,
    pub peers_live: u32,
    pub peers_connecting: u32,
    pub peers_seen: u32,
    pub proxy_conns: usize,
    pub progress_bytes: u64,
    pub wire_down_bytes: u64,
    pub engine_download_bps: u64,
    pub rss_bytes: u64,
    pub cpu_s: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub label: String,
    pub scenario: String,
    pub rep: usize,
    pub media: String,
    pub engine_version: String,
    pub file_size: u64,
    pub bitrate_bps: f64,
    pub wall_s: f64,
    /// startStream → `state != resolving` (metadata fetched from peers).
    pub metadata_s: Option<f64>,
    pub player: PlayerResult,
    /// Wire bytes seeders → engine (BitTorrent payload + protocol overhead, measured at the proxies).
    pub wire_down_bytes: u64,
    pub wire_up_bytes: u64,
    /// Verified bytes of the selected file the engine reports at the end.
    pub engine_progress_bytes: u64,
    pub avg_down_bps: f64,
    pub peak_down_bps: f64,
    pub peers_live_max: u32,
    pub peers_live_mean: f64,
    pub proxy_connections_total: u64,
    pub proxy_refused: u64,
    pub tracker_announces: u64,
    pub cpu_s: f64,
    pub max_rss_bytes: u64,
    pub usage: ProcUsage,
    pub samples: Vec<Sample>,
    pub events: Vec<(f64, String)>,
    pub error: Option<String>,
}

pub struct RunCtx<'a> {
    pub label: &'a str,
    pub host_bin: &'a Path,
    pub sandbox: bool,
    pub run_dir: PathBuf,
    pub quick: bool,
}

pub async fn run_once(ctx: &RunCtx<'_>, sc: &Scenario, rep: usize, media: &MediaProfile, pool: &SeederPool) -> Result<RunResult> {
    let stop = CancellationToken::new();
    let res = run_inner(ctx, sc, rep, media, pool, stop.clone()).await;
    stop.cancel();
    res
}

async fn run_inner(
    ctx: &RunCtx<'_>,
    sc: &Scenario,
    rep: usize,
    media: &MediaProfile,
    pool: &SeederPool,
    stop: CancellationToken,
) -> Result<RunResult> {
    std::fs::create_dir_all(&ctx.run_dir)?;
    let data_dir = ctx.run_dir.join("engine-data");
    let _ = std::fs::remove_dir_all(&data_dir);

    // ---- swarm: proxies in front of the seeders + tracker
    let counters = Arc::new(NetCounters::default());
    let shaping = Arc::new(ShapingCtx {
        client: sc.client.clone(),
        client_bucket: Bucket::new(sc.client.down_bps),
        shared_uplink: sc.shared_uplink_bps.map(Bucket::new),
        counters: counters.clone(),
    });
    anyhow::ensure!(pool.seeders.len() >= sc.peers.len(), "seeder pool too small");
    let mut proxies = Vec::new();
    for (i, p) in sc.peers.iter().enumerate() {
        let online = match p.churn {
            Some((on, off)) => rand::rng().random_bool(on / (on + off)),
            None => true,
        };
        let profile = LinkProfile {
            peer_bps: p.bps,
            rtt_ms: p.rtt_ms,
            jitter_ms: p.jitter_ms,
            stall_every_s: p.stall_every_s,
            stall_ms: p.stall_ms,
            ramp_s: p.ramp_s,
        };
        proxies.push(spawn_proxy(pool.seeders[i].addr, profile, online, shaping.clone(), stop.clone()).await?);
    }
    let t0 = Instant::now();
    let tracker = spawn_tracker(
        proxies
            .iter()
            .zip(&sc.peers)
            .map(|(px, p)| TrackerPeer { addr: px.addr, reveal_after: Duration::from_secs_f64(p.reveal_after_s) })
            .collect(),
        sc.tracker_interval_s,
        t0,
        stop.clone(),
    )
    .await?;

    // ---- engine
    let config = json!({
        "dataDir": data_dir,
        "cacheLimitBytes": 64u64 * 1024 * 1024 * 1024,
        "resolveTimeoutSecs": 90,
    });
    let host = Arc::new(EngineHost::spawn(ctx.host_bin, &config, ctx.sandbox, &ctx.run_dir.join("engine.log")).await?);
    let events = Arc::new(std::sync::Mutex::new(Vec::<(f64, String)>::new()));
    let ev = |events: &Arc<std::sync::Mutex<Vec<(f64, String)>>>, msg: String| {
        events.lock().unwrap().push((t0.elapsed().as_secs_f64(), msg));
    };

    // Churn + departures controller.
    {
        let proxies = proxies.clone();
        let peers = sc.peers.clone();
        let counters = counters.clone();
        let size = media.size;
        let events = events.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut next_flip: Vec<Option<Instant>> = peers
                .iter()
                .map(|p| p.churn.map(|(on, off)| Instant::now() + Duration::from_secs_f64(exp(if rand::rng().random_bool(0.5) { on } else { off }))))
                .collect();
            let mut left = vec![false; peers.len()];
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
                let now = Instant::now();
                let wire = counters.down_bytes.load(Ordering::Relaxed);
                for (i, p) in peers.iter().enumerate() {
                    if let Some(frac) = p.leave_at_frac {
                        if !left[i] && wire as f64 >= frac * size as f64 {
                            left[i] = true;
                            proxies[i].set_online(false);
                            events.lock().unwrap().push((t0.elapsed().as_secs_f64(), format!("peer {i} left (wire {wire} B)")));
                        }
                    }
                    if let (Some((on, off)), Some(at)) = (p.churn, next_flip[i]) {
                        if now >= at {
                            let was = proxies[i].online.load(Ordering::SeqCst);
                            proxies[i].set_online(!was);
                            next_flip[i] = Some(now + Duration::from_secs_f64(exp(if was { off } else { on })));
                        }
                    }
                }
            }
        });
    }

    // ---- start streaming (what the app does), then monitor + play
    let start = host
        .call(
            "startStream",
            json!({
                "infoHash": media.info_hash,
                "fileIdx": 0,
                "sources": [format!("tracker:{}", tracker.url)],
                "name": media.file_name,
            }),
        )
        .await
        .context("startStream")?;
    let url = start.get("url").and_then(Value::as_str).context("no url")?.to_string();
    let id = start.get("id").and_then(Value::as_str).context("no id")?.to_string();
    let path = url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).context("bad url")?;
    ev(&events, format!("startStream → {url}"));

    let samples = Arc::new(std::sync::Mutex::new(Vec::<Sample>::new()));
    let metadata_at = Arc::new(std::sync::Mutex::new(None::<f64>));
    let monitor = {
        let host = host.clone();
        let samples = samples.clone();
        let metadata_at = metadata_at.clone();
        let counters = counters.clone();
        let proxies = proxies.clone();
        let stop = stop.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let mut last_full = Instant::now() - Duration::from_secs(5);
            loop {
                let resolved = metadata_at.lock().unwrap().is_some();
                let period = if resolved { Duration::from_secs(1) } else { Duration::from_millis(100) };
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tokio::time::sleep(period) => {}
                }
                let st = host.call("status", json!({ "id": id })).await;
                let t = t0.elapsed().as_secs_f64();
                let Ok(st) = st else { continue };
                let state = st.get("state").and_then(Value::as_str).unwrap_or("?").to_string();
                if !resolved && state != "resolving" {
                    *metadata_at.lock().unwrap() = Some(t);
                }
                if resolved && last_full.elapsed() < Duration::from_millis(900) {
                    continue;
                }
                last_full = Instant::now();
                let (rss, cpu) = host.sample().unwrap_or((0, 0.0));
                let g = |k: &str| st.get(k).and_then(Value::as_u64).unwrap_or(0);
                samples.lock().unwrap().push(Sample {
                    t,
                    state,
                    peers_live: g("peersLive") as u32,
                    peers_connecting: g("peersConnecting") as u32,
                    peers_seen: g("peersSeen") as u32,
                    proxy_conns: proxies.iter().map(|p| p.live_conns.load(Ordering::Relaxed)).sum(),
                    progress_bytes: g("progressBytes"),
                    wire_down_bytes: counters.down_bytes.load(Ordering::Relaxed),
                    engine_download_bps: g("downloadBps"),
                    rss_bytes: rss,
                    cpu_s: cpu,
                });
            }
        })
    };

    let mut cfg = PlayerCfg {
        startup_s: 5.0,
        rebuffer_s: 5.0,
        max_ahead_s: 50.0,
        watch_s: sc.watch_s,
        seeks: sc.seeks.clone(),
        seek_watch_s: sc.seek_watch_s,
        seek_timeout_s: 45.0,
        open_timeout_s: 120.0,
    };
    if ctx.quick {
        cfg.watch_s = 15.0;
        cfg.seeks.truncate(2);
        cfg.seek_watch_s = 4.0;
        cfg.seek_timeout_s = 30.0;
    }
    let player = Player { port: host.port, path, media, cfg, t0 };
    let presult = player.run().await;
    let wall_s = t0.elapsed().as_secs_f64();

    // Final status, then stop everything.
    let final_status = host.call("status", json!({ "id": id })).await.ok();
    stop.cancel();
    let _ = monitor.await;
    let usage = host.exit(Duration::from_secs(10)).await.unwrap_or_default();
    // Give connections a moment to unwind before the next run reuses the seeders.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = std::fs::remove_dir_all(&data_dir);

    let samples = samples.lock().unwrap().clone();
    let wire = counters.down_bytes.load(Ordering::Relaxed);
    let mut peak = 0f64;
    for w in samples.windows(2) {
        let dt = w[1].t - w[0].t;
        if dt > 0.2 {
            peak = peak.max((w[1].wire_down_bytes.saturating_sub(w[0].wire_down_bytes)) as f64 * 8.0 / dt);
        }
    }
    let live: Vec<u32> = samples.iter().filter(|s| s.state != "resolving").map(|s| s.peers_live).collect();
    let peers_live_max = live.iter().copied().max().unwrap_or(0);
    let peers_live_mean = if live.is_empty() { 0.0 } else { live.iter().map(|&x| x as f64).sum::<f64>() / live.len() as f64 };
    let engine_progress_bytes = final_status
        .as_ref()
        .and_then(|s| s.get("progressBytes"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let events = events.lock().unwrap().clone();
    let metadata_s = *metadata_at.lock().unwrap();
    let error = (!presult.errors.is_empty()).then(|| presult.errors.join(" | "));

    Ok(RunResult {
        label: ctx.label.to_string(),
        scenario: sc.name.to_string(),
        rep,
        media: media.id.clone(),
        engine_version: host.version.clone(),
        file_size: media.size,
        bitrate_bps: media.bitrate_bps,
        wall_s,
        metadata_s,
        wire_down_bytes: wire,
        wire_up_bytes: counters.up_bytes.load(Ordering::Relaxed),
        engine_progress_bytes,
        avg_down_bps: wire as f64 * 8.0 / wall_s,
        peak_down_bps: peak,
        peers_live_max,
        peers_live_mean,
        proxy_connections_total: counters.connections_total.load(Ordering::Relaxed),
        proxy_refused: counters.refused.load(Ordering::Relaxed),
        tracker_announces: tracker.announces.load(Ordering::Relaxed),
        cpu_s: usage.user_s + usage.sys_s,
        max_rss_bytes: usage.max_rss_bytes,
        usage,
        samples,
        events,
        error,
        player: presult,
    })
}

fn exp(mean: f64) -> f64 {
    let u: f64 = rand::rng().random_range(1e-9..1.0);
    -mean * u.ln()
}
