//! Counters for `/metrics` (Prometheus text format). Never labelled with tokens, info hashes,
//! URLs or client addresses: only totals.

use std::{
    fmt::Write,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
pub struct Metrics {
    pub http_requests: AtomicU64,
    pub sessions_created: AtomicU64,
    pub sessions_refused: AtomicU64,
    pub quota_refusals: AtomicU64,
    pub media_probes: AtomicU64,
    pub hls_jobs_started: AtomicU64,
    pub hls_restarts: AtomicU64,
    pub hls_segments_served: AtomicU64,
    pub hls_job_failures: AtomicU64,
    pub subtitle_extractions: AtomicU64,
    pub compat_requests: AtomicU64,
    pub ws_connections: AtomicU64,
    pub ws_refused: AtomicU64,
}

pub fn inc(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}

/// Gauges sampled when `/metrics` is read.
#[derive(Default)]
pub struct Gauges {
    pub sessions: usize,
    pub sessions_active: usize,
    pub ws_open: usize,
    pub hls_jobs: usize,
    pub transcodes: usize,
    pub hwaccel: Option<String>,
    pub torrents: Option<usize>,
    pub download_bps: Option<u64>,
    pub cache_bytes: Option<u64>,
    pub peers: Option<u64>,
    pub proxy_sessions: Option<usize>,
    pub children: Vec<(String, bool, u64)>,
}

impl Metrics {
    pub fn render(&self, g: &Gauges) -> String {
        let mut out = String::new();
        let c = |out: &mut String, name: &str, help: &str, v: u64| {
            let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} counter\n{name} {v}");
        };
        let ga = |out: &mut String, name: &str, help: &str, v: u64| {
            let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {v}");
        };
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        c(&mut out, "huwa_http_requests_total", "HTTP requests handled.", l(&self.http_requests));
        c(&mut out, "huwa_sessions_created_total", "Sessions created.", l(&self.sessions_created));
        c(&mut out, "huwa_sessions_refused_total", "Session creations refused (limits, proofs).", l(&self.sessions_refused));
        c(&mut out, "huwa_quota_refusals_total", "Requests refused by a stream or transcode quota.", l(&self.quota_refusals));
        c(&mut out, "huwa_media_probes_total", "ffprobe runs.", l(&self.media_probes));
        c(&mut out, "huwa_hls_jobs_started_total", "ffmpeg HLS jobs started (first start or seek).", l(&self.hls_jobs_started));
        c(&mut out, "huwa_hls_restarts_total", "ffmpeg HLS jobs restarted for a seek.", l(&self.hls_restarts));
        c(&mut out, "huwa_hls_job_failures_total", "ffmpeg HLS jobs that exited with an error.", l(&self.hls_job_failures));
        c(&mut out, "huwa_hls_segments_served_total", "HLS media segments served.", l(&self.hls_segments_served));
        c(&mut out, "huwa_subtitle_extractions_total", "Subtitle sidecar extractions started.", l(&self.subtitle_extractions));
        c(&mut out, "huwa_stremio_compat_requests_total", "Requests to the Stremio-compatible routes.", l(&self.compat_requests));
        c(&mut out, "huwa_ws_connections_total", "/p2p WebSocket connections relayed to the gateway.", l(&self.ws_connections));
        c(&mut out, "huwa_ws_refused_total", "/p2p WebSocket connections refused (HUWA_MAX_WS).", l(&self.ws_refused));
        ga(&mut out, "huwa_sessions", "Sessions known to this process.", g.sessions as u64);
        ga(&mut out, "huwa_sessions_active", "Sessions used in the last 24 h.", g.sessions_active as u64);
        ga(&mut out, "huwa_ws_open", "Open /p2p WebSocket connections.", g.ws_open as u64);
        ga(&mut out, "huwa_hls_jobs", "Running ffmpeg HLS jobs.", g.hls_jobs as u64);
        ga(&mut out, "huwa_transcodes", "Running video transcodes.", g.transcodes as u64);
        if let Some(h) = &g.hwaccel {
            let _ = writeln!(out, "# HELP huwa_hwaccel Video encoder in use.\n# TYPE huwa_hwaccel gauge\nhuwa_hwaccel{{encoder=\"{h}\"}} 1");
        }
        if let Some(v) = g.torrents {
            ga(&mut out, "huwa_torrents", "Torrents in the engine.", v as u64);
        }
        if let Some(v) = g.download_bps {
            ga(&mut out, "huwa_download_bytes_per_second", "Engine download rate.", v);
        }
        if let Some(v) = g.cache_bytes {
            ga(&mut out, "huwa_cache_bytes", "Torrent cache on disk.", v);
        }
        if let Some(v) = g.peers {
            ga(&mut out, "huwa_peers", "Live peers over all torrents.", v);
        }
        if let Some(v) = g.proxy_sessions {
            ga(&mut out, "huwa_proxy_sessions", "Live HTTP proxy sessions.", v as u64);
        }
        if !g.children.is_empty() {
            let _ = writeln!(out, "# HELP huwa_child_up Supervised child process running.\n# TYPE huwa_child_up gauge");
            for (name, up, _) in &g.children {
                let _ = writeln!(out, "huwa_child_up{{name=\"{name}\"}} {}", *up as u8);
            }
            let _ = writeln!(out, "# HELP huwa_child_restarts_total Restarts of a supervised child.\n# TYPE huwa_child_restarts_total counter");
            for (name, _, restarts) in &g.children {
                let _ = writeln!(out, "huwa_child_restarts_total{{name=\"{name}\"}} {restarts}");
            }
        }
        out
    }
}
