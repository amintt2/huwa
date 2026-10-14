//! HLS session manager (D13): fMP4 HLS, 4 s segments, VOD playlist written up front.
//!
//! One `Variant` per (media, plan). Its playlist is fixed before ffmpeg runs: a 4 s grid when
//! transcoding (keyframes forced on it), the MKV Cues keyframes grouped into ≥ 4 s segments when
//! the video is copied. ffmpeg (`-f hls`, fMP4, `-copyts` + `frag_discont`: fragment times are the
//! source times) writes small fragments, one per GOP when copying; the server serves playlist
//! segment *k* as the fragments whose first video sample falls in `[start_k, start_k+1)`. The
//! cuts therefore never depend on where a run started, and a seek simply restarts ffmpeg at the
//! requested segment (`-ss start_k`) with a new run id.
//!
//! - A request for a segment that is neither done nor at most `LOOKAHEAD` segments ahead of the
//!   running job restarts the job there (a seek). Older runs' finished segments stay usable.
//! - A job far ahead of the player is paused (`SIGSTOP`) and resumed when the player catches up.
//! - A variant nobody requested for `IDLE` is stopped and its files deleted (`/cache/hls/<id>`).
//! - ffmpeg only ever reads the internal loopback URL (`-protocol_whitelist http,tcp`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use parking_lot::Mutex;
use tokio::sync::Notify;
use tracing::{debug, info, warn};

use super::{
    decide::{Mode, Plan},
    hwaccel::Encoder,
};

pub const SEGMENT_SECS: f64 = 4.0;
/// Fragment length asked of ffmpeg when copying: below any GOP, so it cuts at every keyframe.
pub const COPY_FRAGMENT_SECS: &str = "0.1";
/// A request this many segments past the job's frontier waits for it instead of restarting it.
pub const LOOKAHEAD: usize = 3;
/// The job is paused when this many segments ahead of the latest request, resumed at `RESUME_AHEAD`.
pub const PAUSE_AHEAD: usize = 45;
pub const RESUME_AHEAD: usize = 20;
/// How long a segment / init request waits for ffmpeg.
pub const WAIT: Duration = Duration::from_secs(30);
/// A variant without requests for this long is stopped and its files deleted.
pub const IDLE: Duration = Duration::from_secs(60);
const EPS: f64 = 0.002;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ------------------------------------------------------------------------------------------------
// MP4 boxes
// ------------------------------------------------------------------------------------------------

/// `(type, start, header_len, size)` of the boxes in `b[start..end]`.
fn boxes(b: &[u8], start: usize, end: usize) -> Vec<([u8; 4], usize, usize, usize)> {
    let mut out = Vec::new();
    let mut p = start;
    while p + 8 <= end.min(b.len()) {
        let size32 = u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) as usize;
        let typ = [b[p + 4], b[p + 5], b[p + 6], b[p + 7]];
        let (size, hdr) = match size32 {
            1 if p + 16 <= b.len() => (u64::from_be_bytes(b[p + 8..p + 16].try_into().unwrap()) as usize, 16),
            0 => (end - p, 8),
            s => (s, 8),
        };
        if size < hdr || p + size > end.min(b.len()) {
            break;
        }
        out.push((typ, p, hdr, size));
        p += size;
    }
    out
}

fn find<'a>(b: &'a [u8], start: usize, end: usize, path: &[&[u8; 4]]) -> Option<(usize, usize, usize)> {
    let (first, rest) = path.split_first()?;
    let (_, p, hdr, size) = boxes(b, start, end).into_iter().find(|(t, ..)| t == *first)?;
    if rest.is_empty() {
        Some((p, hdr, size))
    } else {
        find(b, p + hdr, p + size, rest)
    }
}

/// Timescale of the first track (the video, mapped first) in an init segment.
pub fn init_timescale(init: &[u8]) -> Option<u32> {
    let (p, hdr, _) = find(init, 0, init.len(), &[b"moov", b"trak", b"mdia", b"mdhd"])?;
    let d = p + hdr;
    let version = *init.get(d)?;
    let off = if version == 1 { d + 4 + 16 } else { d + 4 + 8 };
    Some(u32::from_be_bytes(init.get(off..off + 4)?.try_into().ok()?))
}

/// `baseMediaDecodeTime` of track 1 in the first `moof` of a fragment file.
pub fn first_tfdt(frag: &[u8]) -> Option<u64> {
    for (t, p, hdr, size) in boxes(frag, 0, frag.len()) {
        if &t != b"moof" {
            continue;
        }
        for (tt, tp, thdr, tsize) in boxes(frag, p + hdr, p + size) {
            if &tt != b"traf" {
                continue;
            }
            let (hp, hhdr, _) = find(frag, tp + thdr, tp + tsize, &[b"tfhd"])?;
            let track = u32::from_be_bytes(frag.get(hp + hhdr + 4..hp + hhdr + 8)?.try_into().ok()?);
            if track != 1 {
                continue;
            }
            let (dp, dhdr, _) = find(frag, tp + thdr, tp + tsize, &[b"tfdt"])?;
            let d = dp + dhdr;
            return if frag[d] == 1 {
                Some(u64::from_be_bytes(frag.get(d + 4..d + 12)?.try_into().ok()?))
            } else {
                Some(u32::from_be_bytes(frag.get(d + 4..d + 8)?.try_into().ok()?) as u64)
            };
        }
    }
    None
}

// ------------------------------------------------------------------------------------------------
// ffmpeg command line
// ------------------------------------------------------------------------------------------------

/// Arguments of one HLS run. `start`: seconds (`-ss`); files go to `dir/r<run>-…`.
pub fn ffmpeg_args(plan: &Plan, input: &str, start: f64, dir: &Path, run: u64, encoder: Encoder, video_height: Option<u32>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y"].map(String::from).to_vec();
    let transcode = plan.mode == Mode::Transcode && plan.video.is_some();
    if transcode {
        a.extend(encoder.input_args());
    }
    // Input: the internal loopback listener only.
    a.extend(["-protocol_whitelist", "http,tcp", "-rw_timeout", "120000000"].map(String::from));
    if start > 0.0 {
        // Copy: just past the keyframe (rounding must never land on the previous one).
        let ss = if plan.video_copy { start + 0.001 } else { start };
        a.extend(["-ss".to_string(), format!("{ss:.3}")]);
    }
    a.extend(["-copyts", "-start_at_zero", "-avoid_negative_ts", "disabled"].map(String::from));
    a.extend(["-i".to_string(), input.to_string()]);
    let height = video_height.unwrap_or(1080).min(plan.max_height);
    match (plan.video, transcode) {
        (Some(v), true) => {
            let mut chain = Vec::new();
            if video_height.is_some_and(|h| h > plan.max_height) {
                chain.push(format!("scale=-2:{}", plan.max_height));
            }
            chain.push(encoder.upload_filter().to_string());
            match plan.burn {
                Some(s) => {
                    a.extend(["-filter_complex".to_string(), format!("[0:{v}][0:{s}]overlay=eof_action=pass,{}[vout]", chain.join(","))]);
                    a.extend(["-map".to_string(), "[vout]".to_string()]);
                }
                None => {
                    a.extend(["-map".to_string(), format!("0:{v}")]);
                    a.extend(["-vf".to_string(), chain.join(",")]);
                }
            }
            a.extend(encoder.codec_args(height));
            // Keyframes on the 4 s grid (`t` counts from the run's first frame = a grid point).
            a.extend(["-force_key_frames".to_string(), format!("expr:gte(t,n_forced*{SEGMENT_SECS})")]);
            if encoder == Encoder::Software {
                a.extend(["-sc_threshold", "0", "-bf", "2"].map(String::from));
            }
        }
        (Some(v), false) => {
            a.extend(["-map".to_string(), format!("0:{v}"), "-c:v".to_string(), "copy".to_string()]);
            if plan.video_codec.as_deref() == Some("hevc") {
                // Safari only plays `hvc1`-tagged HEVC.
                a.extend(["-tag:v", "hvc1"].map(String::from));
            }
        }
        (None, _) => {}
    }
    if let Some(au) = plan.audio {
        a.extend(["-map".to_string(), format!("0:{au}")]);
        if plan.audio_copy {
            a.extend(["-c:a", "copy"].map(String::from));
        } else {
            let br = (64 * plan.audio_channels).clamp(128, 384);
            a.extend(["-c:a".to_string(), "aac".to_string(), "-ac".to_string(), plan.audio_channels.to_string(), "-b:a".to_string(), format!("{br}k")]);
        }
    }
    a.extend(["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-max_muxing_queue_size", "4096"].map(String::from));
    a.extend(["-f", "hls", "-hls_segment_type", "fmp4", "-hls_list_size", "0", "-hls_flags", "temp_file", "-hls_segment_options", "movflags=+frag_discont", "-start_number", "0"].map(String::from));
    a.extend(["-hls_time".to_string(), if plan.video_copy && plan.video.is_some() { COPY_FRAGMENT_SECS.to_string() } else { format!("{SEGMENT_SECS}") }]);
    a.extend(["-hls_fmp4_init_filename".to_string(), format!("r{run}-init.mp4")]);
    a.extend(["-hls_segment_filename".to_string(), dir.join(format!("r{run}-%d.m4s")).display().to_string()]);
    a.push(dir.join(format!("r{run}.m3u8")).display().to_string());
    a
}

// ------------------------------------------------------------------------------------------------
// Variant
// ------------------------------------------------------------------------------------------------

struct Run {
    id: u64,
    start_seg: usize,
    frontier: usize,
    pid: u32,
    exited: bool,
    paused: bool,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct VState {
    run: Option<Run>,
    next_run: u64,
    done: HashMap<usize, Vec<PathBuf>>,
    init: Option<PathBuf>,
    error: Option<String>,
    last_requested: usize,
}

/// Everything a run needs from the media module.
pub struct Launch {
    pub ffmpeg: PathBuf,
    pub encoder: Encoder,
    pub video_height: Option<u32>,
}

pub struct Variant {
    pub key: String,
    pub plan: Plan,
    pub segments: Vec<(f64, f64)>,
    pub dir: PathBuf,
    pub input: String,
    pub owner: String,
    /// Segment the first run starts at (the client's resume position).
    pub hint: usize,
    st: Mutex<VState>,
    notify: Notify,
    pub last_access: AtomicU64,
    pub jobs_started: AtomicU64,
    pub restarts: AtomicU64,
}

#[derive(Debug)]
pub enum WaitError {
    NotFound,
    Timeout,
    Failed(String),
    Quota(crate::error::ApiError),
}

impl Variant {
    pub fn new(key: String, plan: Plan, segments: Vec<(f64, f64)>, dir: PathBuf, input: String, owner: String, start: Option<f64>) -> Self {
        let hint = start.map(|s| segments.iter().rposition(|(st, _)| *st <= s + EPS).unwrap_or(0)).unwrap_or(0);
        Self {
            key,
            plan,
            segments,
            dir,
            input,
            owner,
            hint,
            st: Mutex::new(VState::default()),
            notify: Notify::new(),
            last_access: AtomicU64::new(now_ms()),
            jobs_started: AtomicU64::new(0),
            restarts: AtomicU64::new(0),
        }
    }

    pub fn touch(&self) {
        self.last_access.store(now_ms(), Ordering::Relaxed);
    }

    pub fn idle_for(&self) -> Duration {
        Duration::from_millis(now_ms().saturating_sub(self.last_access.load(Ordering::Relaxed)))
    }

    pub fn is_transcode(&self) -> bool {
        self.plan.mode == Mode::Transcode
    }

    /// A job is running (counted by the transcode quotas).
    pub fn running(&self) -> bool {
        self.st.lock().run.as_ref().is_some_and(|r| !r.exited)
    }

    pub fn target_duration(&self) -> u64 {
        self.segments.iter().map(|s| s.1).fold(0.0, f64::max).ceil().max(1.0) as u64
    }

    /// The media playlist (VOD, complete).
    pub fn playlist(&self) -> String {
        let mut out = String::with_capacity(64 + self.segments.len() * 32);
        out.push_str("#EXTM3U\n#EXT-X-VERSION:7\n");
        out.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", self.target_duration()));
        out.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"init.mp4\"\n");
        for (i, (_, d)) in self.segments.iter().enumerate() {
            out.push_str(&format!("#EXTINF:{d:.6},\n{i}.m4s\n"));
        }
        out.push_str("#EXT-X-ENDLIST\n");
        out
    }

    /// Stops the job and forgets every file (idle, media closed, shutdown).
    pub fn stop(&self, delete: bool) {
        let mut s = self.st.lock();
        if let Some(r) = s.run.take() {
            r.task.abort();
        }
        if delete {
            s.done.clear();
            s.init = None;
            s.error = None;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
        drop(s);
        self.notify.notify_waiters();
    }

    /// Starts a run at segment `k` (the previous one, if any, is killed). `quota` checks the
    /// transcode limits first.
    fn start_run(self: &Arc<Self>, s: &mut VState, k: usize, launch: &Launch, quota: &(dyn Fn() -> Result<(), crate::error::ApiError> + Send + Sync)) -> Result<(), WaitError> {
        let had_run = s.run.as_ref().is_some_and(|r| !r.exited);
        if self.is_transcode() && !had_run {
            quota().map_err(WaitError::Quota)?;
        }
        if let Some(r) = s.run.take() {
            r.task.abort();
            if had_run {
                self.restarts.fetch_add(1, Ordering::Relaxed);
            }
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| WaitError::Failed(format!("hls dir: {e}")))?;
        let id = s.next_run;
        s.next_run += 1;
        s.error = None;
        let start = self.segments[k].0;
        let args = ffmpeg_args(&self.plan, &self.input, start, &self.dir, id, launch.encoder, launch.video_height);
        debug!(variant = %self.key, run = id, seg = k, "ffmpeg {}", args.iter().map(|x| if x.contains("/i/") { "<internal>" } else { x.as_str() }).collect::<Vec<_>>().join(" "));
        let child = tokio::process::Command::new(&launch.ffmpeg)
            .args(&args)
            .current_dir(&self.dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| WaitError::Failed(format!("cannot start ffmpeg: {e}")))?;
        let pid = child.id().unwrap_or(0);
        self.jobs_started.fetch_add(1, Ordering::Relaxed);
        info!(variant = %self.key, run = id, seg = k, mode = ?self.plan.mode, "hls job started");
        let task = tokio::spawn(watch(self.clone(), id, k, child));
        s.run = Some(Run { id, start_seg: k, frontier: k, pid, exited: false, paused: false, task });
        Ok(())
    }

    fn signal(pid: u32, sig: i32) {
        #[cfg(unix)]
        if pid > 0 {
            // SAFETY: kill(2) on our own ffmpeg child.
            unsafe {
                libc::kill(pid as i32, sig);
            }
        }
        let _ = (pid, sig);
    }

    /// Resumes a paused job when the player caught up.
    fn throttle(s: &mut VState) {
        let last = s.last_requested;
        if let Some(r) = s.run.as_mut().filter(|r| !r.exited) {
            #[cfg(unix)]
            {
                if !r.paused && r.frontier > last + PAUSE_AHEAD {
                    Self::signal(r.pid, libc::SIGSTOP);
                    r.paused = true;
                } else if r.paused && r.frontier <= last + RESUME_AHEAD {
                    Self::signal(r.pid, libc::SIGCONT);
                    r.paused = false;
                }
            }
            let _ = last;
        }
    }

    /// The fragment files of segment `k`, waiting for ffmpeg (or restarting it there).
    pub async fn segment(self: &Arc<Self>, k: usize, launch: &Launch, quota: &(dyn Fn() -> Result<(), crate::error::ApiError> + Send + Sync)) -> Result<Vec<PathBuf>, WaitError> {
        if k >= self.segments.len() {
            return Err(WaitError::NotFound);
        }
        self.touch();
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut s = self.st.lock();
                s.last_requested = k;
                if let Some(files) = s.done.get(&k) {
                    let files = files.clone();
                    Self::throttle(&mut s);
                    return Ok(files);
                }
                // A run started at this very segment ended without producing it: give up (an
                // error, or nothing there) instead of restarting ffmpeg in a loop.
                if s.run.as_ref().is_some_and(|r| r.exited && r.start_seg == k) {
                    return Err(match s.error.clone() {
                        Some(e) => WaitError::Failed(e),
                        None => WaitError::NotFound,
                    });
                }
                let restart = match &s.run {
                    None => true,
                    Some(r) => r.exited || k < r.start_seg || k > r.frontier + LOOKAHEAD,
                };
                if restart {
                    self.start_run(&mut s, k, launch, quota)?;
                }
                Self::throttle(&mut s);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(WaitError::Timeout);
            }
        }
    }

    /// The init segment (first run's), starting a job at the hint when none runs.
    pub async fn init(self: &Arc<Self>, launch: &Launch, quota: &(dyn Fn() -> Result<(), crate::error::ApiError> + Send + Sync)) -> Result<PathBuf, WaitError> {
        self.touch();
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut s = self.st.lock();
                if let Some(p) = s.init.clone() {
                    return Ok(p);
                }
                if let (Some(e), true) = (s.error.clone(), s.run.as_ref().is_some_and(|r| r.exited)) {
                    return Err(WaitError::Failed(e));
                }
                if s.run.as_ref().is_none_or(|r| r.exited) {
                    let k = self.hint.min(self.segments.len().saturating_sub(1));
                    s.last_requested = k;
                    self.start_run(&mut s, k, launch, quota)?;
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(WaitError::Timeout);
            }
        }
    }
}

/// Follows one ffmpeg run: new fragments → finished playlist segments.
async fn watch(v: Arc<Variant>, run: u64, start_seg: usize, mut child: tokio::process::Child) {
    let mut stderr = child.stderr.take();
    let err_buf = Arc::new(Mutex::new(String::new()));
    if let Some(mut e) = stderr.take() {
        let buf = err_buf.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut chunk = [0u8; 2048];
            while let Ok(n) = e.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let mut b = buf.lock();
                b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if b.len() > 4096 {
                    let cut = b.len() - 4096;
                    b.drain(..cut);
                }
            }
        });
    }
    let mut frags: Vec<(f64, PathBuf)> = Vec::new();
    let mut assigned = 0usize;
    let mut next_idx = 0usize;
    let mut timescale: Option<u32> = None;
    let mut frontier = start_seg;
    let init_path = v.dir.join(format!("r{run}-init.mp4"));
    let mut tick = tokio::time::interval(Duration::from_millis(120));
    loop {
        tick.tick().await;
        let status = child.try_wait().ok().flatten();
        if timescale.is_none() {
            if let Ok(b) = tokio::fs::read(&init_path).await {
                timescale = init_timescale(&b);
                if timescale.is_some() {
                    let mut s = v.st.lock();
                    if s.init.is_none() {
                        let stable = v.dir.join("init.mp4");
                        if std::fs::copy(&init_path, &stable).is_ok() {
                            s.init = Some(stable);
                        }
                    }
                }
            }
        }
        let Some(ts) = timescale else {
            if let Some(st) = status {
                let mut s = v.st.lock();
                if s.run.as_ref().is_some_and(|r| r.id == run) {
                    if !st.success() {
                        s.error = Some(last_error(&err_buf.lock(), st));
                    }
                    if let Some(r) = s.run.as_mut() {
                        r.exited = true;
                    }
                }
                drop(s);
                v.notify.notify_waiters();
                return;
            }
            continue;
        };
        loop {
            let p = v.dir.join(format!("r{run}-{next_idx}.m4s"));
            let Ok(b) = tokio::fs::read(&p).await else { break };
            match first_tfdt(&b) {
                Some(t) => frags.push((t as f64 / ts as f64, p)),
                None => warn!(variant = %v.key, file = %p.display(), "fragment without tfdt"),
            }
            next_idx += 1;
        }
        let finished = status.is_some_and(|s| s.success());
        let mut newly = Vec::new();
        while frontier < v.segments.len() {
            let end = v.segments.get(frontier + 1).map_or(f64::INFINITY, |s| s.0);
            let complete = frags.iter().skip(assigned).any(|(t, _)| *t >= end - EPS) || finished;
            if !complete {
                break;
            }
            let mut files = Vec::new();
            while assigned < frags.len() && frags[assigned].0 < end - EPS {
                files.push(frags[assigned].1.clone());
                assigned += 1;
            }
            if files.is_empty() && !finished {
                warn!(variant = %v.key, seg = frontier, "segment without fragment");
            }
            newly.push((frontier, files));
            frontier += 1;
        }
        {
            let mut s = v.st.lock();
            if s.run.as_ref().is_none_or(|r| r.id != run) {
                // Replaced by a newer run (seek) or stopped: this one is being killed.
                return;
            }
            for (k, files) in newly {
                if !files.is_empty() {
                    s.done.entry(k).or_insert(files);
                }
            }
            if let Some(r) = s.run.as_mut() {
                r.frontier = frontier;
            }
            Variant::throttle(&mut s);
            if let Some(st) = status {
                if !st.success() {
                    s.error = Some(last_error(&err_buf.lock(), st));
                }
                if let Some(r) = s.run.as_mut() {
                    r.exited = true;
                }
            }
        }
        v.notify.notify_waiters();
        if status.is_some() {
            return;
        }
    }
}

fn last_error(buf: &str, st: std::process::ExitStatus) -> String {
    let line = buf.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
    // Never echo the internal URL (it carries the listener's secret).
    let line = match line.find("http://127.0.0.1") {
        Some(i) => format!("{}<media>", &line[..i]),
        None => line,
    };
    format!("ffmpeg exited ({st}): {line}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::decide::Mode;

    fn plan(mode: Mode, copy: bool) -> Plan {
        Plan { mode, video: Some(0), video_codec: Some("h264".into()), audio: Some(1), video_copy: copy, audio_copy: false, audio_channels: 2, burn: None, max_height: 1080, reasons: vec![] }
    }

    #[test]
    fn command_lines() {
        let dir = Path::new("/cache/hls/m/v");
        let a = ffmpeg_args(&plan(Mode::Remux, true), "http://127.0.0.1:1/i/s/t/h/0", 12.5, dir, 3, Encoder::Software, Some(720)).join(" ");
        assert!(a.contains("-protocol_whitelist http,tcp"));
        assert!(a.contains("-ss 12.501 -copyts"));
        assert!(a.contains("-map 0:0 -c:v copy -map 0:1 -c:a aac -ac 2"));
        assert!(a.contains("-hls_time 0.1"));
        assert!(a.contains("movflags=+frag_discont"));
        assert!(a.contains("r3-init.mp4") && a.contains("/cache/hls/m/v/r3-%d.m4s"));
        let t = ffmpeg_args(&plan(Mode::Transcode, false), "http://127.0.0.1:1/i/s/t/h/0", 0.0, dir, 0, Encoder::Software, Some(2160)).join(" ");
        assert!(!t.contains("-ss"));
        assert!(t.contains("scale=-2:1080,format=yuv420p"));
        assert!(t.contains("libx264") && t.contains("expr:gte(t,n_forced*4)") && t.contains("-hls_time 4"));
        let mut p = plan(Mode::Transcode, false);
        p.burn = Some(4);
        let b = ffmpeg_args(&p, "x", 0.0, dir, 0, Encoder::Vaapi, Some(1080)).join(" ");
        assert!(b.contains("[0:0][0:4]overlay=eof_action=pass,format=nv12,hwupload[vout]"));
        assert!(b.contains("-init_hw_device vaapi=va:/dev/dri/renderD128"));
    }

    #[test]
    fn playlist_and_hint() {
        let v = Variant::new("k".into(), plan(Mode::Remux, true), vec![(0.0, 4.2), (4.2, 5.0), (9.2, 3.0)], "/tmp/x".into(), "x".into(), "o".into(), Some(10.0));
        let p = v.playlist();
        assert!(p.starts_with("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n"));
        assert!(p.contains("#EXT-X-MAP:URI=\"init.mp4\"") && p.contains("#EXTINF:5.000000,\n1.m4s\n") && p.ends_with("#EXT-X-ENDLIST\n"));
        assert_eq!(v.hint, 2);
    }

    #[test]
    fn boxes_parse() {
        // moov/trak/mdia/mdhd (v0) with timescale 12288.
        let mdhd = [&[0u8, 0, 0, 32][..], b"mdhd", &[0; 4], &[0; 8], &12288u32.to_be_bytes(), &[0; 8]].concat();
        let wrap = |t: &[u8; 4], inner: &[u8]| [&((inner.len() + 8) as u32).to_be_bytes()[..], t, inner].concat();
        let init = wrap(b"moov", &wrap(b"trak", &wrap(b"mdia", &mdhd)));
        assert_eq!(init_timescale(&init), Some(12288));
        let tfhd = wrap(b"tfhd", &[&[0u8; 4][..], &1u32.to_be_bytes()].concat());
        let tfdt = wrap(b"tfdt", &[&[1u8, 0, 0, 0][..], &147456u64.to_be_bytes()].concat());
        let frag = [wrap(b"moof", &[wrap(b"mfhd", &[0; 8]), wrap(b"traf", &[tfhd, tfdt].concat())].concat()), wrap(b"mdat", &[1, 2, 3])].concat();
        assert_eq!(first_tfdt(&frag), Some(147456));
    }
}
