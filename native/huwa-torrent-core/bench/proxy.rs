//! Prototype of a loopback read-ahead proxy for remote HTTP streams (`--http-proxy`): the head of
//! the file and its tail (suffix range: no need to know the length) are fetched in parallel as
//! soon as the link is opened; the player's requests are served from them when they fall inside,
//! else passed through. Measures what parallel prefetch saves over mpv's serial requests (each
//! paying the server's time to first byte). Plain HTTP/1.1 only (the bench's server).

use super::*;

pub const HEAD_CAP: u64 = 8 * MIB;
pub const TAIL_CAP: u64 = 2 * MIB;

#[derive(Default)]
struct Buf {
    data: Vec<u8>,
    /// Absolute offset of `data[0]` (tail: known with the first response).
    at: Option<u64>,
    len: Option<u64>,
    done: bool,
}

struct Shared {
    upstream: (String, u16, String),
    head: Mutex<Buf>,
    tail: Mutex<Buf>,
    notify: tokio::sync::Notify,
}

fn parse_url(url: &str) -> (String, u16, String) {
    let rest = url.strip_prefix("http://").unwrap();
    let (hostport, path) = rest.split_once('/').unwrap();
    let (host, port) = hostport.split_once(':').map(|(h, p)| (h.to_string(), p.parse().unwrap())).unwrap_or((hostport.to_string(), 80));
    (host, port, format!("/{path}"))
}

/// GET with a Range; returns (status line, content-range total and start, body reader).
async fn get(up: &(String, u16, String), range: &str) -> std::io::Result<(Option<u64>, Option<u64>, tokio::io::BufReader<TcpStream>, u64)> {
    let mut s = TcpStream::connect((up.0.as_str(), up.1)).await?;
    s.set_nodelay(true)?;
    s.write_all(format!("GET {} HTTP/1.1\r\nHost: {}\r\nRange: bytes={range}\r\nConnection: close\r\n\r\n", up.2, up.0).as_bytes()).await?;
    let mut r = tokio::io::BufReader::new(s);
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0u8; 1];
        if r.read(&mut b).await? == 0 {
            return Err(std::io::Error::other("eof in headers"));
        }
        head.push(b[0]);
    }
    let text = String::from_utf8_lossy(&head).to_ascii_lowercase();
    let cr = text.lines().find_map(|l| l.strip_prefix("content-range:")).map(|v| v.trim().trim_start_matches("bytes ").to_string());
    let (start, total) = cr
        .as_deref()
        .and_then(|v| v.split_once('/'))
        .map(|(range, total)| (range.split('-').next().and_then(|x| x.parse().ok()), total.parse().ok()))
        .unwrap_or((None, None));
    let clen = text.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    Ok((start, total, r, clen))
}

async fn fill(sh: Arc<Shared>, tail: bool) {
    let range = if tail { format!("-{TAIL_CAP}") } else { format!("0-{}", HEAD_CAP - 1) };
    let Ok((start, total, mut r, _)) = get(&sh.upstream, &range).await else { return };
    {
        let mut b = if tail { sh.tail.lock() } else { sh.head.lock() };
        b.at = start.or(Some(0));
        b.len = total;
    }
    sh.notify.notify_waiters();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await.unwrap_or(0);
        {
            let mut b = if tail { sh.tail.lock() } else { sh.head.lock() };
            if n == 0 {
                b.done = true;
            } else {
                b.data.extend_from_slice(&buf[..n]);
            }
        }
        sh.notify.notify_waiters();
        if n == 0 {
            return;
        }
    }
}

/// Bytes `[pos, …)` from a buffer: waits until they are there, the buffer is complete, or they
/// are not in it at all (`None`).
async fn from_buf(sh: &Shared, tail: bool, pos: u64) -> Option<Vec<u8>> {
    loop {
        let notified = sh.notify.notified();
        {
            let b = if tail { sh.tail.lock() } else { sh.head.lock() };
            if let Some(at) = b.at {
                let end = at + b.data.len() as u64;
                if pos < at || (b.done && pos >= end) || (!tail && pos >= at + HEAD_CAP) {
                    return None;
                }
                if pos < end {
                    return Some(b.data[(pos - at) as usize..].to_vec());
                }
            } else if b.done {
                return None;
            }
        }
        notified.await;
    }
}

async fn serve(sh: Arc<Shared>, mut c: TcpStream) -> std::io::Result<()> {
    let _ = c.set_nodelay(true);
    let mut req = Vec::new();
    while !req.ends_with(b"\r\n\r\n") {
        let mut b = [0u8; 1];
        if c.read(&mut b).await? == 0 {
            return Ok(());
        }
        req.push(b[0]);
    }
    let text = String::from_utf8_lossy(&req).to_ascii_lowercase();
    let range = text.lines().find_map(|l| l.strip_prefix("range:")).map(|v| v.trim().trim_start_matches("bytes=").to_string());
    let start: u64 = range.as_deref().and_then(|r| r.split('-').next()).and_then(|x| x.parse().ok()).unwrap_or(0);
    // Total length: from whichever prefetch answered first.
    let total = loop {
        let notified = sh.notify.notified();
        let t = sh.head.lock().len.or(sh.tail.lock().len);
        if let Some(t) = t {
            break t;
        }
        notified.await;
    };
    let head = format!(
        "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{total}\r\nConnection: close\r\n\r\n",
        total - start,
        total - 1
    );
    c.write_all(head.as_bytes()).await?;
    let mut pos = start;
    let tail_from = total.saturating_sub(TAIL_CAP);
    while pos < total {
        let tail = pos >= tail_from;
        match from_buf(&sh, tail, pos).await {
            Some(bytes) => {
                c.write_all(&bytes).await?;
                pos += bytes.len() as u64;
            }
            None => {
                // Outside the prefetched bytes: straight from the server.
                let (_, _, mut r, mut left) = get(&sh.upstream, &format!("{pos}-")).await?;
                let mut buf = vec![0u8; 64 * 1024];
                while left > 0 {
                    let n = r.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    c.write_all(&buf[..n]).await?;
                    left = left.saturating_sub(n as u64);
                }
                break;
            }
        }
    }
    Ok(())
}

pub struct Proxy {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts the prefetch of `url` at once and serves it on a loopback port.
pub fn start(rt: &tokio::runtime::Runtime, url: &str) -> Proxy {
    let sh = Arc::new(Shared { upstream: parse_url(url), head: Default::default(), tail: Default::default(), notify: Default::default() });
    let listener = rt.block_on(TcpListener::bind(("127.0.0.1", 0))).unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = rt.spawn(async move {
        let (h, t) = (tokio::spawn(fill(sh.clone(), false)), tokio::spawn(fill(sh.clone(), true)));
        while let Ok((c, _)) = listener.accept().await {
            tokio::spawn(serve(sh.clone(), c));
        }
        h.abort();
        t.abort();
    });
    Proxy { port, task }
}
