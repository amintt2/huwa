//! Plain-HTTP side of the bench (bench/README.md):
//! - `FileServer`: serves the fixtures over HTTP/1.1 with `Range`, a configurable time to first
//!   byte and throughput per response (the `http-<ttfb>-<rate>` profiles: debrid / AIOStreams
//!   links), and optionally only an allowed set of byte ranges (reads outside it hang);
//! - `need`: which bytes mpv reads before its first frame, found by bisection against that gate;
//! - `floor`: the same torrent swarm and engine with no player: how fast those bytes arrive.

use super::*;
use tokio::io::AsyncSeekExt;

// ------------------------------------------------------------------------------------------------
// HTTP file server
// ------------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct ServeCfg {
    pub ttfb: Duration,
    /// Bytes/s per response (0 = unlimited).
    pub rate: f64,
    /// Only these `[start, end)` ranges are served; a read reaching another byte hangs.
    pub allowed: Option<Vec<(u64, u64)>>,
    /// The first request starting at or after this offset never answers (a stuck range); the
    /// next ones are served (`hang-tail` with `--hang-once`).
    pub hang_once_from: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServedReq {
    pub path: String,
    pub t_ms: u64,
    pub start: u64,
    pub end: u64,
}

pub struct FileServer {
    pub port: u16,
    pub cfg: Arc<Mutex<ServeCfg>>,
    /// Requests since the last `reset` (start offsets, in order).
    pub log: Arc<Mutex<Vec<ServedReq>>>,
    t0: Arc<Mutex<Instant>>,
    /// Bumped by `reset`: connections of an older trial stop.
    generation: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FileServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FileServer {
    pub fn start(rt: &tokio::runtime::Runtime, dir: PathBuf, cfg: ServeCfg) -> FileServer {
        let listener = rt.block_on(TcpListener::bind(("127.0.0.1", 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cfg = Arc::new(Mutex::new(cfg));
        let log: Arc<Mutex<Vec<ServedReq>>> = Default::default();
        let t0 = Arc::new(Mutex::new(Instant::now()));
        let generation = Arc::new(AtomicU64::new(0));
        let (c, l, t, g) = (cfg.clone(), log.clone(), t0.clone(), generation.clone());
        let task = rt.spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let (dir, c, l, t, g) = (dir.clone(), c.clone(), l.clone(), t.clone(), g.clone());
                tokio::spawn(async move {
                    let _ = serve_conn(sock, dir, c, l, t, g).await;
                });
            }
        });
        FileServer { port, cfg, log, t0, generation, task }
    }

    pub fn url(&self, name: &str) -> String {
        format!("http://127.0.0.1:{}/{name}", self.port)
    }

    /// New trial: older connections stop, the log restarts, times count from now.
    pub fn reset(&self, cfg: ServeCfg) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        *self.cfg.lock() = cfg;
        self.log.lock().clear();
        *self.t0.lock() = Instant::now();
    }
}

fn allowed_prefix(allowed: &Option<Vec<(u64, u64)>>, pos: u64, want: u64) -> u64 {
    let Some(list) = allowed else { return want };
    list.iter().find(|(s, e)| *s <= pos && pos < *e).map_or(0, |(_, e)| (e - pos).min(want))
}

async fn serve_conn(
    sock: TcpStream,
    dir: PathBuf,
    cfg: Arc<Mutex<ServeCfg>>,
    log: Arc<Mutex<Vec<ServedReq>>>,
    t0: Arc<Mutex<Instant>>,
    generation: Arc<AtomicU64>,
) -> std::io::Result<()> {
    let gen = generation.load(Ordering::Acquire);
    let _ = sock.set_nodelay(true);
    let (mut rd, mut wr) = sock.into_split();
    let mut buf = Vec::new();
    loop {
        // One request (headers only: GET).
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            let n = rd.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let req = String::from_utf8_lossy(&buf[..head_end]).to_string();
        buf.drain(..head_end);
        let path = req.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
        let range = req
            .lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("range:").map(|v| v.trim().to_string()))
            .and_then(|v| v.strip_prefix("bytes=").map(str::to_string));
        let file = dir.join(urlencoding::decode(&path).map(|c| c.into_owned()).unwrap_or(path.clone()));
        let Ok(md) = tokio::fs::metadata(&file).await else {
            wr.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await?;
            continue;
        };
        let len = md.len();
        let (start, end) = match range.as_deref().and_then(|r| r.split_once('-')) {
            Some((a, b)) if !a.is_empty() => (a.parse::<u64>().unwrap_or(0), if b.is_empty() { len } else { (b.parse::<u64>().unwrap_or(len - 1) + 1).min(len) }),
            Some((_, b)) => (len.saturating_sub(b.parse().unwrap_or(0)), len),
            None => (0, len),
        };
        let mut c = cfg.lock().clone();
        if c.hang_once_from.is_some_and(|f| start >= f) {
            cfg.lock().hang_once_from = None;
            c.allowed = Some(Vec::new());
        }
        if generation.load(Ordering::Acquire) != gen {
            return Ok(());
        }
        log.lock().push(ServedReq { path: path.clone(), t_ms: t0.lock().elapsed().as_millis() as u64, start, end });
        tokio::time::sleep(c.ttfb).await;
        if generation.load(Ordering::Acquire) != gen {
            return Ok(());
        }
        let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{len}\r\n\r\n",
            end - start,
            end.saturating_sub(1)
        );
        wr.write_all(head.as_bytes()).await?;
        let mut f = tokio::fs::File::open(&file).await?;
        f.seek(std::io::SeekFrom::Start(start)).await?;
        let mut pos = start;
        let mut data = vec![0u8; 64 * 1024];
        let t_body = tokio::time::Instant::now();
        while pos < end {
            if generation.load(Ordering::Acquire) != gen {
                return Ok(());
            }
            let want = (end - pos).min(data.len() as u64);
            let ok = allowed_prefix(&c.allowed, pos, want);
            if ok == 0 {
                // Outside the allowed bytes: hang (like a piece that never arrives).
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
            let n = ok as usize;
            f.read_exact(&mut data[..n]).await?;
            if c.rate > 0.0 {
                let due = t_body + Duration::from_secs_f64((pos + ok - start) as f64 / c.rate);
                tokio::time::sleep_until(due).await;
            }
            wr.write_all(&data[..n]).await?;
            pos += ok;
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Bytes mpv needs before its first frame
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Need {
    pub file: String,
    pub scenario: String,
    pub len: u64,
    /// `[start, start + bytes)` read before frame 1, per region mpv opened.
    pub regions: Vec<(u64, u64)>,
    /// Size of their union.
    pub bytes: u64,
}

fn union_len(regions: &[(u64, u64)]) -> u64 {
    let mut v: Vec<(u64, u64)> = regions.iter().map(|(s, n)| (*s, s + n)).collect();
    v.sort();
    let (mut total, mut cur): (u64, Option<(u64, u64)>) = (0, None);
    for (s, e) in v {
        match cur {
            Some((cs, ce)) if s <= ce => cur = Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                total += ce - cs;
                cur = Some((s, e));
            }
            None => cur = Some((s, e)),
        }
    }
    total + cur.map_or(0, |(s, e)| e - s)
}

pub fn need_path(args: &Args) -> PathBuf {
    args.fixtures.join("need.json")
}

pub fn load_needs(args: &Args) -> Vec<Need> {
    std::fs::read(need_path(args)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Frame 1 within `deadline` with only `allowed` served.
fn trial(mpv: &mut Mpv, srv: &FileServer, file: &str, start: f64, allowed: Option<Vec<(u64, u64)>>, deadline: Duration) -> bool {
    mpv.cmd(json!(["stop"]));
    // The previous file fully closed before the gate changes (its last requests are not ours).
    let _ = mpv.wait("END", Instant::now() + Duration::from_secs(2), &mut |_, _| {});
    std::thread::sleep(Duration::from_millis(50));
    while mpv.rx.try_recv().is_ok() {}
    srv.reset(ServeCfg { allowed, ..Default::default() });
    mpv.load(&srv.url(file), start);
    mpv.wait("RESTART", Instant::now() + deadline, &mut |_, _| {}).is_some()
}

/// `need` scenario: for each file, start and resume, the regions mpv opens before frame 1 and how
/// many bytes of each it really needs (bisection, 16 KiB steps, the others unrestricted).
pub fn measure_needs(b: &Bench) {
    let srv = FileServer::start(&b.rt, b.args.fixtures.clone(), ServeCfg::default());
    let mut mpv = Mpv::spawn(&b.args, "need");
    let mut out = load_needs(&b.args);
    for file in &b.args.files {
        let len = std::fs::metadata(b.args.fixtures.join(file)).unwrap().len();
        for (scenario, start) in [("start", 0.0), ("resume", b.args.resume_at)] {
            assert!(trial(&mut mpv, &srv, file, start, None, Duration::from_secs(10)), "{file} {scenario}: no frame even unrestricted");
            // Regions: the request starts (this file only), merged when within 64 KiB of each other.
            let mut starts: Vec<u64> = srv.log.lock().iter().filter(|r| r.path == *file).map(|r| r.start).collect();
            starts.sort();
            starts.dedup_by(|a, b| a.abs_diff(*b) < 64 * KIB);
            // Minimised one after the other: the regions already done keep their minimum, the
            // next ones are open up to the following region (never over each other).
            let mut regions: Vec<(u64, u64)> = Vec::new();
            for (i, s) in starts.iter().enumerate() {
                let open_end = |j: usize| starts.get(j + 1).copied().unwrap_or(len);
                let others = |n: u64| -> Vec<(u64, u64)> {
                    let mut v: Vec<(u64, u64)> = regions.iter().map(|(rs, rn)| (*rs, rs + rn)).collect();
                    v.extend(starts.iter().enumerate().skip(i + 1).map(|(j, o)| (*o, open_end(j))));
                    v.push((*s, (s + n).min(open_end(i))));
                    v
                };
                // Exponential search, then bisection.
                let (mut lo, mut hi) = (0u64, 64 * KIB);
                let span = open_end(i) - s;
                while !trial(&mut mpv, &srv, file, start, Some(others(hi)), Duration::from_secs(3)) {
                    lo = hi;
                    if hi >= span {
                        break;
                    }
                    hi = (hi * 2).min(span);
                }
                while hi - lo > 16 * KIB {
                    let mid = (lo + hi) / 2;
                    if trial(&mut mpv, &srv, file, start, Some(others(mid)), Duration::from_secs(3)) {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                regions.push((*s, hi));
            }
            // The union, checked: frame 1 with exactly those bytes.
            let allowed: Vec<(u64, u64)> = regions.iter().map(|(s, n)| (*s, s + n)).collect();
            let ok = trial(&mut mpv, &srv, file, start, Some(allowed), Duration::from_secs(5));
            let need = Need { file: file.clone(), scenario: scenario.into(), len, bytes: union_len(&regions), regions };
            println!("need {file} {scenario}: {} KiB in {:?}{}", need.bytes / KIB, need.regions, if ok { "" } else { " (union alone did NOT play)" });
            out.retain(|n| !(n.file == need.file && n.scenario == need.scenario));
            out.push(need);
        }
    }
    std::fs::write(need_path(&b.args), serde_json::to_vec_pretty(&out).unwrap()).unwrap();
}

// ------------------------------------------------------------------------------------------------
// Floor: the needed bytes, downloaded with no player
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct FloorResult {
    pub profile: String,
    pub file: String,
    pub scenario: String,
    pub rep: usize,
    pub piece_kib: u64,
    pub need_kib: u64,
    /// `startStream` → every needed byte on disk (verified pieces).
    pub floor_ms: Option<u64>,
    /// `startStream` → contiguous bytes from the start offset: 1, 4, 16 MiB.
    pub curve_ms: Vec<(u64, Option<u64>)>,
    pub probe_ms: u64,
}

/// Same swarm, same engine (probe → `startStream`), no player: a greedy reader from the start
/// offset (what "just downloading" gives) plus narrow walkers on the other needed regions.
#[cfg(not(huwa_baseline))]
pub fn run_floor(b: &Bench, profile_name: &str, file: &str, scenario: &str, rep: usize) -> FloorResult {
    let need = load_needs(&b.args)
        .into_iter()
        .find(|n| n.file == file && n.scenario == scenario)
        .unwrap_or_else(|| panic!("no need for {file} {scenario}: run --scenarios need first"));
    let p = profile(profile_name);
    b.fresh_seeder();
    let f = b.fixture(file, file);
    let _swarm = b.swarm_for(&f, &p);
    let dir = b.fresh_dir("floor");
    let engine = b.engine(&dir);
    let mut r = FloorResult { profile: p.name, file: file.into(), scenario: scenario.into(), rep, need_kib: need.bytes / KIB, ..Default::default() };
    r.probe_ms = b.probe(&engine, &f).0;
    let t0 = Instant::now();
    b.start_stream(&engine, &f);
    let entry = engine.entry(&f.hex).unwrap();
    let res = engine.runtime.block_on(async {
        let h = entry.wait_ready(Duration::from_secs(30)).await?;
        // Only what is read: no natural-order download competing.
        h.wait_until_initialized().await?;
        engine.sync_selection(&entry, &h, false).await;
        anyhow::Ok(h)
    });
    let Ok(h) = res else { return r };
    let file_idx = entry.selected_file.read().unwrap_or(0);
    let g = huwa_torrent_core::streaming::Geometry::of(&h, file_idx).unwrap();
    r.piece_kib = g.piece_len / KIB;
    // The region the greedy reader starts on: the resume target for a resume, else offset 0.
    let mut regions = need.regions.clone();
    regions.sort();
    let greedy = if scenario == "resume" { *regions.iter().filter(|(s, _)| *s > 0 && *s < need.len - 16 * MIB).max().unwrap_or(&regions[0]) } else { regions[0] };
    let others: Vec<(u64, u64)> = regions.iter().copied().filter(|r| *r != greedy && !(r.0 >= greedy.0 && r.0 + r.1 <= greedy.0 + greedy.1.max(64 * KIB) + 64 * KIB)).collect();
    let marks = [greedy.1, MIB, 4 * MIB, 16 * MIB];
    // The floor of this build: blocks as they land with `--unverified`, else verified pieces.
    let unverified = b.args.unverified;
    let timeout = b.args.timeout;
    // Shared with the measuring tasks: kept when the timeout cuts them.
    let curve: Arc<Mutex<Vec<(u64, Option<u64>)>>> = Arc::new(Mutex::new(marks.iter().map(|m| (*m, None)).collect()));
    let floor_at: Arc<Mutex<Option<u64>>> = Default::default();
    let (c2, f2) = (curve.clone(), floor_at.clone());
    let job = async move {
        // Phase 1, the floor: exactly the needed bytes (narrow streams), nothing else asked for.
        let walkers = others.iter().map(|(s, n)| {
            let h = h.clone();
            let (s, n) = (*s, *n);
            async move { huwa_torrent_core::streaming::fetch_region(h, file_idx, g, s, s + n, unverified).await.is_ok() }
        });
        let Ok(mut st) = h.clone().stream(file_idx).await else { return };
        st.set_lookahead(greedy.1.max(1));
        st.set_urgent(true);
        st.set_unverified(unverified);
        let _ = st.seek(std::io::SeekFrom::Start(greedy.0)).await;
        let mut got = 0u64;
        let mut buf = vec![0u8; 256 * 1024];
        let record = |got: u64| {
            let ms = t0.elapsed().as_millis() as u64;
            for c in c2.lock().iter_mut() {
                if c.1.is_none() && got >= c.0 {
                    c.1 = Some(ms);
                }
            }
        };
        let head = async {
            while got < greedy.1 {
                match st.read(&mut buf).await {
                    Ok(0) | Err(_) => return false,
                    Ok(n) => got += n as u64,
                }
                record(got);
            }
            true
        };
        let (ok, w) = tokio::join!(head, futures::future::join_all(walkers));
        if ok && w.iter().all(|x| *x) {
            *f2.lock() = Some(t0.elapsed().as_millis() as u64);
        }
        // Phase 2, the raw curve: then just download from there (librqbit's 32 MiB look-ahead).
        st.set_lookahead(32 * MIB);
        st.set_urgent(false);
        while got < 16 * MIB {
            match st.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n as u64,
            }
            record(got);
        }
    };
    let _ = engine.runtime.block_on(async move { tokio::time::timeout(timeout, job).await });
    r.curve_ms = curve.lock().clone();
    r.floor_ms = *floor_at.lock();
    engine.shutdown();
    drop(engine);
    let _ = std::fs::remove_dir_all(&dir);
    r
}

// ------------------------------------------------------------------------------------------------
// HTTP streams (debrid / AIOStreams links played by mpv)
// ------------------------------------------------------------------------------------------------

/// `http-<ttfb>-<rate>`, e.g. `http-300ms-10M` (rate in MB/s).
pub fn http_profile(name: &str) -> Option<ServeCfg> {
    let rest = name.strip_prefix("http-")?;
    let (ttfb, rate) = rest.split_once('-')?;
    Some(ServeCfg { ttfb: parse_duration(ttfb), rate: rate.trim_end_matches('M').parse::<f64>().ok()? * 1e6, allowed: None, hang_once_from: None })
}

/// One start / resume / seek of an HTTP link with mpv (no engine).
pub fn run_http(b: &Bench, profile_name: &str, file: &str, scenario: &str, rep: usize) -> RunResult {
    let cfg = http_profile(profile_name).unwrap();
    let srv = FileServer::start(&b.rt, b.args.fixtures.clone(), cfg.clone());
    let mut mpv = Mpv::spawn(&b.args, "http");
    let mut r = RunResult { profile: profile_name.into(), file: file.into(), scenario: scenario.into(), rep, ..Default::default() };
    let start = if scenario == "resume" { b.args.resume_at } else { 0.0 };
    srv.reset(cfg);
    let t0 = Instant::now();
    // The URL reaches the player: with `--http-proxy`, through the read-ahead proxy started now.
    let px = b.args.http_proxy.then(|| crate::proxy::start(&b.rt, &srv.url(file)));
    let url = match &px {
        Some(p) => format!("http://127.0.0.1:{}/{file}", p.port),
        None => srv.url(file),
    };
    mpv.load_remote(&url, start);
    let mut stalls = Stalls::default();
    let ff = mpv.wait("RESTART", t0 + b.args.timeout, &mut |_, _| {});
    if let Some(t) = ff {
        r.start_to_frame_ms = Some((t - t0).as_millis() as u64);
        r.tap_to_frame_ms = r.start_to_frame_ms;
    } else {
        r.note = "no first frame".into();
    }
    if scenario == "seek" && ff.is_some() {
        std::thread::sleep(Duration::from_secs(1));
        let ts = Instant::now();
        mpv.cmd(json!(["seek", format!("{:.3}", b.args.seek_to), "absolute"]));
        match mpv.wait("RESTART", ts + b.args.timeout, &mut |t, l| stalls.on_line(t, l, ff)) {
            Some(t) => r.seek_ms = Some((t - ts).as_millis() as u64),
            None => r.note = "seek: no frame".into(),
        }
    }
    if b.args.play_secs > 0.0 {
        if let Some(f0) = ff {
            let _ = mpv.wait("\u{1}never", f0 + Duration::from_secs_f64(b.args.play_secs), &mut |t, l| stalls.on_line(t, l, ff));
            if let Some(s) = stalls.since.take() {
                stalls.total += Instant::now() - s;
            }
        }
    }
    r.stalls = stalls.count;
    r.stall_ms = stalls.total.as_millis() as u64;
    r.timeline = json!({ "requests": *srv.log.lock() });
    r
}

/// `hang-tail`: an HTTP server whose last `tail` bytes never come (a debrid link stuck on a range
/// near the end): how long mpv takes to show frame 1 anyway, start and resume.
pub fn hang_tail(b: &Bench) {
    let srv = FileServer::start(&b.rt, b.args.fixtures.clone(), ServeCfg::default());
    let mut mpv = Mpv::spawn(&b.args, "hang");
    for file in &b.args.files {
        let len = std::fs::metadata(b.args.fixtures.join(file)).unwrap().len();
        for (scenario, start) in [("start", 0.0), ("resume", b.args.resume_at)] {
            mpv.cmd(json!(["stop"]));
            let _ = mpv.wait("END", Instant::now() + Duration::from_secs(2), &mut |_, _| {});
            while mpv.rx.try_recv().is_ok() {}
            let cfg = if b.args.hang_once {
                ServeCfg { ttfb: Duration::from_millis(100), rate: 10e6, allowed: None, hang_once_from: Some(len - 2 * MIB) }
            } else {
                ServeCfg { ttfb: Duration::from_millis(100), rate: 10e6, allowed: Some(vec![(0, len - 2 * MIB)]), hang_once_from: None }
            };
            srv.reset(cfg);
            let t = Instant::now();
            mpv.load_remote(&srv.url(file), start);
            let ff = mpv.wait("RESTART", t + b.args.timeout, &mut |_, _| {});
            let reqs: Vec<(u64, u64)> = srv.log.lock().iter().map(|r| (r.t_ms, r.start)).collect();
            println!("hang-tail {file} {scenario}: frame {} s, requests {:?}", fmt_ms(ff.map(|f| (f - t).as_millis() as u64)), reqs);
        }
    }
}
