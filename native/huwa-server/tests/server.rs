//! End-to-end tests of huwa-server over real HTTP, offline:
//! - a torrent served by a local librqbit seeder (synthetic data, loopback TCP) streamed with
//!   `Range` → `206` through `/s/<token>/t/…`;
//! - the HTTP proxy refusing internal upstreams (`10.0.0.1`, `169.254.169.254`, a rebinding name
//!   at open and at connect time);
//! - session isolation (`list` / `status` / media routes) and the per-session stream quota (429).

use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use huwa_server::{App, ServerConfig};
use huwa_torrent_core::{net_policy::Lookup, probe::CachedMeta};
use librqbit::{spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session, SessionOptions};
use serde_json::{json, Value};

const MIB: usize = 1024 * 1024;

fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("huwa-server-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Server {
    app: App,
    base: String,
    client: reqwest::Client,
    rt: tokio::runtime::Runtime,
    _dir: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.app.shutdown();
    }
}

struct Resp {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, k: &str) -> Option<String> {
        self.headers.get(k).and_then(|v| v.to_str().ok()).map(String::from)
    }
}

impl Server {
    fn start(tag: &str, tweak: impl FnOnce(&mut ServerConfig)) -> Server {
        let dir = temp_dir(tag);
        let mut cfg = ServerConfig {
            bind: IpAddr::from([127, 0, 0, 1]),
            port: 0,
            cache_dir: dir.join("cache"),
            data_dir: Some(dir.join("data")),
            worker_threads: 2,
            ..Default::default()
        };
        tweak(&mut cfg);
        let addr = SocketAddr::new(cfg.bind, cfg.port);
        let app = App::new(cfg).unwrap();
        let bound = app.spawn(addr).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let client = rt.block_on(async { reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(60)).build().unwrap() });
        Server { app, base: format!("http://{bound}"), client, rt, _dir: dir }
    }

    fn send(&self, req: reqwest::RequestBuilder) -> Resp {
        self.rt.block_on(async {
            let r = req.send().await.unwrap();
            let status = r.status().as_u16();
            let headers = r.headers().clone();
            let body = r.bytes().await.unwrap().to_vec();
            Resp { status, headers, body }
        })
    }

    fn get(&self, path: &str, range: Option<&str>) -> Resp {
        let url = if path.starts_with("http") { path.to_string() } else { format!("{}{path}", self.base) };
        let mut req = self.client.get(url);
        if let Some(r) = range {
            req = req.header("range", r);
        }
        self.send(req)
    }

    fn session(&self) -> String {
        let r = self.send(self.client.post(format!("{}/api/v1/session", self.base)).body("{}"));
        assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
        r.json()["token"].as_str().unwrap().to_string()
    }

    fn call(&self, token: &str, method: &str, args: Value) -> Resp {
        let req = self
            .client
            .post(format!("{}/api/v1/engine/{method}", self.base))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(args.to_string());
        self.send(req)
    }
}

#[test]
fn info_sessions_auth_and_cors() {
    let s = Server::start("info", |_| {});
    let info = s.get("/api/v1/info", None);
    assert_eq!(info.status, 200);
    let v = info.json();
    assert_eq!(v["api"], 1);
    assert_eq!(v["features"]["seeding"], false);
    assert_eq!(v["features"]["torrent"], true);
    assert_eq!(v["limits"]["streamsPerSession"], 2);

    let tok = s.session();
    assert!(tok.starts_with("v1."));
    // Persisted key: a token stays valid for another server instance on the same data dir.
    assert!(s._dir.join("data/token.key").exists());

    // No token, bad token, tampered token.
    let r = s.send(s.client.post(format!("{}/api/v1/engine/list", s.base)));
    assert_eq!((r.status, r.json()["code"].as_str()), (401, Some("unauthorized")));
    assert_eq!(s.call("v1.nope", "list", json!({})).status, 401);
    let mut t = tok.clone();
    t.pop();
    t.push(if tok.ends_with('0') { '1' } else { '0' });
    assert_eq!(s.call(&t, "list", json!({})).status, 401);

    // Allowed, forbidden, unknown methods.
    let r = s.call(&tok, "list", json!({}));
    assert_eq!((r.status, r.json()), (200, json!([])));
    for m in ["setConfig", "clearCache", "enforceQuota", "tlsCheck"] {
        let r = s.call(&tok, m, json!({}));
        assert_eq!((r.status, r.json()["code"].as_str()), (403, Some("forbidden_method")), "{m}");
    }
    let r = s.call(&tok, "nope", json!({}));
    assert_eq!((r.status, r.json()["code"].as_str()), (404, Some("unknown_method")));
    let r = s.call(&tok, "startStream", json!({ "infoHash": "zz" }));
    assert_eq!((r.status, r.json()["code"].as_str()), (400, Some("bad_request")));

    // CORS: the public web app's origin is allowed by default, others are not.
    let pre = |origin: &str| {
        s.send(
            s.client
                .request(reqwest::Method::OPTIONS, format!("{}/api/v1/engine/list", s.base))
                .header("origin", origin)
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", "authorization,content-type"),
        )
    };
    let ok = pre("https://huwa.mciut.fr");
    assert_eq!(ok.header("access-control-allow-origin").as_deref(), Some("https://huwa.mciut.fr"));
    assert!(pre("https://evil.example").header("access-control-allow-origin").is_none());
}

/// A local seeder (upload on, loopback TCP) for a synthetic `.mkv`, announced to the engine as the
/// probe's answering peer (the same path as a probed torrent; no tracker, no DHT needed).
struct Seeder {
    session: Arc<Session>,
    hex: String,
    data: Vec<u8>,
}

fn seed(s: &Server, len: usize) -> Seeder {
    let dir = s._dir.join("seed");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("episode.mkv");
    let data = pseudo_random(len, 0x5EED_1234_ABCD_0001);
    std::fs::write(&file, &data).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let engine = s.app.engine().clone();
    let (session, hex, bytes) = engine.runtime.block_on(async {
        let created = librqbit::create_torrent(
            &file,
            CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(256 * 1024) },
            &BlockingSpawner::new(2),
        )
        .await
        .unwrap();
        let bytes = created.as_bytes().unwrap();
        let session = Session::new_with_opts(
            dir.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                listen: Some(ListenerOptions { listen_addr: SocketAddr::from(([127, 0, 0, 1], port)), ipv4_only: true, ..Default::default() }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let added = session
            .add_torrent(
                AddTorrent::from_bytes(bytes.clone()),
                Some(AddTorrentOptions { overwrite: true, output_folder: Some(dir.to_string_lossy().into_owned()), ..Default::default() }),
            )
            .await
            .unwrap();
        added.into_handle().unwrap().wait_until_completed().await.unwrap();
        (session, created.info_hash().as_string().to_lowercase(), bytes)
    });
    engine.meta_cache.insert(&hex, CachedMeta::new(bytes, vec![("episode.mkv".into(), len as u64)], vec![SocketAddr::from(([127, 0, 0, 1], port))], Instant::now()));
    Seeder { session, hex, data }
}

#[test]
fn torrent_range_stream_from_a_local_seeder() {
    let s = Server::start("stream", |_| {});
    let seeder = seed(&s, 8 * MIB);
    let tok = s.session();
    let r = s.call(&tok, "startStream", json!({ "infoHash": seeder.hex }));
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let url = r.json()["url"].as_str().unwrap().to_string();
    assert_eq!(url, format!("/s/{tok}/t/{}/0.mkv", seeder.hex), "session media URL");

    let len = seeder.data.len();
    let head = s.get(&url, Some("bytes=0-65535"));
    assert_eq!(head.status, 206, "{}", String::from_utf8_lossy(&head.body));
    assert_eq!(head.header("content-range"), Some(format!("bytes 0-65535/{len}")));
    assert_eq!(head.header("accept-ranges").as_deref(), Some("bytes"));
    assert_eq!(head.header("content-type").as_deref(), Some("video/x-matroska"));
    assert!(head.body == seeder.data[..65536], "head bytes");

    let tail = s.get(&url, Some("bytes=-4096"));
    assert_eq!(tail.status, 206);
    assert!(tail.body == seeder.data[len - 4096..], "tail bytes");
    let mid = s.get(&url, Some(&format!("bytes={}-{}", len / 2, len / 2 + MIB - 1)));
    assert_eq!(mid.status, 206);
    assert!(mid.body == seeder.data[len / 2..len / 2 + MIB], "middle bytes");

    // Status through the session, with the session URL; another session sees nothing.
    let st = s.call(&tok, "status", json!({ "id": seeder.hex })).json();
    assert_eq!(st["url"], url.as_str());
    assert!(st["peersLive"].as_u64().unwrap() >= 1 || st["state"] == "finished", "{st}");
    let other = s.session();
    assert_eq!(s.get(&url.replace(&tok, &other), Some("bytes=0-1")).status, 404);
    assert_eq!(s.get(&format!("/s/v1.bad/t/{}/0.mkv", seeder.hex), Some("bytes=0-1")).status, 401);

    s.app.engine().runtime.block_on(async { seeder.session.stop().await });
}

/// Fake DNS: `rebind.test` answers a public address once, then loopback (DNS rebinding);
/// `private.test` always answers 10.0.0.1.
struct FakeDns {
    rebind_calls: AtomicUsize,
}

impl Lookup for FakeDns {
    fn lookup(&self, host: &str) -> std::io::Result<Vec<SocketAddr>> {
        let ip: IpAddr = match host {
            "rebind.test" => {
                if self.rebind_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    [93, 184, 216, 34].into()
                } else {
                    [127, 0, 0, 1].into()
                }
            }
            "private.test" => [10, 0, 0, 1].into(),
            _ => return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no such host")),
        };
        Ok(vec![SocketAddr::new(ip, 0)])
    }
}

/// A local "upstream" that counts the connections it gets (it must get none).
fn counting_upstream() -> (u16, Arc<AtomicUsize>) {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = l.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        for c in l.incoming() {
            let Ok(mut c) = c else { return };
            h.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0u8; 2048];
            let _ = c.read(&mut buf);
            let _ = c.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-1/2\r\nContent-Length: 2\r\n\r\nok");
        }
    });
    (port, hits)
}

#[test]
fn http_proxy_refuses_internal_upstreams() {
    let dns = Arc::new(FakeDns { rebind_calls: AtomicUsize::new(0) });
    let s = Server::start("ssrf", |c| c.dns = Some(dns.clone()));
    let tok = s.session();
    let (port, hits) = counting_upstream();

    for url in [
        "http://10.0.0.1/".to_string(),
        "http://169.254.169.254/latest/meta-data/".to_string(),
        format!("http://127.0.0.1:{port}/a.mkv"),
        format!("http://[::ffff:127.0.0.1]:{port}/a.mkv"),
        format!("http://localhost:{port}/a.mkv"),
        "http://private.test/video.mkv".to_string(),
    ] {
        let r = s.call(&tok, "httpOpen", json!({ "url": url, "prefetch": {} }));
        assert_eq!((r.status, r.json()["code"].as_str()), (403, Some("upstream_blocked")), "{url}: {}", String::from_utf8_lossy(&r.body));
    }

    // Rebinding: public when opened, loopback when the fetch connects → refused by the resolver.
    let r = s.call(&tok, "httpOpen", json!({ "url": format!("http://rebind.test:{port}/video.mkv") }));
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let v = r.json();
    let id = v["id"].as_u64().unwrap();
    let media = v["url"].as_str().unwrap().to_string();
    assert_eq!(media, format!("/s/{tok}/http/{id}.mkv"));
    let got = s.get(&media, Some("bytes=0-"));
    assert_eq!(got.status, 403, "{}", String::from_utf8_lossy(&got.body));
    let st = s.call(&tok, "httpStatus", json!({ "id": id })).json();
    assert_eq!(st["error"]["status"], 403, "{st}");
    assert_eq!(hits.load(Ordering::SeqCst), 0, "the internal upstream was never contacted");
    assert!(dns.rebind_calls.load(Ordering::SeqCst) >= 2);

    // Another session cannot use or inspect that proxy session.
    let other = s.session();
    assert_eq!(s.call(&other, "httpStatus", json!({ "id": id })).status, 404);
    assert_eq!(s.get(&media.replace(&tok, &other), Some("bytes=0-1")).status, 404);
}

#[test]
fn sessions_are_isolated_and_streams_are_capped() {
    let s = Server::start("isolation", |_| {});
    let (a, b) = (s.session(), s.session());
    // Never-resolving hashes: registry and URLs only, nothing downloads.
    let h = |n: u8| format!("{:02x}", n).repeat(20);
    let (ha, hb) = (h(0xa1), h(0xb2));
    assert_eq!(s.call(&a, "startStream", json!({ "infoHash": ha })).status, 200);
    assert_eq!(s.call(&b, "startStream", json!({ "infoHash": hb })).status, 200);

    let ids = |tok: &str| -> Vec<String> {
        let r = s.call(tok, "list", json!({}));
        assert_eq!(r.status, 200);
        let mut v: Vec<String> = r.json().as_array().unwrap().iter().map(|t| t["infoHash"].as_str().unwrap().to_string()).collect();
        v.sort();
        v
    };
    assert_eq!(ids(&a), vec![ha.clone()]);
    assert_eq!(ids(&b), vec![hb.clone()]);
    let stats = s.call(&a, "stats", json!({})).json();
    assert_eq!(stats["torrents"].as_array().unwrap().len(), 1);
    for m in ["status", "pause", "resume", "release", "remove"] {
        let r = s.call(&b, m, json!({ "id": ha }));
        assert_eq!(r.status, 404, "{m} on another session's torrent");
    }
    assert_eq!(s.get(&format!("/s/{b}/t/{ha}/auto"), Some("bytes=0-1")).status, 404);

    // Dedup by info hash: b starts a's torrent too; a's remove only drops a's interest.
    assert_eq!(s.call(&b, "startStream", json!({ "infoHash": ha })).status, 200);
    assert_eq!(s.call(&a, "remove", json!({ "id": ha })).status, 200);
    assert!(s.app.engine().entry(&ha).is_some(), "still held by b");
    assert_eq!(ids(&a), Vec::<String>::new());
    assert_eq!(s.call(&b, "status", json!({ "id": ha })).status, 200);
    assert_eq!(s.call(&b, "remove", json!({ "id": ha })).status, 200);
    assert!(s.app.engine().entry(&ha).is_none(), "last holder removed it");

    // Quota: 2 streams per session, the third is 429; releasing one frees a slot.
    let c = s.session();
    let (h1, h2, h3) = (h(0xc1), h(0xc2), h(0xc3));
    assert_eq!(s.call(&c, "startStream", json!({ "infoHash": h1 })).status, 200);
    assert_eq!(s.call(&c, "startStream", json!({ "infoHash": h2 })).status, 200);
    assert_eq!(s.call(&c, "startStream", json!({ "infoHash": h1 })).status, 200, "same stream again");
    let r = s.call(&c, "startStream", json!({ "infoHash": h3 }));
    assert_eq!(r.status, 429);
    assert_eq!(r.json()["code"], "quota_exceeded");
    assert_eq!(r.json()["limit"], 2);
    assert!(r.header("retry-after").is_some());
    assert_eq!(ids(&c).len(), 2, "the refused stream was not registered");
    // Another session is not affected by c's quota.
    assert_eq!(s.call(&a, "startStream", json!({ "infoHash": h3 })).status, 200);
    assert_eq!(s.call(&c, "release", json!({ "id": h1 })).status, 200);
    assert_eq!(s.call(&c, "startStream", json!({ "infoHash": h3 })).status, 200);
    let mut want = vec![h1.clone(), h2.clone(), h3.clone()];
    want.sort();
    assert_eq!(ids(&c), want, "released torrents stay listed (cache), without a stream slot");
}
