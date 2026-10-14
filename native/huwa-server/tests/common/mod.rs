//! Test harness: a server on a random loopback port, an HTTP client, a local librqbit seeder
//! (synthetic data, loopback TCP) and synthetic media made with ffmpeg (`testsrc` / `sine`).
#![allow(dead_code)]

use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use huwa_server::{App, ServerConfig};

#[cfg(feature = "engine")]
pub mod seed;
use serde_json::Value;

pub const MIB: usize = 1024 * 1024;

pub fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
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

pub fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("huwa-server-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub struct Server {
    pub app: App,
    pub base: String,
    pub addr: SocketAddr,
    pub client: reqwest::Client,
    pub rt: tokio::runtime::Runtime,
    pub dir: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.app.shutdown();
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn header(&self, k: &str) -> Option<String> {
        self.headers.get(k).and_then(|v| v.to_str().ok()).map(String::from)
    }
}

impl Server {
    pub fn start(tag: &str, tweak: impl FnOnce(&mut ServerConfig)) -> Server {
        let dir = temp_dir(tag);
        let mut cfg = ServerConfig {
            bind: IpAddr::from([127, 0, 0, 1]),
            port: 0,
            cache_dir: dir.join("cache"),
            data_dir: Some(dir.join("data")),
            web_dir: None,
            worker_threads: 2,
            // Tests never run the Node children unless they ask for them.
            p2p_gateway: false,
            relay: false,
            sessions_per_ip: 0,
            ..Default::default()
        };
        tweak(&mut cfg);
        let addr = SocketAddr::new(cfg.bind, cfg.port);
        let app = App::new(cfg).unwrap();
        let bound = app.spawn(addr).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let client = rt.block_on(async { reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(120)).build().unwrap() });
        Server { app, base: format!("http://{bound}"), addr: bound, client, rt, dir }
    }

    pub fn send(&self, req: reqwest::RequestBuilder) -> Resp {
        self.rt.block_on(async {
            let r = req.send().await.unwrap();
            let status = r.status().as_u16();
            let headers = r.headers().clone();
            let body = r.bytes().await.unwrap().to_vec();
            Resp { status, headers, body }
        })
    }

    pub fn url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{path}", self.base)
        }
    }

    pub fn get(&self, path: &str, range: Option<&str>) -> Resp {
        let mut req = self.client.get(self.url(path));
        if let Some(r) = range {
            req = req.header("range", r);
        }
        self.send(req)
    }

    pub fn session(&self) -> String {
        let r = self.send(self.client.post(format!("{}/api/v1/session", self.base)).body("{}"));
        assert_eq!(r.status, 201, "{}", r.text());
        r.json()["token"].as_str().unwrap().to_string()
    }

    pub fn call(&self, token: &str, method: &str, args: Value) -> Resp {
        let req = self
            .client
            .post(format!("{}/api/v1/engine/{method}", self.base))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(args.to_string());
        self.send(req)
    }

    pub fn post_json(&self, token: &str, path: &str, args: Value) -> Resp {
        let req = self.client.post(self.url(path)).header("authorization", format!("Bearer {token}")).header("content-type", "application/json").body(args.to_string());
        self.send(req)
    }
}

/// The token segment of a media URL (`/s/<token>/…`).
pub fn token_of(url: &str) -> String {
    let path = url.split("/s/").nth(1).unwrap();
    path.split('/').next().unwrap().to_string()
}

pub fn ffmpeg_available() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success()) && Command::new("ffprobe").arg("-version").output().is_ok_and(|o| o.status.success())
}

pub const ASS_TRACK: &str = "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Bonjour {\\i1}Huwa{\\i0}\nDialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,Deuxième ligne\\Nsuite\nDialogue: 0,0:00:25.00,0:00:28.00,Default,,0,0,0,,Fin\n";

/// Synthetic media (no copyrighted content):
/// - `h264_aac`: H.264 8-bit + AAC stereo + an ASS track, MKV with Cues (remux);
/// - `hi10p_ac3`: H.264 High 10 + AC3 5.1, MKV (transcode);
/// - `hevc_ac3`: HEVC + AC3 5.1, MKV (transcode unless the client decodes HEVC).
pub fn make_media(dir: &Path, kind: &str, secs: u32) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let out = dir.join(format!("{kind}.mkv"));
    let ass = dir.join("track.ass");
    std::fs::write(&ass, ASS_TRACK).unwrap();
    let t = secs.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"].map(String::from).to_vec();
    match kind {
        "h264_aac" => {
            args.extend(["-i".to_string(), ass.display().to_string()]);
            args.extend(["-t", &t, "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-c:s", "ass"].map(String::from));
        }
        "hi10p_ac3" => {
            args.extend(["-t", &t, "-map", "0", "-map", "1", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p10le", "-profile:v", "high10", "-c:a", "ac3", "-ac", "6"].map(String::from));
        }
        "hevc_ac3" => {
            args.extend(["-t", &t, "-map", "0", "-map", "1", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "ac3", "-ac", "6"].map(String::from));
        }
        other => panic!("unknown media {other}"),
    }
    args.push(out.display().to_string());
    let st = Command::new("ffmpeg").args(&args).status().unwrap();
    assert!(st.success(), "ffmpeg {kind}");
    out
}
