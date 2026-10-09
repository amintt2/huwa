//! The HTTP read-ahead proxy (src/http_proxy.rs) against a local upstream server with a time to
//! first byte, a rate, and the failure modes of real debrid links: what the player gets is the
//! file byte for byte, head + tail (+ resume target) are asked in parallel at open (the regression
//! that matters: one round trip instead of mpv's serial ones), no-Range servers and refused links
//! fall back, a stuck range is asked again, release stops every download, memory stays bounded.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use huwa_torrent_core::http_proxy::{HttpProxy, ProxyOptions, HEAD_BYTES, TAIL_BYTES, TAIL_MKV_BYTES};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MIB: u64 = 1024 * 1024;

fn data_of(len: usize) -> Arc<Vec<u8>> {
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    Arc::new(out)
}

// ------------------------------------------------------------------------------------------------
// Upstream: HTTP/1.1 keep-alive, Range, TTFB, rate, failure modes
// ------------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Mode {
    ttfb: Duration,
    /// Bytes/s per response (0 = unlimited).
    rate: f64,
    /// Ignores Range (always 200, whole file).
    no_range: bool,
    /// Every request answered with this status.
    status: Option<u16>,
    /// The first request starting at or after this offset never answers.
    hang_once_from: Option<u64>,
    /// `/r` redirects to `/f`.
    redirect: bool,
}

#[derive(Debug, Clone)]
struct Req {
    t: Duration,
    path: String,
    range: Option<String>,
    start: u64,
    headers: HashMap<String, String>,
}

struct Upstream {
    _rt: tokio::runtime::Runtime,
    port: u16,
    log: Arc<Mutex<Vec<Req>>>,
    sent: Arc<AtomicU64>,
}

impl Upstream {
    fn start(data: Arc<Vec<u8>>, mode: Mode) -> Upstream {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let listener = rt.block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        let log: Arc<Mutex<Vec<Req>>> = Default::default();
        let sent = Arc::new(AtomicU64::new(0));
        let hang_used = Arc::new(AtomicBool::new(false));
        let t0 = Instant::now();
        let (l2, s2) = (log.clone(), sent.clone());
        rt.spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let (data, mode, log, sent, hang_used) = (data.clone(), mode.clone(), l2.clone(), s2.clone(), hang_used.clone());
                tokio::spawn(async move {
                    let _ = conn(sock, data, mode, log, sent, hang_used, t0).await;
                });
            }
        });
        Upstream { _rt: rt, port, log, sent }
    }

    fn requests(&self) -> Vec<Req> {
        self.log.lock().clone()
    }
}

async fn conn(
    sock: tokio::net::TcpStream,
    data: Arc<Vec<u8>>,
    mode: Mode,
    log: Arc<Mutex<Vec<Req>>>,
    sent: Arc<AtomicU64>,
    hang_used: Arc<AtomicBool>,
    t0: Instant,
) -> std::io::Result<()> {
    let _ = sock.set_nodelay(true);
    let (mut rd, mut wr) = sock.into_split();
    let mut buf = Vec::new();
    loop {
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
        let headers: HashMap<String, String> = req
            .lines()
            .skip(1)
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        let range = headers.get("range").cloned();
        let len = data.len() as u64;
        let (mut start, mut end) = match range.as_deref().and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')) {
            Some((a, b)) if !a.is_empty() => (a.parse::<u64>().unwrap(), if b.is_empty() { len } else { (b.parse::<u64>().unwrap() + 1).min(len) }),
            Some((_, b)) => (len.saturating_sub(b.parse().unwrap()), len),
            None => (0, len),
        };
        log.lock().push(Req { t: t0.elapsed(), path: path.clone(), range: range.clone(), start, headers });
        if mode.redirect && path == "r" {
            let loc = "/f";
            wr.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\n\r\n").as_bytes()).await?;
            continue;
        }
        tokio::time::sleep(mode.ttfb).await;
        if let Some(code) = mode.status {
            wr.write_all(format!("HTTP/1.1 {code} Nope\r\nContent-Length: 0\r\n\r\n").as_bytes()).await?;
            continue;
        }
        if mode.hang_once_from.is_some_and(|f| start >= f) && !hang_used.swap(true, Ordering::AcqRel) {
            // Never answers (the connection stays open).
            tokio::time::sleep(Duration::from_secs(3600)).await;
            return Ok(());
        }
        let status = if mode.no_range || range.is_none() {
            (start, end) = (0, len);
            "200 OK".to_string()
        } else {
            "206 Partial Content".to_string()
        };
        let mut head = format!("HTTP/1.1 {status}\r\nContent-Type: video/x-matroska\r\nContent-Length: {}\r\n", end - start);
        if status.starts_with("206") {
            head += &format!("Accept-Ranges: bytes\r\nContent-Range: bytes {start}-{}/{len}\r\n", end - 1);
        }
        head += "\r\n";
        wr.write_all(head.as_bytes()).await?;
        let t_body = tokio::time::Instant::now();
        let mut pos = start;
        while pos < end {
            let n = (end - pos).min(16 * 1024);
            if mode.rate > 0.0 {
                tokio::time::sleep_until(t_body + Duration::from_secs_f64((pos + n - start) as f64 / mode.rate)).await;
            }
            wr.write_all(&data[pos as usize..(pos + n) as usize]).await?;
            sent.fetch_add(n, Ordering::Relaxed);
            pos += n;
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Player side: blocking HTTP/1.1 GET on the loopback URL
// ------------------------------------------------------------------------------------------------

struct Resp {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn get(url: &str, range: Option<&str>, max_body: usize) -> Resp {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_once('/').unwrap();
    let mut s = TcpStream::connect(host).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    let mut req = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(r) = range {
        req += &format!("Range: {r}\r\n");
    }
    req += "\r\n";
    s.write_all(req.as_bytes()).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let status = line.split_whitespace().nth(1).unwrap().parse().unwrap();
    let mut headers = HashMap::new();
    loop {
        line.clear();
        r.read_line(&mut line).unwrap();
        if line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let want = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(max_body);
    let mut body = vec![0u8; want];
    r.read_exact(&mut body).unwrap();
    Resp { status, headers, body }
}

fn open(px: &HttpProxy, args: Value) -> Value {
    px.dispatch("httpOpen", args).unwrap()
}

fn status(px: &HttpProxy, id: u64) -> Value {
    px.dispatch("httpStatus", json!({ "id": id })).unwrap()
}

/// The upstream is on 127.0.0.1: allowed here (the app refuses loopback upstreams).
fn proxy() -> Arc<HttpProxy> {
    HttpProxy::start_with(ProxyOptions { allow_loopback: true }).unwrap()
}

fn url_of(up: &Upstream, path: &str) -> String {
    format!("http://127.0.0.1:{}/{path}", up.port)
}

fn wait_until(deadline: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    f()
}

// ------------------------------------------------------------------------------------------------

#[test]
fn head_and_tail_are_asked_in_parallel_at_open() {
    let data = data_of((24 * MIB) as usize);
    let up = Upstream::start(data.clone(), Mode { ttfb: Duration::from_millis(300), rate: 20e6, ..Default::default() });
    let px = proxy();
    let t0 = Instant::now();
    let o = open(&px, json!({ "url": url_of(&up, "f.mkv"), "prefetch": {} }));
    let loop_url = o["url"].as_str().unwrap().to_string();
    assert!(loop_url.ends_with(".mkv"), "{loop_url}");
    // Both requests leave at once, before the player asks anything.
    assert!(wait_until(Duration::from_secs(1), || up.requests().len() >= 2));
    let reqs = up.requests();
    let head = reqs.iter().find(|r| r.range.as_deref() == Some("bytes=0-")).expect("head request");
    let tail = reqs.iter().find(|r| r.range.as_deref() == Some(&format!("bytes=-{TAIL_MKV_BYTES}"))).expect("tail request (Matroska: Cues + Tags only)");
    assert!(head.t.abs_diff(tail.t) < Duration::from_millis(100), "{:?} vs {:?}", head.t, tail.t);

    // The player's serial reads: head, then the index at the end, then back to the first cluster.
    let len = data.len() as u64;
    let r = get(&loop_url, Some("bytes=0-"), 64 * 1024);
    assert_eq!(r.status, 206);
    assert_eq!(r.headers["content-range"], format!("bytes 0-{}/{len}", len - 1));
    assert_eq!(r.body, data[..64 * 1024]);
    let tail_at = len - 300 * 1024;
    let r = get(&loop_url, Some(&format!("bytes={tail_at}-")), 300 * 1024);
    assert_eq!(r.body, data[tail_at as usize..]);
    let r = get(&loop_url, Some("bytes=70000-"), 512 * 1024);
    assert_eq!(r.body, data[70000..70000 + 512 * 1024]);
    let took = t0.elapsed();
    // Serial upstream requests would take 3 × 300 ms; one round trip (+ transfer) here.
    assert!(took < Duration::from_millis(700), "took {took:?}");
    // Nothing else was asked upstream for those reads.
    assert_eq!(up.requests().len(), 2, "{:?}", up.requests().iter().map(|r| r.range.clone()).collect::<Vec<_>>());
    px.shutdown();
}

#[test]
fn bytes_are_identical_across_segments() {
    let data = data_of((20 * MIB + 12345) as usize);
    let up = Upstream::start(data.clone(), Mode { ttfb: Duration::from_millis(20), ..Default::default() });
    let px = proxy();
    let o = open(&px, json!({ "url": url_of(&up, "v.mp4"), "prefetch": { "readAhead": 1048576 } }));
    let u = o["url"].as_str().unwrap().to_string();
    let len = data.len();
    // Across head → play → tail, closed and open ranges, a full read with no Range.
    for (a, n) in [(0usize, 3 * MIB as usize), (HEAD_BYTES as usize - 1000, 6 * MIB as usize), (len - 3 * MIB as usize, 3 * MIB as usize), (9 * MIB as usize + 7, 1)] {
        let r = get(&u, Some(&format!("bytes={a}-")), n);
        assert_eq!(r.status, 206);
        assert!(r.body == data[a..a + n], "range {a}+{n}");
        let r = get(&u, Some(&format!("bytes={a}-{}", a + n - 1)), n);
        assert!(r.body == data[a..a + n], "closed range {a}+{n}");
    }
    let r = get(&u, None, len);
    assert_eq!(r.status, 200);
    assert!(r.body == *data, "whole file");
    let r = get(&u, Some(&format!("bytes={len}-")), 0);
    assert_eq!(r.status, 416);
    px.shutdown();
}

#[test]
fn resume_target_is_fetched_at_open() {
    let data = data_of((40 * MIB) as usize);
    let up = Upstream::start(data.clone(), Mode { ttfb: Duration::from_millis(100), rate: 20e6, ..Default::default() });
    let px = proxy();
    let o = open(&px, json!({ "url": url_of(&up, "e.mkv"), "prefetch": { "startAt": 600.0, "duration": 1200.0 } }));
    let id = o["id"].as_u64().unwrap();
    assert!(wait_until(Duration::from_secs(2), || up.requests().len() >= 3));
    let reqs = up.requests();
    assert!(reqs.iter().any(|r| r.range.as_deref() == Some(&format!("bytes=0-{}", HEAD_BYTES - 1))), "bounded head for a resume");
    let len = data.len() as u64;
    let want = (len as f64 * (600.0 - huwa_torrent_core::http_proxy::TARGET_BACK_SECS) / 1200.0) as u64;
    let target = reqs.iter().find(|r| r.start > HEAD_BYTES && r.start < len - TAIL_BYTES).expect("target request");
    assert!(target.start.abs_diff(want) < 1024, "{} vs {want}", target.start);
    // The player lands a little after it: served from the target without a new request.
    std::thread::sleep(Duration::from_millis(300));
    let at = want + 300_000;
    let n = reqs.len();
    let r = get(o["url"].as_str().unwrap(), Some(&format!("bytes={at}-")), MIB as usize);
    assert!(r.body == data[at as usize..(at + MIB) as usize]);
    assert_eq!(up.requests().len(), n, "no new upstream request");
    assert!(status(&px, id)["rangeOk"].as_bool().unwrap());
    px.shutdown();
}

#[test]
fn server_without_range_falls_back_to_the_original_url() {
    let data = data_of((8 * MIB) as usize);
    // Paced (40 MB/s per answer): unpaced, `sent` also counts what the kernel's loopback socket
    // buffers absorb before the cut is seen (several MiB on Linux CI runners). An answer that is
    // not cut still sends its whole 8 MiB in ~0.2 s, far above the bound below.
    let up = Upstream::start(data.clone(), Mode { no_range: true, rate: 40e6, ..Default::default() });
    let px = proxy();
    let original = url_of(&up, "n.mkv");
    let o = open(&px, json!({ "url": original, "prefetch": {} }));
    let r = get(o["url"].as_str().unwrap(), Some("bytes=0-"), 0);
    assert_eq!(r.status, 302);
    assert_eq!(r.headers["location"], original);
    let st = status(&px, o["id"].as_u64().unwrap());
    assert!(st["noRange"].as_bool().unwrap(), "{st}");
    // A second open of the same link, or of another one from that server, plays directly at once.
    let again = open(&px, json!({ "url": original, "prefetch": {} }));
    assert_eq!(again["fallback"], "noRange");
    let other = open(&px, json!({ "url": url_of(&up, "other.mkv"), "prefetch": {} }));
    assert_eq!(other["fallback"], "noRange");
    // The whole-file answers were cut: nowhere near 2 × 8 MiB downloaded.
    std::thread::sleep(Duration::from_millis(200));
    assert!(up.sent.load(Ordering::Relaxed) < 4 * MIB, "{}", up.sent.load(Ordering::Relaxed));
    px.shutdown();
}

#[test]
fn refused_link_is_reported_with_its_status() {
    let up = Upstream::start(data_of(1024), Mode { status: Some(403), ..Default::default() });
    let px = proxy();
    let o = open(&px, json!({ "url": url_of(&up, "x.mkv"), "prefetch": {} }));
    let r = get(o["url"].as_str().unwrap(), Some("bytes=0-"), 0);
    assert_eq!(r.status, 403);
    let st = status(&px, o["id"].as_u64().unwrap());
    assert_eq!(st["error"]["status"], 403, "{st}");
    px.shutdown();
}

#[test]
fn stalled_range_is_asked_again() {
    let data = data_of((16 * MIB) as usize);
    let len = data.len() as u64;
    let up = Upstream::start(
        data.clone(),
        Mode { ttfb: Duration::from_millis(100), rate: 20e6, hang_once_from: Some(len - TAIL_MKV_BYTES), ..Default::default() },
    );
    let px = proxy();
    let o = open(&px, json!({ "url": url_of(&up, "h.mkv"), "prefetch": {} }));
    let u = o["url"].as_str().unwrap().to_string();
    let _ = get(&u, Some("bytes=0-"), 1024);
    let t = Instant::now();
    let at = len - 100_000;
    let r = get(&u, Some(&format!("bytes={at}-")), 100_000);
    assert!(r.body == data[at as usize..]);
    // mpv alone waits its network timeout (8 s) before asking again.
    assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
    px.shutdown();
}

#[test]
fn release_stops_every_download_and_memory_is_bounded() {
    let data = data_of((64 * MIB) as usize);
    let up = Upstream::start(data.clone(), Mode { ttfb: Duration::from_millis(20), rate: 30e6, ..Default::default() });
    let px = proxy();
    let o = open(&px, json!({ "url": url_of(&up, "b.mkv"), "prefetch": { "readAhead": 1048576 } }));
    let id = o["id"].as_u64().unwrap();
    let u = o["url"].as_str().unwrap().to_string();
    // Nobody reads: the head stops at its pin, the tail at the end.
    std::thread::sleep(Duration::from_millis(600));
    let fetched = status(&px, id)["bytesFetched"].as_u64().unwrap();
    assert!(fetched <= HEAD_BYTES + TAIL_BYTES + 256 * 1024, "fetched {fetched}");
    // A reader at 3 MiB: the read-ahead (1 MiB) follows it, no further.
    let _ = get(&u, Some("bytes=0-"), 3 * MIB as usize);
    std::thread::sleep(Duration::from_millis(600));
    let st = status(&px, id);
    let fetched = st["bytesFetched"].as_u64().unwrap();
    // The reader's position is what the proxy wrote to its socket: the 3 MiB read plus what the
    // kernel's loopback buffers absorbed before the close (several MiB on Linux CI runners).
    let served = st["bytesServed"].as_u64().unwrap().max(3 * MIB);
    assert!(fetched <= served + MIB + TAIL_BYTES + 512 * 1024, "fetched {fetched}, served {served}");
    assert!(st["retainedBytes"].as_u64().unwrap() <= 8 * MIB, "{st}");
    // Released: nothing more comes from upstream.
    px.dispatch("httpRelease", json!({ "id": id })).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let sent = up.sent.load(Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(500));
    assert!(up.sent.load(Ordering::Relaxed) - sent <= 256 * 1024, "still sending after release");
    // What was read stays for a reopen of the same link (same session, nothing asked again).
    let n = up.requests().len();
    let again = open(&px, json!({ "url": url_of(&up, "b.mkv") }));
    assert_eq!(again["id"].as_u64(), Some(id));
    assert_eq!(again["reused"], true);
    let r = get(again["url"].as_str().unwrap(), Some("bytes=0-1023"), 1024);
    assert!(r.body == data[..1024]);
    assert_eq!(up.requests().len(), n);
    px.shutdown();
}

#[test]
fn headers_redirects_and_sniff_reuse() {
    let data = data_of((6 * MIB) as usize);
    let up = Upstream::start(data.clone(), Mode { redirect: true, ..Default::default() });
    let px = proxy();
    // Header sniff first (no prefetch): the bytes it reads stay for the playback.
    let sniff = open(&px, json!({ "url": url_of(&up, "r"), "headers": { "Cookie": "k=v", "X-Token": "t", "Range": "bytes=9-" } }));
    let id = sniff["id"].as_u64().unwrap();
    let r = get(sniff["url"].as_str().unwrap(), Some("bytes=0-4095"), 4096);
    assert_eq!(r.status, 206);
    assert!(r.body == data[..4096]);
    px.dispatch("httpRelease", json!({ "id": id })).unwrap();
    let first = up.requests();
    assert_eq!(first[0].path, "r");
    assert_eq!(first[0].headers.get("x-token").map(String::as_str), Some("t"));
    assert_eq!(first[0].headers.get("cookie").map(String::as_str), Some("k=v"));
    assert_eq!(first[0].range.as_deref(), Some("bytes=0-4095"), "the caller's Range header is never forwarded");
    // Playback of the same link: same session, and the redirect target is asked directly.
    let play = open(&px, json!({ "url": url_of(&up, "r"), "headers": { "Cookie": "k=v", "X-Token": "t", "Range": "bytes=9-" }, "prefetch": {} }));
    assert_eq!(play["id"].as_u64(), Some(id));
    let r = get(play["url"].as_str().unwrap(), Some("bytes=0-"), 2 * MIB as usize);
    assert!(r.body == data[..2 * MIB as usize]);
    let later: Vec<Req> = up.requests().into_iter().skip(first.len()).collect();
    assert!(!later.is_empty() && later.iter().all(|r| r.path == "f"), "{:?}", later.iter().map(|r| r.path.clone()).collect::<Vec<_>>());
    px.shutdown();
}

#[test]
fn size_hint_sends_the_resume_target_with_head_and_tail() {
    let data = data_of((40 * MIB) as usize);
    let len = data.len() as u64;
    let up = Upstream::start(data.clone(), Mode { ttfb: Duration::from_millis(300), rate: 20e6, ..Default::default() });
    let px = proxy();
    // MP4: the whole 2 MiB tail (its moov); the size from the addon: the target leaves at once.
    let _ = open(&px, json!({ "url": url_of(&up, "m.mp4"), "prefetch": { "startAt": 600.0, "duration": 1200.0, "size": len } }));
    assert!(wait_until(Duration::from_secs(1), || up.requests().len() >= 3));
    let reqs = up.requests();
    assert!(reqs.iter().any(|r| r.range.as_deref() == Some(&format!("bytes=-{TAIL_BYTES}"))), "MP4 tail");
    let target = reqs.iter().find(|r| r.start > HEAD_BYTES && r.start < len - TAIL_BYTES).expect("target");
    let first = reqs.iter().map(|r| r.t).min().unwrap();
    assert!(target.t - first < Duration::from_millis(100), "target sent with the others, not after the first answer: {:?}", target.t - first);
    px.shutdown();
}
