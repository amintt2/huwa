//! Text subtitle sidecars (D14), extracted progressively.
//!
//! One ffmpeg per media session reads the internal URL (from `since`, `-copyts`) and writes every
//! text track as ASS (`-flush_packets 1`), plus a null output that makes `-progress` follow the
//! read position. Requests re-read those files and answer the events that end after `since`, as
//! ASS (`/subs/<id>/<track>.ass`, header + events: the format JASSUB / libass want) or WebVTT
//! (`.vtt`, override tags stripped). Events of earlier runs (before a seek) are kept and merged.
//! `X-Huwa-Subs-Until` says how far the extraction got, `X-Huwa-Subs-Complete: 1` that it reached
//! the end: clients poll with `since` = what they have.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use parking_lot::Mutex;
use tokio::io::AsyncBufReadExt;
use tracing::info;

use super::hls::now_ms;

/// One ASS event.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub start: f64,
    pub end: f64,
    /// The full `Dialogue:` line.
    pub line: String,
    /// The text field.
    pub text: String,
}

/// `H:MM:SS.cc` → seconds.
pub fn ass_time(s: &str) -> Option<f64> {
    let mut it = s.trim().split(':');
    let (h, m, sec) = (it.next()?, it.next()?, it.next()?);
    Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + sec.parse::<f64>().ok()?)
}

/// Splits an ASS file into its header (up to and including the `[Events]` `Format:` line) and its
/// events.
pub fn parse_ass(text: &str) -> (String, Vec<Event>) {
    let mut header = String::new();
    let mut events = Vec::new();
    let mut in_events = false;
    for line in text.lines() {
        let l = line.trim_end_matches('\r');
        if l.starts_with("Dialogue:") {
            in_events = true;
            let body = l["Dialogue:".len()..].trim_start();
            let f: Vec<&str> = body.splitn(10, ',').collect();
            if f.len() == 10 {
                if let (Some(s), Some(e)) = (ass_time(f[1]), ass_time(f[2])) {
                    events.push(Event { start: s, end: e, line: l.to_string(), text: f[9].to_string() });
                }
            }
        } else if !in_events {
            header.push_str(l);
            header.push('\n');
        }
    }
    (header, events)
}

/// ASS text → WebVTT cue text: override blocks removed, `\N` line breaks, entities escaped.
pub fn ass_to_vtt_text(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut depth = 0;
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            _ if depth > 0 => {}
            '\\' => match chars.peek() {
                Some('N') | Some('n') => {
                    chars.next();
                    out.push('\n');
                }
                Some('h') => {
                    chars.next();
                    out.push(' ');
                }
                _ => out.push('\\'),
            },
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

pub fn vtt_time(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub fn to_vtt(events: &[Event]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for e in events {
        let text = ass_to_vtt_text(&e.text);
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!("{} --> {}\n{}\n\n", vtt_time(e.start), vtt_time(e.end), text));
    }
    out
}

pub fn to_ass(header: &str, events: &[Event]) -> String {
    let mut out = String::with_capacity(header.len() + events.len() * 80);
    out.push_str(header);
    if !header.contains("[Events]") {
        out.push_str("\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    }
    for e in events {
        out.push_str(&e.line);
        out.push('\n');
    }
    out
}

/// SRT → WebVTT (compat `/subtitles.vtt`).
pub fn srt_to_vtt(srt: &str) -> String {
    let s = srt.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if s.trim_start().starts_with("WEBVTT") {
        return s;
    }
    let mut out = String::from("WEBVTT\n\n");
    for block in s.split("\n\n") {
        let mut lines = block.lines().filter(|l| !l.trim().is_empty()).peekable();
        if lines.peek().is_some_and(|l| l.trim().chars().all(|c| c.is_ascii_digit())) {
            lines.next();
        }
        let Some(timing) = lines.next() else { continue };
        if !timing.contains("-->") {
            continue;
        }
        out.push_str(&timing.replace(',', "."));
        out.push('\n');
        for l in lines {
            out.push_str(l);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

struct Run {
    id: u64,
    start: f64,
    progress_ms: Arc<AtomicU64>,
    exited: Arc<AtomicBool>,
    ok: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct State {
    run: Option<Run>,
    next_run: u64,
    /// Track → events by (start ms, line) (merged across runs).
    events: HashMap<usize, BTreeMap<(u64, String), Event>>,
    headers: HashMap<usize, String>,
    /// File sizes already parsed, per (run, track).
    parsed: HashSet<(u64, usize, u64)>,
}

pub struct Subs {
    /// `(track ordinal, absolute stream index)` of the text subtitle tracks.
    pub tracks: Vec<(usize, usize)>,
    /// Absolute index of a stream that keeps `-progress` moving (audio or video).
    pub pacer: Option<usize>,
    pub duration: f64,
    pub dir: PathBuf,
    pub input: String,
    pub ffmpeg: PathBuf,
    st: Mutex<State>,
    pub last_access: AtomicU64,
}

pub struct Answer {
    pub body: String,
    pub until: f64,
    pub complete: bool,
}

impl Subs {
    pub fn new(tracks: Vec<(usize, usize)>, pacer: Option<usize>, duration: f64, dir: PathBuf, input: String, ffmpeg: PathBuf) -> Self {
        Self { tracks, pacer, duration, dir, input, ffmpeg, st: Mutex::new(State::default()), last_access: AtomicU64::new(now_ms()) }
    }

    pub fn idle_for(&self) -> Duration {
        Duration::from_millis(now_ms().saturating_sub(self.last_access.load(Ordering::Relaxed)))
    }

    pub fn stop(&self) {
        if let Some(r) = self.st.lock().run.take() {
            r.task.abort();
        }
    }

    fn args(&self, run: u64, start: f64) -> Vec<String> {
        let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y", "-protocol_whitelist", "http,tcp", "-rw_timeout", "120000000"].map(String::from).to_vec();
        if start > 0.0 {
            a.extend(["-ss".to_string(), format!("{start:.3}")]);
        }
        a.extend(["-copyts", "-start_at_zero", "-i"].map(String::from));
        a.push(self.input.clone());
        for (ord, abs) in &self.tracks {
            a.extend(["-map".to_string(), format!("0:{abs}"), "-c:s".to_string(), "ass".to_string(), "-flush_packets".to_string(), "1".to_string(), "-f".to_string(), "ass".to_string()]);
            a.push(self.dir.join(format!("r{run}-{ord}.ass")).display().to_string());
        }
        if let Some(p) = self.pacer {
            a.extend(["-map".to_string(), format!("0:{p}"), "-c".to_string(), "copy".to_string(), "-f".to_string(), "null".to_string(), "-".to_string()]);
        }
        a.extend(["-progress", "pipe:1"].map(String::from));
        a
    }

    fn start(&self, s: &mut State, start: f64) -> anyhow::Result<()> {
        if let Some(r) = s.run.take() {
            r.task.abort();
        }
        std::fs::create_dir_all(&self.dir)?;
        let id = s.next_run;
        s.next_run += 1;
        let mut child = tokio::process::Command::new(&self.ffmpeg)
            .args(self.args(id, start))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let progress_ms = Arc::new(AtomicU64::new((start * 1000.0) as u64));
        let (exited, ok) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        let (p, e, o) = (progress_ms.clone(), exited.clone(), ok.clone());
        let stdout = child.stdout.take();
        let task = tokio::spawn(async move {
            if let Some(out) = stdout {
                let mut lines = tokio::io::BufReader::new(out).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if let Some(v) = l.strip_prefix("out_time_us=").or_else(|| l.strip_prefix("out_time_ms=")) {
                        if let Ok(us) = v.trim().parse::<u64>() {
                            p.fetch_max(us / 1000, Ordering::Relaxed);
                        }
                    }
                }
            }
            let st = child.wait().await;
            o.store(st.is_ok_and(|s| s.success()), Ordering::Relaxed);
            e.store(true, Ordering::Relaxed);
        });
        info!(run = id, start, tracks = self.tracks.len(), "subtitle extraction started");
        s.run = Some(Run { id, start, progress_ms, exited, ok, task });
        Ok(())
    }

    /// Re-reads the current run's files.
    fn refresh(&self, s: &mut State) {
        let Some(run) = s.run.as_ref() else { return };
        let id = run.id;
        for (ord, _) in &self.tracks {
            let path = self.dir.join(format!("r{id}-{ord}.ass"));
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            if !s.parsed.insert((id, *ord, meta.len())) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let (header, events) = parse_ass(&text);
            if header.contains("[Script Info]") {
                s.headers.entry(*ord).or_insert(header);
            }
            let map = s.events.entry(*ord).or_default();
            for e in events {
                map.entry(((e.start * 1000.0) as u64, e.line.clone())).or_insert(e);
            }
        }
    }

    /// Events of `track` that end after `since` (starting / restarting the extraction as needed).
    pub fn get(&self, track: usize, since: f64, ass: bool) -> anyhow::Result<Option<Answer>> {
        if !self.tracks.iter().any(|(o, _)| *o == track) {
            return Ok(None);
        }
        self.last_access.store(now_ms(), Ordering::Relaxed);
        let mut s = self.st.lock();
        let (restart, from) = match s.run.as_ref() {
            None => (true, (since - 5.0).max(0.0)),
            Some(r) => {
                let progress = r.progress_ms.load(Ordering::Relaxed) as f64 / 1000.0;
                let behind = since + 1.0 < r.start;
                let far_ahead = !r.exited.load(Ordering::Relaxed) && since > progress + 120.0;
                (behind || far_ahead, (since - 5.0).max(0.0))
            }
        };
        if restart {
            self.start(&mut s, from)?;
        }
        self.refresh(&mut s);
        let r = s.run.as_ref().expect("run started");
        let done = r.exited.load(Ordering::Relaxed) && r.ok.load(Ordering::Relaxed);
        let until = if done { self.duration } else { r.progress_ms.load(Ordering::Relaxed) as f64 / 1000.0 };
        let complete = done && r.start <= 0.001;
        let events: Vec<Event> = s.events.get(&track).map(|m| m.values().filter(|e| e.end >= since).cloned().collect()).unwrap_or_default();
        let body = if ass {
            let header = s.headers.get(&track).cloned().unwrap_or_else(|| "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n".to_string());
            to_ass(&header, &events)
        } else {
            to_vtt(&events)
        };
        Ok(Some(Answer { body, until, complete }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASS: &str = "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello {\\i1}world{\\i0}\nDialogue: 0,0:01:10.50,0:01:12.00,Default,,0,0,0,,Line, two\\Nsecond <b>\n";

    #[test]
    fn ass_parsing_and_vtt() {
        let (h, ev) = parse_ass(ASS);
        assert!(h.contains("[Events]") && h.contains("Format: Layer"));
        assert_eq!(ev.len(), 2);
        assert_eq!((ev[1].start, ev[1].end), (70.5, 72.0));
        assert_eq!(ev[1].text, "Line, two\\Nsecond <b>");
        let vtt = to_vtt(&ev);
        assert!(vtt.starts_with("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n\n"));
        assert!(vtt.contains("00:01:10.500 --> 00:01:12.000\nLine, two\nsecond &lt;b&gt;\n"));
        let ass = to_ass(&h, &ev[1..]);
        assert!(ass.ends_with("Dialogue: 0,0:01:10.50,0:01:12.00,Default,,0,0,0,,Line, two\\Nsecond <b>\n"));
        assert!(!ass.contains("Hello"));
    }

    #[test]
    fn srt() {
        let v = srt_to_vtt("\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nThere\r\nfriend\r\n");
        assert_eq!(v, "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHi\n\n00:00:03.000 --> 00:00:04.000\nThere\nfriend\n\n");
        assert_eq!(vtt_time(3725.0425), "01:02:05.043");
    }
}
