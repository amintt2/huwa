//! End-to-end tests of huwa-server over real HTTP, offline:
//! - a torrent served by a local librqbit seeder (synthetic data, loopback TCP) streamed with
//!   `Range` → `206` through `/s/<stream token>/t/…`;
//! - the HTTP proxy refusing internal upstreams (`10.0.0.1`, `169.254.169.254`, a rebinding name
//!   at open and at connect time);
//! - session isolation (`list` / `status` / media routes), per-stream tokens, the per-session
//!   stream quota (429, torrents and HTTP proxy streams), per-IP session limits, per-session focus.
#![cfg(feature = "engine")]

mod common;

use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use common::{seed::seed, token_of, Server, MIB};
use huwa_torrent_core::net_policy::Lookup;
use serde_json::json;

#[test]
fn info_sessions_auth_and_cors() {
    let s = Server::start("info", |_| {});
    let info = s.get("/api/v1/info", None);
    assert_eq!(info.status, 200);
    let v = info.json();
    assert_eq!(v["api"], 1);
    assert_eq!(v["features"]["seeding"], false);
    assert_eq!(v["features"]["torrent"], true);
    assert_eq!(v["features"]["transcode"], true);
    assert_eq!(v["features"]["stremioCompat"], false);
    assert_eq!(v["limits"]["streamsPerSession"], 2);
    assert_eq!(v["session"]["identity"], "optional");

    let tok = s.session();
    assert!(tok.starts_with("v1."));
    // Persisted key: a token stays valid for another server instance on the same data dir.
    assert!(s.dir.join("data/token.key").exists());

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
    // noindex by default.
    assert_eq!(info.header("x-robots-tag").as_deref(), Some("noindex, nofollow"));
}

#[test]
fn torrent_range_stream_from_a_local_seeder() {
    let s = Server::start("stream", |_| {});
    let seeder = seed(&s, 8 * MIB);
    let tok = s.session();
    let r = s.call(&tok, "startStream", json!({ "infoHash": seeder.hex }));
    assert_eq!(r.status, 200, "{}", r.text());
    let url = r.json()["url"].as_str().unwrap().to_string();
    // A per-stream token, not the session token.
    let mtok = token_of(&url);
    assert!(mtok.starts_with("m1.") && mtok.contains(&format!(".t-{}.", seeder.hex)), "{url}");
    assert_eq!(url, format!("/s/{mtok}/t/{}/0.mkv", seeder.hex), "session media URL");

    let len = seeder.data.len();
    let head = s.get(&url, Some("bytes=0-65535"));
    assert_eq!(head.status, 206, "{}", head.text());
    assert_eq!(head.header("content-range"), Some(format!("bytes 0-65535/{len}")));
    assert_eq!(head.header("accept-ranges").as_deref(), Some("bytes"));
    assert_eq!(head.header("content-type").as_deref(), Some("video/x-matroska"));
    assert_eq!(head.header("referrer-policy").as_deref(), Some("no-referrer"));
    assert!(head.body == seeder.data[..65536], "head bytes");

    let tail = s.get(&url, Some("bytes=-4096"));
    assert_eq!(tail.status, 206);
    assert!(tail.body == seeder.data[len - 4096..], "tail bytes");
    let mid = s.get(&url, Some(&format!("bytes={}-{}", len / 2, len / 2 + MIB - 1)));
    assert_eq!(mid.status, 206);
    assert!(mid.body == seeder.data[len / 2..len / 2 + MIB], "middle bytes");
    // The session token still works in the path (phase 0 clients).
    assert_eq!(s.get(&format!("/s/{tok}/t/{}/0.mkv", seeder.hex), Some("bytes=0-1")).status, 206);

    // Status through the session, with a media URL; another session sees nothing.
    let st = s.call(&tok, "status", json!({ "id": seeder.hex })).json();
    assert!(st["url"].as_str().unwrap().ends_with(&format!("/t/{}/0.mkv", seeder.hex)));
    assert!(st["peersLive"].as_u64().unwrap() >= 1 || st["state"] == "finished", "{st}");
    let other = s.session();
    assert_eq!(s.get(&url.replace(&mtok, &other), Some("bytes=0-1")).status, 404);
    assert_eq!(s.get(&format!("/s/v1.bad/t/{}/0.mkv", seeder.hex), Some("bytes=0-1")).status, 401);
    // A stream token only opens its own stream.
    let wrong = format!("/s/{mtok}/t/{}/0.mkv", "ab".repeat(20));
    assert_eq!(s.get(&wrong, Some("bytes=0-1")).status, 404);
    seeder.stop(&s);
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

/// A local "upstream" that counts the connections it gets and serves 64 KiB with Range.
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
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf);
                let body = vec![7u8; 2];
                let _ = c.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-1/65536\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n", body.len()).as_bytes());
                let _ = c.write_all(&body);
            });
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
        assert_eq!((r.status, r.json()["code"].as_str()), (403, Some("upstream_blocked")), "{url}: {}", r.text());
    }

    // Rebinding: public when opened, loopback when the fetch connects → refused by the resolver.
    let r = s.call(&tok, "httpOpen", json!({ "url": format!("http://rebind.test:{port}/video.mkv") }));
    assert_eq!(r.status, 200, "{}", r.text());
    let v = r.json();
    let id = v["id"].as_u64().unwrap();
    let media = v["url"].as_str().unwrap().to_string();
    let mtok = token_of(&media);
    assert!(mtok.starts_with("m1.") && mtok.contains(&format!(".h-{id}.")));
    assert_eq!(media, format!("/s/{mtok}/http/{id}.mkv"));
    let got = s.get(&media, Some("bytes=0-"));
    assert_eq!(got.status, 403, "{}", got.text());
    let st = s.call(&tok, "httpStatus", json!({ "id": id })).json();
    assert_eq!(st["error"]["status"], 403, "{st}");
    assert_eq!(hits.load(Ordering::SeqCst), 0, "the internal upstream was never contacted");
    assert!(dns.rebind_calls.load(Ordering::SeqCst) >= 2);

    // Another session cannot use or inspect that proxy session.
    let other = s.session();
    assert_eq!(s.call(&other, "httpStatus", json!({ "id": id })).status, 404);
    assert_eq!(s.get(&media.replace(&mtok, &other), Some("bytes=0-1")).status, 404);
}

#[test]
fn http_proxy_streams_count_against_the_stream_quota() {
    let s = Server::start("proxyquota", |c| {
        c.allow_loopback_upstreams = true;
        c.proxy_sessions_per_session = 3;
    });
    let tok = s.session();
    let (port, _) = counting_upstream();
    let mut urls = Vec::new();
    for i in 0..3 {
        let r = s.call(&tok, "httpOpen", json!({ "url": format!("http://127.0.0.1:{port}/v{i}.mkv") }));
        assert_eq!(r.status, 200, "{}", r.text());
        urls.push(r.json()["url"].as_str().unwrap().to_string());
    }
    // A fourth proxy session is over the per-session proxy cap.
    let r = s.call(&tok, "httpOpen", json!({ "url": format!("http://127.0.0.1:{port}/v9.mkv") }));
    assert_eq!((r.status, r.json()["kind"].as_str()), (429, Some("proxy")));
    // Two streams play; the third is refused by the stream quota (2 per session).
    assert_eq!(s.get(&urls[0], Some("bytes=0-1")).status, 206);
    assert_eq!(s.get(&urls[1], Some("bytes=0-1")).status, 206);
    let r = s.get(&urls[2], Some("bytes=0-1"));
    assert_eq!((r.status, r.json()["code"].as_str()), (429, Some("quota_exceeded")));
    // Releasing one frees its slot.
    let id0 = urls[0].rsplit('/').next().unwrap().split('.').next().unwrap().parse::<u64>().unwrap();
    assert_eq!(s.call(&tok, "httpRelease", json!({ "id": id0 })).status, 200);
    assert_eq!(s.get(&urls[2], Some("bytes=0-1")).status, 206);
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
    // Per-session focus: b's start did not take a's torrent out of focus.
    assert!(s.app.engine().is_focused(&ha) && s.app.engine().is_focused(&hb), "both sessions keep their focus");

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

#[test]
fn session_creation_limits_and_proofs() {
    let s = Server::start("limits", |c| {
        c.sessions_per_ip = 2;
        c.trust_proxy = true;
    });
    let post = |xff: Option<&str>, body: &str| {
        let mut r = s.client.post(format!("{}/api/v1/session", s.base)).body(body.to_string());
        if let Some(x) = xff {
            r = r.header("x-forwarded-for", x);
        }
        s.send(r)
    };
    assert_eq!(post(Some("203.0.113.1"), "{}").status, 201);
    assert_eq!(post(Some("203.0.113.1"), "{}").status, 201);
    let r = post(Some("198.51.100.7, 203.0.113.1"), "{}");
    assert_eq!((r.status, r.json()["code"].as_str()), (429, Some("too_many_sessions")), "right-most forwarded address");
    assert_eq!(post(Some("203.0.113.2"), "{}").status, 201, "another address");
    // A bad proof is refused; a good one binds the session to the key.
    let r = post(None, r#"{"publicKey":"00","ts":1,"sig":"00"}"#);
    assert_eq!((r.status, r.json()["code"].as_str()), (400, Some("invalid_proof")));

    let required = Server::start("identity", |c| c.require_identity = true);
    let r = required.send(required.client.post(format!("{}/api/v1/session", required.base)).body("{}"));
    assert_eq!((r.status, r.json()["code"].as_str()), (401, Some("identity_required")));
    use ring::signature::KeyPair;
    let rng = ring::rand::SystemRandom::new();
    let kp = ring::signature::Ed25519KeyPair::from_pkcs8(ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap().as_ref()).unwrap();
    let pk = hex::encode(kp.public_key().as_ref());
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let sig = hex::encode(kp.sign(format!("huwa/session/v1|{ts}|{pk}").as_bytes()).as_ref());
    let body = json!({ "publicKey": pk, "ts": ts, "sig": sig }).to_string();
    let r1 = required.send(required.client.post(format!("{}/api/v1/session", required.base)).body(body.clone()));
    assert_eq!(r1.status, 201, "{}", r1.text());
    assert_eq!(r1.json()["identity"], pk.as_str());
    let r2 = required.send(required.client.post(format!("{}/api/v1/session", required.base)).body(body));
    assert_eq!(r1.json()["sessionId"], r2.json()["sessionId"], "same key, same session");
}
