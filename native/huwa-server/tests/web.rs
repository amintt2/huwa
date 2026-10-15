//! Server plumbing, in both builds (`engine` and `--no-default-features`, the `-web` image):
//! static web app with SPA fallback, `/huwa-config.json`, robots / noindex, `/metrics` access,
//! the `/p2p` reverse proxy (HTTP + WebSocket upgrade) and the child supervisor, built-in TLS.

mod common;

use std::{
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

use common::Server;
use serde_json::Value;

fn web_dir(s: &std::path::Path) -> std::path::PathBuf {
    let d = s.join("web");
    std::fs::create_dir_all(d.join("_expo/static/js")).unwrap();
    std::fs::create_dir_all(d.join(".well-known")).unwrap();
    std::fs::write(d.join("index.html"), "<!doctype html><title>Huwa</title>").unwrap();
    std::fs::write(d.join("_expo/static/js/entry-abc123.js"), "console.log(1)").unwrap();
    std::fs::write(d.join(".well-known/apple-app-site-association"), "{\"applinks\":{}}").unwrap();
    d
}

#[test]
fn static_app_config_and_headers() {
    let tmp = common::temp_dir("webdir");
    let dir = web_dir(&tmp);
    let s = Server::start("web", |c| {
        c.web_dir = Some(dir.clone());
        c.instance_name = Some("Chez moi".into());
        c.operator_contact = Some("admin@example.org".into());
    });
    let index = s.get("/", None);
    assert_eq!(index.status, 200);
    assert!(index.text().contains("<title>Huwa</title>"));
    assert_eq!(index.header("cache-control").as_deref(), Some("no-cache"));
    assert_eq!(index.header("x-robots-tag").as_deref(), Some("noindex, nofollow"));
    // SPA fallback: unknown app routes are index.html.
    let deep = s.get("/anime/21/episode/3", None);
    assert_eq!(deep.status, 200);
    assert!(deep.text().contains("<title>Huwa</title>"));
    let js = s.get("/_expo/static/js/entry-abc123.js", None);
    assert_eq!(js.status, 200);
    assert_eq!(js.header("cache-control").as_deref(), Some("public, max-age=31536000, immutable"));
    assert_eq!(s.get("/.well-known/apple-app-site-association", None).header("content-type").as_deref(), Some("application/json"));
    // API and media paths never fall back to the app.
    let api = s.get("/api/v1/nope", None);
    assert_eq!((api.status, api.json()["code"].as_str()), (404, Some("not_found")));
    assert_eq!(s.get("/s/tok/nothing/here", None).status, 404);

    let cfg: Value = s.get("/huwa-config.json", None).json();
    assert_eq!(cfg["v"], 1);
    assert_eq!(cfg["instance"]["name"], "Chez moi");
    assert_eq!(cfg["instance"]["operatorContact"], "admin@example.org");
    assert_eq!(cfg["features"]["seeding"], false);
    assert_eq!(cfg["features"]["torrent"], cfg!(feature = "engine"));
    assert_eq!(s.get("/robots.txt", None).text(), "User-agent: *\nDisallow: /\n");

    // /metrics: loopback only by default, never through a relaying proxy.
    let m = s.get("/metrics", None);
    assert_eq!(m.status, 200);
    assert!(m.text().contains("huwa_http_requests_total"));
    let relayed = s.send(s.client.get(s.url("/metrics")).header("x-forwarded-for", "203.0.113.4"));
    assert_eq!(relayed.status, 404);

    let indexable = Server::start("web-indexable", |c| c.indexable = true);
    assert!(indexable.get("/health", None).header("x-robots-tag").is_none());
    assert_eq!(indexable.get("/robots.txt", None).text(), "User-agent: *\nAllow: /\n");
}

/// The `-web` image of huwa.mciut.fr: `site/` under the app (docker/Dockerfile.web), the rules of
/// `site/nginx.conf`.
#[test]
fn legacy_site_pages() {
    let tmp = common::temp_dir("legacy");
    let dir = web_dir(&tmp);
    std::fs::create_dir_all(dir.join("altstore")).unwrap();
    std::fs::write(dir.join(".well-known/assetlinks.json"), "[]").unwrap();
    for f in ["get", "extensions", "privacy", "terms", "pack"] {
        std::fs::write(dir.join(format!("{f}.html")), format!("<!doctype html><title>{f}</title>")).unwrap();
    }
    std::fs::write(dir.join("altstore-source.json"), "{\"name\":\"Huwa\"}").unwrap();
    std::fs::write(dir.join("altstore/icon.png"), [0x89, b'P', b'N', b'G']).unwrap();
    let s = Server::start("legacy", |c| {
        c.web_dir = Some(dir.clone());
        c.indexable = true;
    });
    let title = |p: &str| {
        let r = s.get(p, None);
        assert_eq!(r.status, 200, "{p}");
        let t = r.text();
        t.split("<title>").nth(1).and_then(|x| x.split("</title>").next()).unwrap_or("").to_string()
    };
    for (path, want) in [
        ("/", "Huwa"),
        ("/get", "get"),
        ("/get/", "get"),
        ("/privacy", "privacy"),
        ("/privacy.html", "privacy"),
        ("/terms", "terms"),
        ("/pack", "pack"),
        ("/extensions", "extensions"),
        ("/addon?url=https%3A%2F%2Fa.example%2Fmanifest.json", "extensions"),
        ("/install?url=x&type=paperback", "extensions"),
        ("/anime/21", "Huwa"),
    ] {
        assert_eq!(title(path), want, "{path}");
    }
    assert_eq!(s.get("/get", None).header("cache-control").as_deref(), Some("no-cache"));
    // Association files: JSON, 200 at the exact path (reqwest would follow a redirect: check the URL too).
    for p in ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"] {
        let r = s.get(p, None);
        assert_eq!((r.status, r.header("content-type").as_deref()), (200, Some("application/json")), "{p}");
    }
    assert_eq!(s.get("/altstore-source.json", None).header("content-type").as_deref(), Some("application/json"));
    assert_eq!(s.get("/altstore/icon.png", None).header("content-type").as_deref(), Some("image/png"));
    // Never the app under /.well-known or /altstore.
    assert_eq!(s.get("/.well-known/nope", None).status, 404);
    assert_eq!(s.get("/altstore/nope.png", None).status, 404);
    // Public site: indexable.
    assert!(s.get("/get", None).header("x-robots-tag").is_none());

    // Self-hosted image (no legacy files): /addon and /install are the app's routes.
    let plain = Server::start("legacy-none", |c| c.web_dir = Some(web_dir(&common::temp_dir("legacy-none"))));
    assert!(plain.get("/install?url=x", None).text().contains("<title>Huwa</title>"));
    assert!(plain.get("/get", None).text().contains("<title>Huwa</title>"));
}

#[test]
fn engine_routes_follow_the_build() {
    let s = Server::start("build", |_| {});
    let tok = s.session();
    let r = s.send(s.client.post(s.url("/api/v1/engine/list")).header("authorization", format!("Bearer {tok}")));
    let info = s.get("/api/v1/info", None).json();
    if cfg!(feature = "engine") {
        assert_eq!(r.status, 200);
        assert_eq!(info["features"]["torrent"], true);
    } else {
        // The `-web` image: no engine, no proxy, no ffmpeg.
        assert_eq!(r.status, 404);
        assert_eq!(info["features"]["torrent"], false);
        assert_eq!(info["features"]["transcode"], false);
        assert_eq!(info["engine"], Value::Null);
    }
    // HUWA_TORRENT=0 in an engine build behaves like the web build.
    let off = Server::start("build-off", |c| c.torrent = false);
    let tok = off.session();
    let r = off.send(off.client.post(off.url("/api/v1/engine/list")).header("authorization", format!("Bearer {tok}")));
    assert_eq!(r.status, 404);
}

/// A fake gateway: answers `GET /p2p/health` and echoes bytes after a WebSocket upgrade.
fn fake_gateway() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut c) = c else { return };
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 4096];
                let n = c.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                if req.to_ascii_lowercase().contains("upgrade: websocket") {
                    let fwd = req.to_ascii_lowercase().contains("x-forwarded-for: 127.0.0.1");
                    let _ = c.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Saw-Forwarded: {fwd}\r\n\r\n").as_bytes());
                    loop {
                        let n = c.read(&mut buf).unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        let _ = c.write_all(&buf[..n]);
                    }
                } else {
                    let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                    let body = format!("{{\"path\":\"{path}\"}}");
                    let _ = c.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
                }
            });
        }
    });
    port
}

#[test]
fn p2p_proxy_http_and_websocket() {
    let port = fake_gateway();
    let s = Server::start("p2p", |c| {
        c.p2p_gateway = true;
        c.gateway_port = port;
        // No Node in the test: the supervisor only starts existing scripts.
        c.gateway_script = "/nonexistent/relay.js".into();
        c.max_ws = 1;
    });
    let r = s.get("/p2p/rendezvous?x=1", None);
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["path"], "/p2p/rendezvous?x=1");

    let ws = |s: &Server| -> (TcpStream, String) {
        let mut c = TcpStream::connect(s.addr).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        c.write_all(b"GET /p2p HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://huwa.mciut.fr\r\n\r\n").unwrap();
        let mut buf = vec![0u8; 2048];
        let n = c.read(&mut buf).unwrap();
        (c, String::from_utf8_lossy(&buf[..n]).to_string())
    };
    let (mut c, head) = ws(&s);
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(head.to_ascii_lowercase().contains("x-saw-forwarded: true"), "{head}");
    c.write_all(b"ping-bytes").unwrap();
    let mut buf = [0u8; 64];
    let n = c.read(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"ping-bytes");
    // HUWA_MAX_WS=1: a second WebSocket is refused while the first is open.
    let (_c2, head2) = ws(&s);
    assert!(head2.starts_with("HTTP/1.1 503"), "{head2}");
    drop(c);

    // Gateway disabled: 503.
    let off = Server::start("p2p-off", |c| c.p2p_gateway = false);
    assert_eq!(off.get("/p2p", None).status, 503);
}

#[test]
fn supervisor_restarts_and_stops_children() {
    use huwa_server::gateway::{ChildSpec, Supervisor};
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let sup = Supervisor::default();
        sup.spawn(ChildSpec { name: "flaky".into(), program: "sh".into(), args: vec!["-c".into(), "exit 3".into()], env: vec![], cwd: None });
        sup.spawn(ChildSpec { name: "steady".into(), program: "sleep".into(), args: vec!["600".into()], env: vec![], cwd: None });
        tokio::time::sleep(Duration::from_millis(3500)).await;
        let st = sup.status();
        let flaky = st.iter().find(|c| c.0 == "flaky").unwrap();
        assert!(flaky.2 >= 1, "restarted with backoff: {st:?}");
        let steady = st.iter().find(|c| c.0 == "steady").unwrap();
        assert!(steady.1 && steady.2 == 0, "{st:?}");
        let t = std::time::Instant::now();
        sup.stop().await;
        assert!(t.elapsed() < Duration::from_secs(5), "SIGTERM stops sleep at once");
        assert!(sup.status().iter().all(|c| !c.1));
    });
}

#[test]
fn builtin_tls() {
    let tmp = common::temp_dir("tls");
    let (cert, key) = (tmp.join("cert.pem"), tmp.join("key.pem"));
    let ok = std::process::Command::new("openssl")
        .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        eprintln!("openssl not available: skipped");
        return;
    }
    let s = Server::start("tls", |c| {
        c.tls_cert = Some(cert.clone());
        c.tls_key = Some(key.clone());
    });
    let client = s.rt.block_on(async { reqwest::Client::builder().no_proxy().tls_danger_accept_invalid_certs(true).build().unwrap() });
    let url = format!("https://{}/api/v1/info", s.addr);
    let r = s.send(client.get(url));
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["tls"], true);
    let tok = s.send(client.post(format!("https://{}/api/v1/session", s.addr)).body("{}"));
    assert_eq!(tok.status, 201, "ConnectInfo reaches the handlers over TLS");
}
