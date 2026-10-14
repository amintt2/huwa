//! Stremio-compatible surface (`HUWA_STREMIO_COMPAT=1`), driven like stremio-core /
//! stremio-video drive a streaming server: settings, create (both body shapes, `guessedFileIdx`),
//! stream with Range, stats, `/hlsv2/probe` + master playlist, `/subtitles.vtt`.
#![cfg(feature = "engine")]

mod common;

use common::{ffmpeg_available, make_media, seed::seed_file, Server};
use huwa_server::config::HwAccel;
use serde_json::{json, Value};

#[test]
fn compat_is_off_by_default() {
    let s = Server::start("compat-off", |_| {});
    let h = "ab".repeat(20);
    assert_eq!(s.get("/settings", None).status, 404);
    assert_eq!(s.get(&format!("/{h}/0"), None).status, 404);
    assert_eq!(s.get("/hlsv2/probe?mediaURL=x", None).status, 404);
    assert_eq!(s.get("/api/v1/info", None).json()["features"]["stremioCompat"], false);
}

#[test]
fn stremio_client_flow() {
    let s = Server::start("compat", |c| {
        c.stremio_compat = true;
        c.hwaccel = HwAccel::None;
        c.compat_streams = 2;
    });
    assert_eq!(s.get("/api/v1/info", None).json()["features"]["stremioCompat"], true);
    // Settings: JSON for clients, the web app for a browser navigation.
    let st = s.send(s.client.get(s.url("/settings")).header("accept", "application/json"));
    assert_eq!(st.status, 200);
    let v = st.json();
    assert_eq!(v["baseUrl"], format!("{}/", s.base));
    assert!(v["values"]["serverVersion"].is_string() && v["options"].is_array());
    let posted = s.send(s.client.post(s.url("/settings")).header("content-type", "application/json").body(r#"{"cacheSize":null}"#));
    assert_eq!(posted.json(), json!({ "success": true }));
    assert_eq!(s.get("/network-info", None).json(), json!({ "availableInterfaces": [] }));
    assert!(s.get("/device-info", None).json()["availableHardwareAccelerations"].is_array());
    assert_eq!(s.get("/casting", None).json(), json!([]));

    // A season pack: the torrent's two files; `guessFileIdx {episode}` picks by name.
    let dir = s.dir.join("pack");
    std::fs::create_dir_all(dir.join("Show")).unwrap();
    std::fs::write(dir.join("Show/Show - 01.mkv"), common::pseudo_random(3 * common::MIB, 1)).unwrap();
    std::fs::write(dir.join("Show/Show - 02.mkv"), common::pseudo_random(3 * common::MIB, 2)).unwrap();
    let seeder = seed_file(&s, &dir.join("Show"));
    let h = seeder.hex.clone();

    // Body shape 1: {torrent: {infoHash}, peerSearch, guessFileIdx}.
    let body = json!({ "torrent": { "infoHash": h }, "peerSearch": { "sources": [format!("dht:{h}")], "min": 40, "max": 150 }, "guessFileIdx": { "season": 1, "episode": 2 } });
    let r = s.send(s.client.post(s.url(&format!("/{h}/create"))).header("content-type", "application/json").body(body.to_string()));
    assert_eq!(r.status, 200, "{}", r.text());
    let c = r.json();
    assert_eq!(c["infoHash"], h.as_str());
    assert_eq!(c["files"].as_array().unwrap().len(), 2);
    let ep2 = c["files"].as_array().unwrap().iter().position(|f| f["name"] == "Show - 02.mkv").unwrap();
    assert_eq!(c["guessedFileIdx"], ep2, "{c}");
    // Body shape 2: {blob: hex .torrent} at /create.
    let r = s.send(s.client.post(s.url("/create")).header("content-type", "application/json").body(json!({ "blob": hex::encode(&seeder.torrent) }).to_string()));
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["infoHash"], h.as_str());

    // Stream: Range / 206, as stremio-video plays `/{infoHash}/{fileIdx}`.
    let r = s.get(&format!("/{h}/{ep2}"), Some("bytes=0-1023"));
    assert_eq!(r.status, 206, "{}", r.text());
    assert_eq!(r.body.len(), 1024);
    assert_eq!(r.header("content-range"), Some(format!("bytes 0-1023/{}", 3 * common::MIB)));
    let stats: Value = s.get(&format!("/{h}/{ep2}/stats.json"), None).json();
    assert_eq!(stats["infoHash"], h.as_str());
    assert_eq!(stats["streamLen"], 3 * common::MIB);
    assert!(stats["files"].is_array() && stats["peers"].is_number(), "{stats}");
    assert_eq!(s.get(&format!("/{h}/stats.json"), None).json()["infoHash"], h.as_str());
    assert!(s.get("/stats.json", None).json().get(&h).is_some());
    // Unknown torrent stats: null. Non-hash two-segment paths stay the web app (404 without one).
    assert_eq!(s.get(&format!("/{}/stats.json", "cd".repeat(20)), None).json(), Value::Null);
    assert_eq!(s.get("/assets/x.png", None).status, 404);
    seeder.stop(&s);
}

#[test]
fn stremio_hls_probe_and_master() {
    if !ffmpeg_available() {
        eprintln!("ffmpeg / ffprobe not found: skipped");
        return;
    }
    let s = Server::start("compat-hls", |c| {
        c.stremio_compat = true;
        c.hwaccel = HwAccel::None;
    });
    let seeder = seed_file(&s, &make_media(&s.dir.join("media"), "h264_aac", 20));
    let h = seeder.hex.clone();
    let media_url = format!("{}/{h}/0", s.base);
    let enc = |u: &str| url::form_urlencoded::byte_serialize(u.as_bytes()).collect::<String>();
    let p = s.get(&format!("/hlsv2/probe?mediaURL={}", enc(&media_url)), None);
    assert_eq!(p.status, 200, "{}", p.text());
    let v = p.json();
    assert!(v["format"]["name"].as_str().unwrap().contains("matroska"));
    let tracks: Vec<&str> = v["streams"].as_array().unwrap().iter().map(|x| x["track"].as_str().unwrap()).collect();
    assert_eq!(tracks, vec!["video", "audio", "subtitle"]);
    let m = s.get(&format!("/hlsv2/abc123/master.m3u8?mediaURL={}&videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2", enc(&media_url)), None);
    assert_eq!(m.status, 200, "{}", m.text());
    let variant = m.text().lines().find(|l| l.ends_with("index.m3u8")).unwrap().to_string();
    let pl = s.get(&format!("/hlsv2/abc123/{variant}"), None);
    assert_eq!(pl.status, 200);
    let vb = variant.trim_end_matches("/index.m3u8");
    assert_eq!(s.get(&format!("/hlsv2/abc123/{vb}/init.mp4"), None).status, 200);
    let seg = s.get(&format!("/hlsv2/abc123/{vb}/0.m4s"), None);
    assert_eq!(seg.status, 200, "{}", seg.text());
    assert!(huwa_server::media::hls::first_tfdt(&seg.body).is_some());
    // A remote mediaURL goes through the proxy's upstream policy: internal hosts refused.
    let r = s.get(&format!("/hlsv2/probe?mediaURL={}", enc("http://169.254.169.254/latest/video.mkv")), None);
    assert_eq!((r.status, r.json()["code"].as_str()), (403, Some("upstream_blocked")));
    let r = s.get(&format!("/subtitles.vtt?from={}", enc("http://10.0.0.1/a.srt")), None);
    assert_eq!(r.status, 403);
    seeder.stop(&s);
}
