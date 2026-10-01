//! The "player": an HTTP/1.1 client against the engine's loopback URL that reproduces what
//! AVPlayer / ExoPlayer / mpv do with a progressive file:
//!
//! 1. probe `Range: bytes=0-1` (AVPlayer does exactly this first),
//! 2. read the container header from 0 (`moov` when faststart, EBML/SeekHead/Tracks for MKV),
//! 3. if the index lives at the end (`moov` after `mdat`, Matroska `Cues`), fetch it,
//! 4. stream the media data sequentially, consuming it in real time at the file's bitrate with
//!    an ExoPlayer-like buffer: start when `startup_s` is buffered, stall when empty, resume at
//!    `rebuffer_s`, stop reading at `max_ahead_s` ahead of the playhead (TCP back-pressure),
//! 5. scripted seeks: drop the connection, `Range: bytes=<target>-`, wait for `startup_s` again.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::Instant,
};

use crate::media::MediaProfile;

#[derive(Debug, Clone)]
pub struct PlayerCfg {
    pub startup_s: f64,
    pub rebuffer_s: f64,
    pub max_ahead_s: f64,
    pub watch_s: f64,
    pub seeks: Vec<f64>,
    pub seek_watch_s: f64,
    pub seek_timeout_s: f64,
    pub open_timeout_s: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekResult {
    pub target_frac: f64,
    pub target_byte: u64,
    pub ttfb_s: Option<f64>,
    /// Time from the seek until `startup_s` of media is buffered at the target.
    pub ready_s: Option<f64>,
    pub stalls_after: u32,
    pub stall_time_after_s: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerResult {
    /// All relative to the `startStream` call.
    pub probe_ttfb_s: Option<f64>,
    pub header_done_s: Option<f64>,
    pub index_done_s: Option<f64>,
    pub data_ttfb_s: Option<f64>,
    pub playable_s: Option<f64>,
    /// Over the fixed watch window that starts when playback starts.
    pub watch_s: f64,
    pub stalls: u32,
    pub stall_time_s: f64,
    pub longest_stall_s: f64,
    /// Seconds of media actually played during the watch window.
    pub played_s: f64,
    pub seeks: Vec<SeekResult>,
    pub http_requests: u32,
    /// Failed requests (5xx, connection errors) the player retried, ExoPlayer-style (500 ms).
    pub http_errors: u32,
    /// The very first request failed: AVPlayer does not retry and would show an error.
    pub first_request_failed: bool,
    pub first_error: Option<String>,
    pub reconnects: u32,
    /// Distinct file bytes the player received (what playback actually needed).
    pub unique_bytes: u64,
    pub errors: Vec<String>,
    /// (t, buffer seconds ahead) once per second, for debugging.
    pub buffer_series: Vec<(f64, f64)>,
}

struct Resp {
    sock: TcpStream,
    pending: Vec<u8>,
    remaining: u64,
}

async fn get_range(port: u16, path: &str, start: u64, end: Option<u64>) -> Result<Resp> {
    let mut sock = TcpStream::connect(("127.0.0.1", port)).await?;
    sock.set_nodelay(true)?;
    let range = match end {
        Some(e) => format!("bytes={start}-{e}"),
        None => format!("bytes={start}-"),
    };
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nRange: {range}\r\nUser-Agent: tbench-player\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).await?;
    let mut head = Vec::with_capacity(4096);
    let mut buf = [0u8; 4096];
    let split = loop {
        let n = sock.read(&mut buf).await?;
        if n == 0 {
            bail!("connection closed before headers");
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(p) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if head.len() > 64 * 1024 {
            bail!("header too large");
        }
    };
    let text = String::from_utf8_lossy(&head[..split]).to_string();
    let status: u16 = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).context("bad status line")?;
    if status != 206 && status != 200 {
        let body = String::from_utf8_lossy(&head[split..]).to_string();
        bail!("HTTP {status}: {}", body.trim());
    }
    let cl: u64 = text
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok()).flatten()
        })
        .unwrap_or(u64::MAX);
    let pending = head[split..].to_vec();
    Ok(Resp { sock, remaining: cl, pending })
}

impl Resp {
    /// Reads up to `buf.len()` bytes. `Ok(0)` = end of body.
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        if !self.pending.is_empty() {
            let n = self.pending.len().min(buf.len()).min(self.remaining as usize);
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            self.remaining -= n as u64;
            return Ok(n);
        }
        let cap = buf.len().min(self.remaining.min(usize::MAX as u64) as usize);
        let n = self.sock.read(&mut buf[..cap]).await?;
        if n == 0 {
            bail!("connection closed with {} bytes left", self.remaining);
        }
        self.remaining -= n as u64;
        Ok(n)
    }

    /// Reads exactly `len` bytes (or until the body ends). Returns (bytes, first byte instant).
    async fn read_n(&mut self, len: u64) -> Result<(u64, Option<Instant>)> {
        let mut got = 0;
        let mut first = None;
        let mut buf = vec![0u8; 64 * 1024];
        while got < len {
            let want = ((len - got) as usize).min(buf.len());
            let n = self.read(&mut buf[..want]).await?;
            if n == 0 {
                break;
            }
            first.get_or_insert_with(Instant::now);
            got += n as u64;
        }
        Ok((got, first))
    }
}

struct Ranges(Vec<(u64, u64)>);
impl Ranges {
    fn add(&mut self, a: u64, b: u64) {
        if b > a {
            self.0.push((a, b));
        }
    }
    fn union_len(&mut self) -> u64 {
        self.0.sort();
        let mut total = 0;
        let mut cur: Option<(u64, u64)> = None;
        for &(a, b) in &self.0 {
            match cur {
                Some((ca, cb)) if a <= cb => cur = Some((ca, cb.max(b))),
                Some((ca, cb)) => {
                    total += cb - ca;
                    cur = Some((a, b));
                }
                None => cur = Some((a, b)),
            }
        }
        if let Some((a, b)) = cur {
            total += b - a;
        }
        total
    }
}

/// Outcome of one playback phase (initial watch window, or one seek).
#[derive(Default)]
struct Phase {
    first_byte: Option<Instant>,
    ready: Option<Instant>,
    stalls: u32,
    stall_time: f64,
    longest: f64,
    played_s: f64,
}

pub struct Player<'a> {
    pub port: u16,
    pub path: String,
    pub media: &'a MediaProfile,
    pub cfg: PlayerCfg,
    pub t0: Instant,
}

impl<'a> Player<'a> {
    fn rel(&self, t: Instant) -> f64 {
        t.duration_since(self.t0).as_secs_f64()
    }

    /// GET with retries on 5xx / connection errors (500 ms apart). 4xx are final.
    async fn get(&self, r: &mut PlayerResult, start: u64, end: Option<u64>) -> Result<Resp> {
        loop {
            r.http_requests += 1;
            match get_range(self.port, &self.path, start, end).await {
                Ok(x) => return Ok(x),
                Err(e) => {
                    let msg = format!("{e:#}");
                    if r.http_requests == 1 {
                        r.first_request_failed = true;
                    }
                    r.http_errors += 1;
                    if r.first_error.is_none() {
                        r.first_error = Some(format!("t={:.1}s range {start}-: {msg}", self.rel(Instant::now())));
                    }
                    if msg.starts_with("HTTP 4") {
                        return Err(e);
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    pub async fn run(&self) -> PlayerResult {
        let mut r = PlayerResult { watch_s: self.cfg.watch_s, ..Default::default() };
        let mut ranges = Ranges(Vec::new());
        let open_deadline = self.t0 + Duration::from_secs_f64(self.cfg.open_timeout_s);
        let m = self.media;

        // 1. probe
        let res = tokio::time::timeout_at(open_deadline, async {
            let mut resp = self.get(&mut r, 0, Some(1)).await?;
            let (_, first) = resp.read_n(2).await?;
            anyhow::Ok(first)
        })
        .await;
        match res {
            Ok(Ok(first)) => r.probe_ttfb_s = first.map(|t| self.rel(t)),
            Ok(Err(e)) => {
                r.errors.push(format!("probe: {e:#}"));
                return r;
            }
            Err(_) => {
                r.errors.push("probe: timeout".into());
                return r;
            }
        }

        // 2. header (+ continue as the data stream for faststart MP4)
        let faststart = m.tail_index.is_none();
        let header_len = if faststart { m.header_end } else { m.header_end.max(64 * 1024) };
        let res = tokio::time::timeout_at(open_deadline, async {
            let mut resp = self.get(&mut r, 0, None).await?;
            let (n, _) = resp.read_n(header_len).await?;
            anyhow::Ok((resp, n))
        })
        .await;
        let mut data_resp = None;
        match res {
            Ok(Ok((resp, n))) => {
                ranges.add(0, n);
                r.header_done_s = Some(self.rel(Instant::now()));
                if faststart {
                    data_resp = Some((resp, n));
                }
            }
            Ok(Err(e)) => {
                r.errors.push(format!("header: {e:#}"));
                return r;
            }
            Err(_) => {
                r.errors.push("header: timeout".into());
                return r;
            }
        }

        // 3. tail index
        if let Some((off, len)) = m.tail_index {
            let res = tokio::time::timeout_at(open_deadline, async {
                let mut resp = self.get(&mut r, off, Some(off + len - 1)).await?;
                resp.read_n(len).await
            })
            .await;
            match res {
                Ok(Ok((n, _))) => {
                    ranges.add(off, off + n);
                    r.index_done_s = Some(self.rel(Instant::now()));
                }
                Ok(Err(e)) => {
                    r.errors.push(format!("index: {e:#}"));
                    return r;
                }
                Err(_) => {
                    r.errors.push("index: timeout".into());
                    return r;
                }
            }
        }

        // 4. playback from the first media byte
        let (resp, pos) = match data_resp {
            Some((resp, n)) => (Some(resp), n),
            None => (None, m.data_start),
        };
        let phase = self
            .play(resp, pos, PhaseEnd::Watch { open_deadline }, &mut ranges, &mut r)
            .await;
        r.data_ttfb_s = phase.first_byte.map(|t| self.rel(t));
        r.playable_s = phase.ready.map(|t| self.rel(t));
        r.stalls = phase.stalls;
        r.stall_time_s = phase.stall_time;
        r.longest_stall_s = phase.longest;
        r.played_s = phase.played_s;
        if phase.ready.is_none() {
            r.errors.push("never became playable".into());
            r.unique_bytes = ranges.union_len();
            return r;
        }

        // 5. seeks
        for &frac in &self.cfg.seeks {
            let target = ((m.size as f64 * frac) as u64 / 4096 * 4096).max(m.data_start).min(m.size.saturating_sub(1));
            let started = Instant::now();
            let phase = self.play(None, target, PhaseEnd::Seek { started }, &mut ranges, &mut r).await;
            r.seeks.push(SeekResult {
                target_frac: frac,
                target_byte: target,
                ttfb_s: phase.first_byte.map(|t| t.duration_since(started).as_secs_f64()),
                ready_s: phase.ready.map(|t| t.duration_since(started).as_secs_f64()),
                stalls_after: phase.stalls,
                stall_time_after_s: phase.stall_time,
            });
        }
        r.unique_bytes = ranges.union_len();
        r
    }

    async fn play(&self, resp: Option<Resp>, start: u64, end: PhaseEnd, ranges: &mut Ranges, r: &mut PlayerResult) -> Phase {
        let m = self.media;
        let byterate = m.bitrate_bps / 8.0;
        let mut ph = Phase::default();
        let mut resp = resp;
        let mut recv_end = start;
        let mut playhead = start as f64;
        let mut playing = false;
        let mut stalled_since: Option<Instant> = None;
        let mut eof = false;
        let mut reading = true;
        let mut buf = vec![0u8; 64 * 1024];
        let tick = Duration::from_millis(20);
        let mut last = Instant::now();
        let mut next_tick = last + tick;
        let mut last_sample = last;
        let mut reconnect_backoff = Instant::now();

        loop {
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64();
            last = now;
            let buffered = |recv_end: u64, playhead: f64| ((recv_end as f64 - playhead) / byterate).max(0.0);

            // --- playback state machine
            if playing {
                let adv = byterate * dt;
                playhead += adv;
                ph.played_s += dt;
                if playhead >= recv_end as f64 && !(eof && recv_end >= m.size) {
                    playhead = recv_end as f64;
                    playing = false;
                    stalled_since = Some(now);
                    ph.stalls += 1;
                }
            } else {
                let need = if ph.ready.is_none() { self.cfg.startup_s } else { self.cfg.rebuffer_s };
                let b = buffered(recv_end, playhead);
                if b >= need || (eof && recv_end > playhead as u64) {
                    playing = true;
                    if ph.ready.is_none() {
                        ph.ready = Some(now);
                    }
                    if let Some(s) = stalled_since.take() {
                        let d = now.duration_since(s).as_secs_f64();
                        ph.stall_time += d;
                        ph.longest = ph.longest.max(d);
                    }
                }
            }
            if now.duration_since(last_sample) >= Duration::from_secs(1) {
                last_sample = now;
                r.buffer_series.push((self.rel(now), buffered(recv_end, playhead)));
            }

            // --- end of phase
            let done = match &end {
                PhaseEnd::Watch { open_deadline } => match ph.ready {
                    Some(t) => now.duration_since(t).as_secs_f64() >= self.cfg.watch_s,
                    None => now >= *open_deadline,
                },
                PhaseEnd::Seek { started } => match ph.ready {
                    Some(t) => now.duration_since(t).as_secs_f64() >= self.cfg.seek_watch_s,
                    None => now.duration_since(*started).as_secs_f64() >= self.cfg.seek_timeout_s,
                },
            };
            if done || (eof && playhead >= m.size as f64) {
                if let Some(s) = stalled_since.take() {
                    let d = now.duration_since(s).as_secs_f64();
                    ph.stall_time += d;
                    ph.longest = ph.longest.max(d);
                }
                break;
            }

            // --- reading (ExoPlayer-like hysteresis on the forward buffer)
            let b = buffered(recv_end, playhead);
            if reading && b >= self.cfg.max_ahead_s {
                reading = false;
            } else if !reading && b < self.cfg.max_ahead_s - 5.0 {
                reading = true;
            }
            if reading && !eof {
                if resp.is_none() && Instant::now() >= reconnect_backoff {
                    r.http_requests += 1;
                    match tokio::time::timeout(Duration::from_secs(30), get_range(self.port, &self.path, recv_end, None)).await {
                        Ok(Ok(x)) => resp = Some(x),
                        Ok(Err(e)) => {
                            r.http_errors += 1;
                            if r.first_error.is_none() {
                                r.first_error = Some(format!("t={:.1}s range {recv_end}-: {e:#}", self.rel(Instant::now())));
                            }
                            if r.errors.len() < 20 {
                                r.errors.push(format!("GET {recv_end}-: {e:#}"));
                            }
                            reconnect_backoff = Instant::now() + Duration::from_secs(1);
                        }
                        Err(_) => {
                            r.errors.push(format!("GET {recv_end}-: headers timeout"));
                            reconnect_backoff = Instant::now() + Duration::from_secs(1);
                        }
                    }
                    continue;
                }
                if let Some(rs) = resp.as_mut() {
                    match tokio::time::timeout_at(next_tick, rs.read(&mut buf)).await {
                        Ok(Ok(0)) => {
                            eof = true;
                            resp = None;
                        }
                        Ok(Ok(n)) => {
                            ph.first_byte.get_or_insert_with(Instant::now);
                            ranges.add(recv_end, recv_end + n as u64);
                            recv_end += n as u64;
                            if recv_end >= m.size {
                                eof = true;
                            }
                        }
                        Ok(Err(e)) => {
                            r.errors.push(format!("read at {recv_end}: {e:#}"));
                            r.reconnects += 1;
                            resp = None;
                        }
                        Err(_) => {}
                    }
                }
            }
            let now = Instant::now();
            if now >= next_tick {
                next_tick = now + tick;
            } else if !reading || resp.is_none() || eof {
                tokio::time::sleep_until(next_tick).await;
                next_tick += tick;
            }
        }
        drop(resp);
        ph
    }
}

enum PhaseEnd {
    Watch { open_deadline: Instant },
    Seek { started: Instant },
}
