//! Deterministic timeline simulation of the start path (race of probes → stream start → first
//! frame), with fake swarms. No network, no librqbit session: the decisions under test are the real
//! functions of this crate (`probe::{enqueue, handshake_concurrency, max_handshakes, settle,
//! HANDSHAKE_TIMEOUT}`, `streaming::peer_limit_for`, `trackers::for_torrent`) and a model of how
//! librqbit 9.0.1 hands out pieces (read from `piece_tracker.rs` / `torrent_state/streaming.rs`):
//! one whole piece per peer at a time, first from the interleaved stream queues (32 MiB from each
//! stream position), then — if the file is selected — in natural order. Bandwidth per in-flight
//! piece is a max-min fair share of the downlink capped by the serving peer's upload rate.
//!
//! The JS race rules (`src/torrent/peer-race.ts`) are mirrored as constants below; their timing is
//! tested on the JS side too (`src/torrent/__tests__/race-timeline.test.ts`).
//!
//! Model assumptions (documented, not measured): Wi-Fi downlink 12 MB/s; a tracker answers in
//! 150 ms with every live peer plus stale ones; a cold DHT answers from 600 ms on, in batches,
//! mostly stale addresses; metadata = first live peer known + 3 RTT; a handshake to a live peer =
//! 2 RTT, to a dead address = the handshake timeout; a peer connects + unchokes in 3 RTT; adding a
//! probed torrent and initialising it = 100 ms; the first frame needs piece 0 and the tail index
//! pieces (MP4 `moov`; MKV Cues + Tags, which mpv reads before playing).
//!
//! What this model missed, and the device timelines (`timeline.rs`) showed: first frames of 15 s
//! and more, or none. Between two player requests librqbit 9.0.1 saw "nothing selected, no stream
//! open", took the torrent for finished and dropped its seeders (fixed by the anchor stream, see
//! `streaming::spawn_anchor`); the app sniffed the loopback URL for 3.5 s, then tried AVPlayer on
//! MKV for 15 s before mpv. Every peer here also unchokes at once. Treat its numbers as a lower
//! bound, not as the expected time on a phone.

use std::collections::{HashSet, VecDeque};
use std::net::SocketAddr;

use crate::probe::{enqueue, handshake_concurrency, max_handshakes, settle, ProbeState, DEFAULT_MIN_PEERS, HANDSHAKE_TIMEOUT};

const MS: u64 = 1;
const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const DOWNLINK_BPS: f64 = 12_000_000.0;
const TRACKER_MS: u64 = 150;
const DHT_FIRST_MS: u64 = 600;
const DHT_BATCH: usize = 40;
const DHT_BATCH_EVERY_MS: u64 = 150;
const ENGINE_ADD_MS: u64 = 100;
const STREAM_WINDOW: u64 = 32 * MIB;

// Mirrors of src/torrent/peer-race.ts / use-peer-race.ts.
const JS_POLL_MS: u64 = 200;
const JS_SOFT_COMMIT_MS: u64 = 1_500;
const JS_DEADLINE_MS: u64 = 2_500;
// Before this change set.
const OLD_JS_POLL_MS: u64 = 400;
const OLD_JS_DEADLINE_MS: u64 = 9_000;
const OLD_HANDSHAKE_CONCURRENCY: usize = 10;
const OLD_MAX_HANDSHAKES: usize = 40;
const OLD_HANDSHAKE_TIMEOUT_MS: u64 = 2_500;
const OLD_PEER_LIMIT: usize = 60;

#[derive(Clone, Copy, Debug)]
struct Profile {
    name: &'static str,
    live: usize,
    peer_bps: f64,
    rtt_ms: u64,
    stale_tracker: usize,
    stale_dht: usize,
    piece: u64,
    file: u64,
    mp4: bool,
}

const POPULAR: Profile = Profile { name: "popular", live: 50, peer_bps: 2_000_000.0, rtt_ms: 60, stale_tracker: 30, stale_dht: 300, piece: MIB, file: 1400 * MIB, mp4: false };
const POPULAR_MP4: Profile = Profile { name: "popular-mp4", mp4: true, ..POPULAR };
const MID: Profile = Profile { name: "mid", live: 8, peer_bps: 1_000_000.0, rtt_ms: 100, stale_tracker: 20, stale_dht: 60, piece: MIB, file: 700 * MIB, mp4: false };
const OBSCURE: Profile = Profile { name: "obscure", live: 2, peer_bps: 300_000.0, rtt_ms: 200, stale_tracker: 5, stale_dht: 12, piece: 512 * KIB, file: 350 * MIB, mp4: false };
const OBSCURE_ONE: Profile = Profile { name: "obscure-1-peer", live: 1, ..OBSCURE };

#[derive(Clone, Copy)]
struct Config {
    public_trackers: bool,
    fresh_first: bool,
    adaptive_handshakes: bool,
    handshake_timeout_ms: u64,
    js_poll_ms: u64,
    js_deadline_ms: u64,
    soft_commit: bool,
    peer_limit_by_swarm: bool,
    narrow_startup: bool,
}

const NEW: Config = Config {
    public_trackers: true,
    fresh_first: true,
    adaptive_handshakes: true,
    handshake_timeout_ms: HANDSHAKE_TIMEOUT.as_millis() as u64,
    js_poll_ms: JS_POLL_MS,
    js_deadline_ms: JS_DEADLINE_MS,
    soft_commit: true,
    peer_limit_by_swarm: true,
    narrow_startup: true,
};

const OLD: Config = Config {
    public_trackers: false,
    fresh_first: false,
    adaptive_handshakes: false,
    handshake_timeout_ms: OLD_HANDSHAKE_TIMEOUT_MS,
    js_poll_ms: OLD_JS_POLL_MS,
    js_deadline_ms: OLD_JS_DEADLINE_MS,
    soft_commit: false,
    peer_limit_by_swarm: false,
    narrow_startup: false,
};

fn addr(i: usize) -> SocketAddr {
    SocketAddr::from(([10, (i >> 16) as u8, (i >> 8) as u8, i as u8], 6881))
}

/// Address `i` < `live` is a live peer, the others are stale.
fn is_live(p: &Profile, a: SocketAddr) -> bool {
    let ip = match a.ip() {
        std::net::IpAddr::V4(v) => v.octets(),
        _ => unreachable!(),
    };
    (((ip[1] as usize) << 16) | ((ip[2] as usize) << 8) | ip[3] as usize) < p.live
}

/// (time, addresses, fresh) discovery events of one probe.
fn discoveries(p: &Profile, c: &Config) -> Vec<(u64, Vec<SocketAddr>, bool)> {
    let mut ev = Vec::new();
    let live: Vec<SocketAddr> = (0..p.live).map(addr).collect();
    if c.public_trackers {
        // `trackers::for_torrent` gives a magnet without trackers the public list (checked below).
        // Live and stale addresses mixed, as trackers return them.
        let mut t = Vec::new();
        let n = p.live + p.stale_tracker;
        let (mut li, mut si) = (0, 0);
        for k in 0..n {
            if (k * p.live / n.max(1) >= li || si >= p.stale_tracker) && li < p.live {
                t.push(live[li]);
                li += 1;
            } else {
                t.push(addr(10_000 + si));
                si += 1;
            }
        }
        ev.push((TRACKER_MS, t, true));
    }
    // DHT: stale addresses with the live ones spread among them.
    let total = p.stale_dht + p.live;
    let mut dht = Vec::with_capacity(total);
    let step = (total / p.live.max(1)).max(1);
    let (mut li, mut si) = (0, 0);
    for k in 0..total {
        if k % step == step - 1 && li < p.live {
            dht.push(live[li]);
            li += 1;
        } else if si < p.stale_dht {
            dht.push(addr(20_000 + si));
            si += 1;
        } else {
            dht.push(live[li]);
            li += 1;
        }
    }
    for (b, chunk) in dht.chunks(DHT_BATCH).enumerate() {
        ev.push((DHT_FIRST_MS + b as u64 * DHT_BATCH_EVERY_MS, chunk.to_vec(), false));
    }
    ev.sort_by_key(|e| e.0);
    ev
}

#[derive(Debug, Clone, Copy)]
struct ProbeResult {
    /// When the probe reached its verdict (healthy) or when the race last looked at it.
    meta_ms: Option<u64>,
    healthy_ms: Option<u64>,
    /// First time ≥ 1 peer answered (with metadata).
    one_peer_ms: Option<u64>,
    swarm_at_end: usize,
}

/// Runs the probe state machine of `probe::run` on the fake swarm, 1 ms resolution.
fn simulate_probe(p: &Profile, c: &Config, horizon_ms: u64) -> ProbeResult {
    let events = discoveries(p, c);
    let (mut queue, mut seen, mut order) = (VecDeque::new(), HashSet::new(), Vec::new());
    let mut inflight: Vec<(u64, bool)> = Vec::new(); // (done_at, live)
    let (mut attempts, mut good) = (0usize, 0usize);
    let mut first_live: Option<u64> = None;
    let mut meta: Option<u64> = None;
    let mut res = ProbeResult { meta_ms: None, healthy_ms: None, one_peer_ms: None, swarm_at_end: 0 };
    let mut ev = events.into_iter().peekable();
    for t in (0..=horizon_ms).step_by(MS as usize) {
        while ev.peek().is_some_and(|e| e.0 <= t) {
            let (_, addrs, fresh) = ev.next().unwrap();
            if first_live.is_none() && addrs.iter().any(|a| is_live(p, *a)) {
                first_live = Some(t);
            }
            if c.fresh_first {
                enqueue(&mut queue, &mut seen, &mut order, &addrs, fresh);
            } else {
                enqueue(&mut queue, &mut seen, &mut order, &addrs, false);
            }
        }
        if meta.is_none() {
            if let Some(fl) = first_live {
                if t >= fl + 3 * p.rtt_ms {
                    meta = Some(t);
                    res.meta_ms = Some(t);
                }
            }
        }
        inflight.retain(|(done, live)| {
            if *done <= t {
                if *live {
                    good += 1;
                }
                false
            } else {
                true
            }
        });
        let (conc, max) = if c.adaptive_handshakes {
            (handshake_concurrency(seen.len()), max_handshakes(seen.len()))
        } else {
            (OLD_HANDSHAKE_CONCURRENCY, OLD_MAX_HANDSHAKES)
        };
        while inflight.len() < conc && attempts < max {
            let Some(a) = queue.pop_front() else { break };
            attempts += 1;
            let live = is_live(p, a);
            inflight.push((t + if live { 2 * p.rtt_ms } else { c.handshake_timeout_ms }, live));
        }
        if meta.is_some() && good >= 1 && res.one_peer_ms.is_none() {
            res.one_peer_ms = Some(t);
        }
        if settle(meta.is_some(), meta.map(|_| true), good, DEFAULT_MIN_PEERS, false) == Some(ProbeState::Healthy) {
            res.healthy_ms = Some(t);
            break;
        }
    }
    res.swarm_at_end = seen.len();
    res
}

/// When the JS race commits (polling quantised), mirroring `decidePeerRace`.
fn race_commit(r: &ProbeResult, c: &Config) -> Option<u64> {
    let poll = |t: u64| t.div_ceil(c.js_poll_ms) * c.js_poll_ms;
    if let Some(h) = r.healthy_ms {
        return Some(poll(h));
    }
    if c.soft_commit {
        if let Some(one) = r.one_peer_ms {
            return Some(poll(one.max(JS_SOFT_COMMIT_MS)));
        }
    }
    r.meta_ms.map(|_| c.js_deadline_ms)
}

/// Max-min fair share of the downlink among in-flight pieces, each capped by its peer's rate.
fn fair_rates(n: usize, peer_bps: f64) -> f64 {
    if n == 0 {
        return 0.0;
    }
    (DOWNLINK_BPS / n as f64).min(peer_bps)
}

/// Stream start: ms from the race commit to the first frame.
fn simulate_stream(p: &Profile, c: &Config, swarm: usize) -> u64 {
    let limit = if c.peer_limit_by_swarm { crate::streaming::peer_limit_for(swarm, Some(60)).unwrap() } else { OLD_PEER_LIMIT };
    let pieces = p.file.div_ceil(p.piece);
    // Head window of the serving stream (+ the walker, a duplicate before the first bytes).
    let window: Vec<u64> = (0..STREAM_WINDOW.div_ceil(p.piece).min(pieces)).collect();
    // Tail index prefetch (`startup_tail_plan`): with the head for MP4 (moov) and MKV (mpv reads the
    // Cues + Tags of an mkvmerge file before frame 1: only the last MiB); the whole tail budget at
    // once before the narrow startup.
    use crate::priorities::{startup_tail_plan, tail_prefetch_bytes, ContainerIndex};
    let kind = if p.mp4 { ContainerIndex::MoovAtEnd } else { ContainerIndex::MatroskaTail };
    let (tail_len, tail_with_head) = if c.narrow_startup { startup_tail_plan(kind, p.file, p.piece) } else { (tail_prefetch_bytes(p.file, p.piece), true) };
    let tail: Vec<u64> = ((p.file - tail_len) / p.piece..pieces).collect();
    let mut priority: Vec<u64> = Vec::new();
    // librqbit interleaves the stream queues: serving, (walker), tail.
    let longest = window.len().max(tail.len());
    for i in 0..longest {
        if let Some(w) = window.get(i) {
            priority.push(*w);
        }
        if tail_with_head {
            if let Some(t) = tail.get(i) {
                priority.push(*t);
            }
        }
    }
    // Natural order (file selected) only before this change set during startup.
    let natural: Vec<u64> = if c.narrow_startup { Vec::new() } else { (0..pieces).collect() };
    // MP4: head + moov. MKV: head + the last piece (Cues + Tags, read by mpv before frame 1).
    let needed: Vec<u64> = if p.mp4 { std::iter::once(0).chain(tail.iter().copied()).collect() } else { vec![0, pieces - 1] };

    // Peers: those that answered the probe are dialled first (initial_peers), the others come from
    // the trackers' re-announce. Each needs 3 RTT to be connected and unchoked.
    let connect_at = |i: usize| ENGINE_ADD_MS + 3 * p.rtt_ms + if i < DEFAULT_MIN_PEERS { 0 } else { TRACKER_MS + (i as u64) * 10 };
    let peers = p.live.min(limit);
    let mut busy: Vec<Option<(u64, f64)>> = vec![None; peers]; // (piece, bytes left)
    let mut have: HashSet<u64> = HashSet::new();
    let mut taken: HashSet<u64> = HashSet::new();
    for t in 0..60_000u64 {
        for (i, slot) in busy.iter_mut().enumerate() {
            if slot.is_none() && t >= connect_at(i) {
                let next = priority.iter().chain(natural.iter()).find(|x| !have.contains(x) && !taken.contains(x)).copied();
                if let Some(x) = next {
                    taken.insert(x);
                    *slot = Some((x, (p.piece.min(p.file - x * p.piece)) as f64));
                }
            }
        }
        let n = busy.iter().filter(|s| s.is_some()).count();
        let rate = fair_rates(n, p.peer_bps) / 1000.0; // bytes per ms
        for slot in busy.iter_mut() {
            if let Some((x, left)) = slot {
                *left -= rate;
                if *left <= 0.0 {
                    have.insert(*x);
                    taken.remove(x);
                    *slot = None;
                }
            }
        }
        if needed.iter().all(|x| have.contains(x)) {
            return t;
        }
    }
    u64::MAX
}

struct Timeline {
    commit_ms: u64,
    first_frame_ms: u64,
}

fn timeline(p: &Profile, c: &Config) -> Timeline {
    let probe = simulate_probe(p, c, c.js_deadline_ms);
    let commit = race_commit(&probe, c).expect("metadata within the race deadline");
    let stream = simulate_stream(p, c, probe.swarm_at_end);
    Timeline { commit_ms: commit, first_frame_ms: commit + stream }
}

#[test]
fn start_path_meets_the_time_to_first_frame_budgets() {
    // The model's public trackers are the real list given to a magnet without trackers.
    assert!(!crate::trackers::for_torrent(&[], false).is_empty());
    let budgets: [(Profile, u64, u64); 5] = [
        // (profile, race commit budget, first-frame budget) in ms.
        (POPULAR, 1_500, 2_000),
        (POPULAR_MP4, 1_500, 2_000),
        (MID, 3_000, 5_000),
        (OBSCURE, 3_000, 5_000),
        // A single peer at 300 KB/s: once the MKV tail (Cues + Tags, read by mpv before frame 1)
        // is counted, two 512 KiB pieces come one after the other from it: ~3.5 s of transfer
        // after a 1.6 s race, the physics of this swarm rather than a wait of ours.
        (OBSCURE_ONE, 3_000, 6_000),
    ];
    for (p, commit_budget, frame_budget) in budgets {
        let new = timeline(&p, &NEW);
        let old = timeline(&p, &OLD);
        eprintln!(
            "{:<15} race commit {:>5} ms, first frame {:>5} ms   (before: commit {:>5} ms, first frame {:>5} ms)",
            p.name, new.commit_ms, new.first_frame_ms, old.commit_ms, old.first_frame_ms
        );
        assert!(new.commit_ms <= commit_budget, "{}: race commits at {} ms", p.name, new.commit_ms);
        assert!(new.first_frame_ms < frame_budget, "{}: first frame at {} ms", p.name, new.first_frame_ms);
        assert!(new.first_frame_ms <= old.first_frame_ms, "{}: slower than before", p.name);
    }
}

/// The regression itself: with every peer of a popular swarm connected at once, piece 0 shares the
/// downlink with dozens of other pieces. The swarm-size limit is what brings it back.
#[test]
fn many_connected_peers_starve_piece_zero() {
    let all = simulate_stream(&POPULAR, &Config { peer_limit_by_swarm: false, ..NEW }, 500);
    let capped = simulate_stream(&POPULAR, &NEW, 500);
    eprintln!("popular stream start: {all} ms with every peer, {capped} ms limited to the swarm size");
    // After a ~400 ms race commit, every peer at once misses the 2 s budget; the limit meets it.
    assert!(all + 400 > 2_000 && capped + 400 < 2_000, "{capped} vs {all}");
    // Small swarms are not limited: the obscure path is unchanged by the cap.
    assert_eq!(simulate_stream(&OBSCURE, &NEW, 7), simulate_stream(&OBSCURE, &Config { peer_limit_by_swarm: false, ..NEW }, 7));
}

#[test]
fn stale_dht_addresses_no_longer_hold_the_probe() {
    let old = simulate_probe(&POPULAR, &OLD, 10_000);
    let new = simulate_probe(&POPULAR, &NEW, 10_000);
    eprintln!("popular probe healthy: {:?} ms before, {:?} ms now", old.healthy_ms, new.healthy_ms);
    assert!(new.healthy_ms.unwrap() < 1_000);
    assert!(old.healthy_ms.is_none_or(|o| o > new.healthy_ms.unwrap()));
}
