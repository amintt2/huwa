//! Media module end to end (needs `ffmpeg` and `ffprobe` on the PATH; skipped otherwise):
//! synthetic MKVs seeded by a local librqbit seeder, probed, remuxed / transcoded to fMP4 HLS,
//! seek to 80 %, ASS sidecar, transcode quota.
#![cfg(feature = "engine")]

mod common;

use std::time::{Duration, Instant};

use common::{ffmpeg_available, make_media, seed::seed_file, token_of, Server};
use huwa_server::{
    config::HwAccel,
    media::hls::{first_tfdt, init_timescale},
};
use serde_json::{json, Value};

fn segments(playlist: &str) -> Vec<f64> {
    let mut t = 0.0;
    let mut starts = Vec::new();
    for l in playlist.lines() {
        if let Some(d) = l.strip_prefix("#EXTINF:") {
            starts.push(t);
            t += d.trim_end_matches(',').parse::<f64>().unwrap();
        }
    }
    starts
}

struct Hls {
    master: String,
    variant_base: String,
    playlist: String,
    timescale: u32,
}

fn open_hls(s: &Server, hls_url: &str, caps: &str) -> Hls {
    let m = s.get(&format!("{hls_url}?{caps}"), None);
    assert_eq!(m.status, 200, "master: {}", m.text());
    assert_eq!(m.header("content-type").as_deref(), Some("application/vnd.apple.mpegurl"));
    assert_eq!(m.header("referrer-policy").as_deref(), Some("no-referrer"));
    let master = m.text();
    let variant = master.lines().find(|l| l.ends_with("index.m3u8")).unwrap().to_string();
    let variant_base = format!("{}/{}", hls_url.rsplit_once('/').unwrap().0, variant.trim_end_matches("index.m3u8").trim_end_matches('/'));
    let p = s.get(&format!("{variant_base}/index.m3u8"), None);
    assert_eq!(p.status, 200);
    let playlist = p.text();
    assert!(playlist.contains("#EXT-X-PLAYLIST-TYPE:VOD") && playlist.ends_with("#EXT-X-ENDLIST\n"));
    let init = s.get(&format!("{variant_base}/init.mp4"), None);
    assert_eq!(init.status, 200, "init: {}", init.text());
    let timescale = init_timescale(&init.body).expect("init has a video timescale");
    Hls { master, variant_base, playlist, timescale }
}

/// Fetches segment `k`; returns (seconds taken, first video time).
fn segment(s: &Server, h: &Hls, k: usize) -> (f64, f64) {
    let t0 = Instant::now();
    let r = s.get(&format!("{}/{k}.m4s", h.variant_base), None);
    assert_eq!(r.status, 200, "segment {k}: {}", r.text());
    assert_eq!(r.header("content-type").as_deref(), Some("video/mp4"));
    let tfdt = first_tfdt(&r.body).expect("segment starts with a moof");
    (t0.elapsed().as_secs_f64(), tfdt as f64 / h.timescale as f64)
}

fn probe(s: &Server, tok: &str, url: &str, caps: &str) -> Value {
    let r = s.post_json(tok, &format!("/api/v1/media/probe?{caps}"), json!({ "url": url }));
    assert_eq!(r.status, 200, "probe: {}", r.text());
    r.json()
}

#[test]
fn remux_h264_aac_seek_and_ass_sidecar() {
    if !ffmpeg_available() {
        eprintln!("ffmpeg / ffprobe not found: skipped");
        return;
    }
    let s = Server::start("remux", |c| c.hwaccel = HwAccel::None);
    let file = make_media(&s.dir.join("media"), "h264_aac", 40);
    let seeder = seed_file(&s, &file);
    let tok = s.session();
    let r = s.call(&tok, "startStream", json!({ "infoHash": seeder.hex }));
    assert_eq!(r.status, 200);
    let url = r.json()["url"].as_str().unwrap().to_string();

    let caps = "videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2";
    let p = probe(&s, &tok, &url, caps);
    assert_eq!(p["decision"]["mode"], "remux", "{p}");
    assert_eq!(p["decision"]["reasons"], json!(["container:matroska"]));
    assert_eq!(p["keyframeIndex"], "cues");
    assert!((p["duration"].as_f64().unwrap() - 40.0).abs() < 1.0);
    assert_eq!(p["subtitles"][0]["codec"], "ass");
    assert_eq!(p["subtitles"][0]["text"], true);
    let hls = p["hls"].as_str().unwrap().to_string();
    let mtok = token_of(&hls);
    assert!(mtok.starts_with("m1.") && mtok.contains(&format!(".m-{}.", p["id"].as_str().unwrap())));

    let h = open_hls(&s, &hls, caps);
    assert!(h.master.contains("CODECS=\"avc1.") && h.master.contains("mp4a.40.2") && h.master.contains("RESOLUTION=640x360"), "{}", h.master);
    let starts = segments(&h.playlist);
    // Keyframes every 2 s (-g 48 at 24 fps) grouped into >= 4 s segments.
    assert!(starts.len() >= 8 && starts.windows(2).all(|w| w[1] - w[0] >= 3.99), "{starts:?}");
    let (_, t0) = segment(&s, &h, 0);
    assert!(t0.abs() < 0.1, "segment 0 starts at {t0}");
    let (_, t1) = segment(&s, &h, 1);
    assert!((t1 - starts[1]).abs() < 0.05, "segment 1 at {t1}, playlist {}", starts[1]);
    // Seek to 80 %: ffmpeg restarts there, the segment carries its source time.
    let k = starts.len() * 8 / 10;
    let (secs, t) = segment(&s, &h, k);
    assert!(secs < 5.0, "seek to 80 % took {secs:.2} s");
    assert!((t - starts[k]).abs() < 0.05, "segment {k} at {t}, playlist {}", starts[k]);
    let (_, t) = segment(&s, &h, k + 1);
    assert!((t - starts[k + 1]).abs() < 0.05);
    // Going back works too (earlier run's files or a new run).
    let (_, t2) = segment(&s, &h, 2);
    assert!((t2 - starts[2]).abs() < 0.05);

    // ASS sidecar, progressively extracted.
    let vtt_url = p["subtitles"][0]["url"].as_str().unwrap().to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    let vtt = loop {
        let r = s.get(&format!("{vtt_url}?since=0"), None);
        assert_eq!(r.status, 200, "{}", r.text());
        let t = r.text();
        if t.contains("Fin") || Instant::now() > deadline {
            break t;
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    assert!(vtt.starts_with("WEBVTT"), "{vtt}");
    assert!(vtt.contains("00:00:01.000 --> 00:00:03.000\nBonjour Huwa"), "{vtt}");
    assert!(vtt.contains("Deuxième ligne\nsuite"), "{vtt}");
    let late = s.get(&format!("{vtt_url}?since=20"), None).text();
    assert!(!late.contains("Bonjour") && late.contains("Fin"), "{late}");
    let ass = s.get(p["subtitles"][0]["assUrl"].as_str().unwrap(), None);
    assert!(ass.text().contains("[Script Info]") && ass.text().contains("Dialogue: 0,0:00:01.00,0:00:03.00,Default"), "{}", ass.text());
    let fonts = s.get(p["fonts"].as_str().unwrap(), None);
    assert_eq!(fonts.json()["fonts"], json!([]));

    // Another session cannot use this media, a forged token neither.
    let other = s.session();
    assert_eq!(s.get(&hls.replace(&mtok, &other), None).status, 404);
    assert_eq!(s.get(&hls.replace(&mtok, "m1.x"), None).status, 401);
    let m = s.get("/metrics", None).text();
    assert!(m.contains("huwa_hls_segments_served_total") && m.contains("huwa_hls_restarts_total"), "{m}");
    seeder.stop(&s);
}

#[test]
fn transcode_hi10p_ac3_seek_and_quota() {
    if !ffmpeg_available() {
        eprintln!("ffmpeg / ffprobe not found: skipped");
        return;
    }
    let s = Server::start("transcode", |c| c.hwaccel = HwAccel::None);
    let media = s.dir.join("media");
    // Long enough for ffmpeg to still be running when the quota is checked.
    let hi10 = seed_file(&s, &make_media(&media, "hi10p_ac3", 240));
    let tok = s.session();
    let url = s.call(&tok, "startStream", json!({ "infoHash": hi10.hex })).json()["url"].as_str().unwrap().to_string();
    let caps = "videoCodecs=h264&audioCodecs=aac";
    let p = probe(&s, &tok, &url, caps);
    assert_eq!(p["decision"]["mode"], "transcode", "{p}");
    assert!(p["decision"]["reasons"].as_array().unwrap().contains(&json!("video:h264-10bit")));
    assert!(p["decision"]["reasons"].as_array().unwrap().contains(&json!("audio:ac3")));
    assert_eq!(p["video"][0]["bitDepth"], 10);
    let h = open_hls(&s, p["hls"].as_str().unwrap(), caps);
    assert!(h.master.contains("avc1.64002a"), "{}", h.master);
    let starts = segments(&h.playlist);
    assert_eq!(starts.len(), 60, "4 s grid");
    let (_, t0) = segment(&s, &h, 0);
    assert!(t0.abs() < 0.1);

    // A second transcode for the same session while the first runs: 429 (1 per session).
    let hevc = seed_file(&s, &make_media(&media, "hevc_ac3", 12));
    let url2 = {
        let r = s.call(&tok, "startStream", json!({ "infoHash": hevc.hex }));
        assert_eq!(r.status, 200, "{}", r.text());
        r.json()["url"].as_str().unwrap().to_string()
    };
    let p2 = probe(&s, &tok, &url2, caps);
    assert_eq!(p2["decision"]["mode"], "transcode");
    assert!(p2["decision"]["reasons"].as_array().unwrap().contains(&json!("video:hevc")));
    let r = s.get(&format!("{}?{caps}", p2["hls"].as_str().unwrap()), None);
    assert_eq!((r.status, r.json()["code"].as_str(), r.json()["kind"].as_str()), (429, Some("quota_exceeded"), Some("transcode_session")), "{}", r.text());
    // A browser that decodes HEVC gets a remux instead (no transcode needed).
    let p3 = probe(&s, &tok, &url2, "videoCodecs=h264,hevc&audioCodecs=aac");
    assert_eq!(p3["decision"]["mode"], "remux");

    // Seek to 80 % of the first one: ffmpeg restarts at the segment, on the 4 s grid.
    let k = 48;
    let (secs, t) = segment(&s, &h, k);
    assert!(secs < 5.0, "seek to 80 % took {secs:.2} s");
    assert!((t - 192.0).abs() < 0.1, "segment {k} at {t}");
    assert_eq!(segment(&s, &h, k + 1).1.round(), 196.0);
    hi10.stop(&s);
    hevc.stop(&s);
}
