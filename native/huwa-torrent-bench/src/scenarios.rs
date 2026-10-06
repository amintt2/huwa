//! The scenario matrix. Rates are bit/s. Each scenario names its media (see `media::SPECS`).

use crate::shaper::ClientProfile;

#[derive(Debug, Clone)]
pub struct PeerSpec {
    pub bps: Option<f64>,
    pub rtt_ms: f64,
    pub jitter_ms: f64,
    pub stall_every_s: Option<f64>,
    pub stall_ms: (u64, u64),
    pub ramp_s: f64,
    /// When the tracker starts listing this peer.
    pub reveal_after_s: f64,
    /// On/off churn: mean seconds online / offline (exponential), random initial phase.
    pub churn: Option<(f64, f64)>,
    /// Leaves for good once the engine has downloaded this fraction of the file (wire bytes).
    pub leave_at_frac: Option<f64>,
}

impl PeerSpec {
    pub fn rate(mbps: f64) -> Self {
        Self {
            bps: Some(mbps * 1e6),
            rtt_ms: 60.0,
            jitter_ms: 5.0,
            stall_every_s: None,
            stall_ms: (200, 1500),
            ramp_s: 3.0,
            reveal_after_s: 0.0,
            churn: None,
            leave_at_frac: None,
        }
    }
    fn rtt(mut self, rtt: f64, jitter: f64) -> Self {
        self.rtt_ms = rtt;
        self.jitter_ms = jitter;
        self
    }
    fn stalls(mut self, every_s: f64, ms: (u64, u64)) -> Self {
        self.stall_every_s = Some(every_s);
        self.stall_ms = ms;
        self
    }
    fn reveal(mut self, s: f64) -> Self {
        self.reveal_after_s = s;
        self
    }
    fn churn(mut self, on: f64, off: f64) -> Self {
        self.churn = Some((on, off));
        self
    }
    fn leave_at(mut self, frac: f64) -> Self {
        self.leave_at_frac = Some(frac);
        self
    }
}

#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: &'static str,
    pub description: &'static str,
    pub media: &'static str,
    pub peers: Vec<PeerSpec>,
    pub shared_uplink_bps: Option<f64>,
    pub client: ClientProfile,
    pub tracker_interval_s: u64,
    pub watch_s: f64,
    pub seeks: Vec<f64>,
    pub seek_watch_s: f64,
    /// Playback cannot be smooth by construction (bitrate > available bandwidth).
    pub expect_stalls: bool,
}

const DEFAULT_SEEKS: &[f64] = &[0.5, 0.1, 0.95];

fn base(name: &'static str, description: &'static str, media: &'static str, peers: Vec<PeerSpec>) -> Scenario {
    Scenario {
        name,
        description,
        media,
        peers,
        shared_uplink_bps: None,
        client: ClientProfile::wifi(),
        tracker_interval_s: 1800,
        watch_s: 60.0,
        seeks: DEFAULT_SEEKS.to_vec(),
        seek_watch_s: 10.0,
        expect_stalls: false,
    }
}

fn n(count: usize, f: impl Fn(usize) -> PeerSpec) -> Vec<PeerSpec> {
    (0..count).map(f).collect()
}

pub fn all() -> Vec<Scenario> {
    let mut v = Vec::new();

    v.push(base("single-peer", "1 seeder at 20 Mbit/s, 60 ms RTT", "medium-mkv", vec![PeerSpec::rate(20.0)]));

    v.push(Scenario {
        shared_uplink_bps: Some(3e6),
        ..base(
            "3p-shared-3mbit",
            "3 peers sharing 3 Mbit/s total (1.6 Mbit/s file)",
            "small-mkv",
            n(3, |i| PeerSpec::rate(3.0).rtt(40.0 + 30.0 * i as f64, 8.0)),
        )
    });

    v.push(base(
        "5p-2mbit",
        "5 peers x 2 Mbit/s (10 Mbit/s total, 4 Mbit/s file)",
        "medium-mkv",
        n(5, |i| PeerSpec::rate(2.0).rtt(40.0 + 20.0 * i as f64, 8.0)),
    ));

    v.push(base(
        "20p-mixed",
        "20 peers: 4 fast (6 Mbit/s), 8 medium (1 Mbit/s), 8 slow (0.2 Mbit/s); 8 Mbit/s file",
        "large-mp4-moovend",
        n(20, |i| match i % 5 {
            0 => PeerSpec::rate(6.0).rtt(40.0, 5.0),
            1 | 2 => PeerSpec::rate(1.0).rtt(90.0, 15.0),
            _ => PeerSpec::rate(0.2).rtt(180.0, 40.0),
        }),
    ));

    v.push(Scenario {
        tracker_interval_s: 5,
        ..base(
            "50p-churn",
            "50 peers x 0.4-1.2 Mbit/s, each online ~20 s / offline ~12 s (re-announce 5 s)",
            "medium-mkv",
            n(50, |i| PeerSpec::rate(0.4 + 0.8 * ((i * 37 % 50) as f64 / 50.0)).rtt(50.0 + (i % 7) as f64 * 25.0, 15.0).churn(20.0, 12.0)),
        )
    });

    v.push(base(
        "high-latency",
        "5 peers x 4 Mbit/s, 300 ms RTT +/-100 ms jitter",
        "medium-mkv",
        n(5, |_| PeerSpec::rate(4.0).rtt(300.0, 100.0)),
    ));

    v.push(base(
        "lossy",
        "5 peers x 4 Mbit/s, each connection freezes 0.2-1.5 s every ~3 s",
        "medium-mkv",
        n(5, |_| PeerSpec::rate(4.0).stalls(3.0, (200, 1500))),
    ));

    v.push(Scenario {
        client: ClientProfile::lte(),
        ..base(
            "4g-client",
            "10 peers x 4 Mbit/s behind a 4G client (8 Mbit/s down, 150 ms RTT, 30 ms jitter)",
            "medium-mkv",
            n(10, |i| PeerSpec::rate(4.0).rtt(40.0 + 10.0 * i as f64, 8.0)),
        )
    });

    v.push(Scenario {
        tracker_interval_s: 2,
        ..base(
            "slow-reveal",
            "6 peers x 3 Mbit/s revealed progressively: first at 5 s, then one every 5 s",
            "medium-mkv",
            n(6, |i| PeerSpec::rate(3.0).reveal(5.0 + 5.0 * i as f64)),
        )
    });

    v.push(base(
        "fast-peer-leaves",
        "1 fast peer (30 Mbit/s) leaving at 30 % downloaded + 4 slow peers x 0.75 Mbit/s",
        "medium-mkv",
        {
            let mut p = vec![PeerSpec::rate(30.0).rtt(30.0, 3.0).leave_at(0.30)];
            p.extend(n(4, |_| PeerSpec::rate(0.75).rtt(120.0, 20.0)));
            p
        },
    ));

    v.push(Scenario {
        shared_uplink_bps: Some(3e6),
        expect_stalls: true,
        ..base(
            "bitrate-over-bw",
            "4 Mbit/s file, 4 peers sharing 3 Mbit/s total: must stall, measures how gracefully",
            "medium-mkv",
            n(4, |_| PeerSpec::rate(3.0)),
        )
    });

    for (name, media, desc) in [
        ("size-small", "small-mkv", "150 MB MKV (1.6 Mbit/s), 8 peers x 3 Mbit/s"),
        ("size-medium", "medium-mkv", "700 MB MKV (4 Mbit/s), 8 peers x 3 Mbit/s"),
        ("size-large", "large-mp4-moovend", "2 GB MP4 moov-at-end (8 Mbit/s), 8 peers x 3 Mbit/s"),
        ("mp4-moov-end", "medium-mp4-moovend", "700 MB MP4 moov-at-end, 8 peers x 3 Mbit/s"),
        ("mp4-faststart", "medium-mp4-faststart", "700 MB MP4 faststart, 8 peers x 3 Mbit/s"),
    ] {
        v.push(base(name, desc, media, n(8, |i| PeerSpec::rate(3.0).rtt(40.0 + 15.0 * i as f64, 8.0))));
    }

    v.extend(calibrated());

    v.push(Scenario {
        watch_s: 30.0,
        seeks: vec![0.5, 0.1, 0.95, 0.3, 0.7, 0.05, 0.85, 0.6],
        seek_watch_s: 8.0,
        ..base(
            "seek-heavy",
            "8 peers x 3 Mbit/s, 8 seeks (50/10/95/30/70/5/85/60 %)",
            "medium-mkv",
            n(8, |i| PeerSpec::rate(3.0).rtt(40.0 + 15.0 * i as f64, 8.0)),
        )
    });

    v
}

/// Swarm profiles calibrated on REAL swarms (`scripts/torrent-real-sample.mjs report` →
/// `<root>/real/calibration.json`): how many peers really answer on the torrent the race would
/// pick, and when the k-th of them shows up. What the probe cannot measure (no piece is ever
/// requested from real torrents) is assumed and stated in the description: peer upload rates
/// (residential mix), RTT, freezes and churn.
pub fn calibrated() -> Vec<Scenario> {
    let root = std::env::var("TBENCH_ROOT").unwrap_or_else(|_| "/private/tmp/claude-501/tbench".into());
    let Ok(bytes) = std::fs::read(std::path::Path::new(&root).join("real/calibration.json")) else { return Vec::new() };
    let Ok(cal) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return Vec::new() };
    let mut out = Vec::new();
    for (tier, name) in [("popular", "real-popular"), ("mid", "real-mid"), ("obscure", "real-obscure")] {
        let Some(c) = cal.get(tier) else { continue };
        let n = c.pointer("/bestAnswering/median").and_then(|v| v.as_f64()).unwrap_or(1.0).round().clamp(1.0, 40.0) as usize;
        let kth: Vec<f64> = c
            .get("kthPeerS")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
            .unwrap_or_default();
        let first = c.pointer("/firstAnswerS/median").and_then(|v| v.as_f64()).unwrap_or(1.0);
        let reveal = |i: usize| -> f64 {
            match kth.get(i) {
                Some(t) if t.is_finite() => *t,
                // Past the 10 measured arrivals (or missing): keep the last known pace.
                _ => {
                    let known: Vec<f64> = kth.iter().copied().filter(|t| t.is_finite()).collect();
                    let last = known.last().copied().unwrap_or(first);
                    last + (i + 1 - known.len().min(i + 1)) as f64 * 1.0
                }
            }
        };
        let desc: &'static str = Box::leak(
            format!(
                "CALIBRATED on real {tier} swarms: {n} answering peers (median of the best probed torrent per episode), \
                 k-th peer revealed at the measured median time (first at {first:.1} s); ASSUMED: residential uplinks \
                 30 % 5 / 40 % 1.5 / 30 % 0.3 Mbit/s, RTT 80-250 ms, a freeze every ~15 s, peers online ~90 s / offline ~30 s"
            )
            .into_boxed_str(),
        );
        let peers = (0..n)
            .map(|i| {
                let rate = match i % 10 {
                    0 | 3 | 6 => 5.0,
                    1 | 4 | 7 | 9 => 1.5,
                    _ => 0.3,
                };
                let mut p = PeerSpec::rate(rate).rtt(80.0 + (i * 53 % 170) as f64, 20.0).stalls(15.0, (300, 2000)).reveal(reveal(i));
                if n > 1 {
                    p = p.churn(90.0, 30.0);
                }
                p
            })
            .collect();
        out.push(Scenario { tracker_interval_s: 5, ..base(name, desc, "medium-mkv", peers) });
    }
    out
}
