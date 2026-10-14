//! ffprobe on the internal loopback URL (never a user URL), parsed into `MediaInfo`.

use std::{path::Path, time::Duration};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Audio,
    Subtitle,
    Attachment,
    Data,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    /// Absolute stream index (`0:<index>` for ffmpeg).
    pub index: usize,
    pub kind: Kind,
    /// Index among the streams of the same kind (`0:s:<track>`).
    pub track: usize,
    pub codec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pix_fmt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub default: bool,
    pub forced: bool,
    /// Cover art carried as a video stream (never played).
    #[serde(skip)]
    pub attached_pic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mimetype: Option<String>,
}

impl StreamInfo {
    /// Text subtitles become sidecars; bitmap ones can only be burned in.
    pub fn is_text_subtitle(&self) -> bool {
        self.kind == Kind::Subtitle && matches!(self.codec.as_str(), "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text" | "microdvd" | "subviewer")
    }

    pub fn is_bitmap_subtitle(&self) -> bool {
        self.kind == Kind::Subtitle && matches!(self.codec.as_str(), "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub" | "dvb_teletext")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// ffprobe `format_name`: `matroska,webm`, `mov,mp4,m4a,3gp,3g2,mj2`, …
    pub container: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_rate: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub streams: Vec<StreamInfo>,
}

impl MediaInfo {
    pub fn is_matroska(&self) -> bool {
        self.container.contains("matroska") || self.container.contains("webm")
    }

    pub fn is_mp4(&self) -> bool {
        self.container.contains("mp4") || self.container.contains("mov")
    }

    pub fn of_kind(&self, k: Kind) -> impl Iterator<Item = &StreamInfo> {
        self.streams.iter().filter(move |s| s.kind == k)
    }

    /// The video stream that plays (cover art excluded).
    pub fn main_video(&self) -> Option<&StreamInfo> {
        self.of_kind(Kind::Video).find(|s| !s.attached_pic)
    }

    pub fn track(&self, k: Kind, track: usize) -> Option<&StreamInfo> {
        self.of_kind(k).find(|s| s.track == track)
    }
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string).filter(|x| !x.is_empty() && x != "unknown")
}

fn num(v: &Value, k: &str) -> Option<f64> {
    match v.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(x) => x.parse().ok(),
        _ => None,
    }
}

fn rate(v: &Value, k: &str) -> Option<f64> {
    let r = v.get(k)?.as_str()?;
    let (a, b) = r.split_once('/')?;
    let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    (b > 0.0 && a > 0.0).then(|| a / b)
}

fn depth_of(pix_fmt: Option<&str>, raw: Option<f64>) -> Option<u32> {
    if let Some(p) = pix_fmt {
        for d in [16u32, 14, 12, 10, 9] {
            if p.contains(&format!("p{d}")) {
                return Some(d);
            }
        }
        if p.starts_with("yuv") || p.starts_with("nv") || p.starts_with("gray") {
            return Some(8);
        }
    }
    raw.map(|r| r as u32).filter(|d| *d > 0)
}

/// Parses `ffprobe -show_format -show_streams -of json`.
pub fn parse(json: &Value) -> Result<MediaInfo> {
    let format = json.get("format").ok_or_else(|| anyhow!("ffprobe: no format"))?;
    let mut counts = std::collections::HashMap::<&'static str, usize>::new();
    let mut streams = Vec::new();
    for st in json.get("streams").and_then(Value::as_array).into_iter().flatten() {
        let kind = match st.get("codec_type").and_then(Value::as_str) {
            Some("video") => Kind::Video,
            Some("audio") => Kind::Audio,
            Some("subtitle") => Kind::Subtitle,
            Some("attachment") => Kind::Attachment,
            _ => Kind::Data,
        };
        let key = match kind {
            Kind::Video => "v",
            Kind::Audio => "a",
            Kind::Subtitle => "s",
            Kind::Attachment => "t",
            Kind::Data => "d",
        };
        let n = counts.entry(key).or_default();
        let track = *n;
        *n += 1;
        let tags = st.get("tags").cloned().unwrap_or(Value::Null);
        let disp = st.get("disposition").cloned().unwrap_or(Value::Null);
        let flag = |k: &str| disp.get(k).and_then(Value::as_i64).unwrap_or(0) == 1;
        let tag = |k: &str| s(&tags, k).or_else(|| s(&tags, &k.to_ascii_uppercase()));
        let pix_fmt = s(st, "pix_fmt");
        streams.push(StreamInfo {
            index: st.get("index").and_then(Value::as_u64).unwrap_or(streams.len() as u64) as usize,
            kind,
            track,
            codec: s(st, "codec_name").unwrap_or_else(|| "unknown".into()),
            profile: s(st, "profile"),
            bit_depth: if kind == Kind::Video { depth_of(pix_fmt.as_deref(), num(st, "bits_per_raw_sample")) } else { None },
            pix_fmt,
            level: st.get("level").and_then(Value::as_i64).filter(|l| *l > 0),
            width: st.get("width").and_then(Value::as_u64).map(|x| x as u32),
            height: st.get("height").and_then(Value::as_u64).map(|x| x as u32),
            frame_rate: rate(st, "avg_frame_rate").or_else(|| rate(st, "r_frame_rate")),
            channels: st.get("channels").and_then(Value::as_u64).map(|x| x as u32),
            language: tag("language"),
            title: tag("title"),
            default: flag("default"),
            forced: flag("forced"),
            attached_pic: flag("attached_pic"),
            filename: tag("filename"),
            mimetype: tag("mimetype"),
        });
    }
    Ok(MediaInfo {
        container: s(format, "format_name").unwrap_or_default(),
        duration: num(format, "duration").filter(|d| d.is_finite() && *d > 0.0).unwrap_or(0.0),
        bit_rate: num(format, "bit_rate").map(|b| b as u64),
        size: num(format, "size").map(|b| b as u64),
        streams,
    })
}

/// Runs ffprobe on `url` (an internal loopback URL). The torrent route waits up to 90 s for the
/// metadata, hence the long timeout.
pub async fn run(ffprobe: &Path, url: &str) -> Result<MediaInfo> {
    debug_assert!(url.starts_with("http://127.0.0.1:"), "ffprobe only reads the internal listener");
    let out = tokio::time::timeout(
        Duration::from_secs(150),
        tokio::process::Command::new(ffprobe)
            .args(["-v", "error", "-hide_banner", "-protocol_whitelist", "http,tcp", "-rw_timeout", "120000000", "-probesize", "10000000", "-analyzeduration", "10000000"])
            .args(["-show_format", "-show_streams", "-of", "json", "-i", url])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("ffprobe timed out"))?
    .with_context(|| format!("running {}", ffprobe.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("ffprobe failed: {}", err.lines().last().unwrap_or("no output").replace(url, "<media>")));
    }
    let v: Value = serde_json::from_slice(&out.stdout).context("ffprobe json")?;
    parse(&v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_fansub_mkv() {
        let v = json!({
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High 10", "pix_fmt": "yuv420p10le", "width": 1920, "height": 1080, "avg_frame_rate": "24000/1001", "level": 51, "disposition": {"default": 1}},
                {"index": 1, "codec_type": "audio", "codec_name": "flac", "channels": 2, "tags": {"language": "jpn"}, "disposition": {"default": 1}},
                {"index": 2, "codec_type": "audio", "codec_name": "ac3", "channels": 6, "tags": {"language": "eng", "title": "5.1"}},
                {"index": 3, "codec_type": "subtitle", "codec_name": "ass", "tags": {"language": "fre"}, "disposition": {"default": 1, "forced": 0}},
                {"index": 4, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"},
                {"index": 5, "codec_type": "attachment", "codec_name": "ttf", "tags": {"filename": "Roboto.ttf", "mimetype": "application/x-truetype-font"}}
            ],
            "format": {"format_name": "matroska,webm", "duration": "1420.5", "bit_rate": "4000000", "size": "710250000"}
        });
        let m = parse(&v).unwrap();
        assert!(m.is_matroska() && !m.is_mp4());
        assert_eq!(m.duration, 1420.5);
        let vid = m.main_video().unwrap();
        assert_eq!((vid.bit_depth, vid.width, vid.level), (Some(10), Some(1920), Some(51)));
        assert!((vid.frame_rate.unwrap() - 23.976).abs() < 0.01);
        assert_eq!(m.track(Kind::Audio, 1).unwrap().channels, Some(6));
        assert!(m.track(Kind::Subtitle, 0).unwrap().is_text_subtitle());
        assert!(m.track(Kind::Subtitle, 1).unwrap().is_bitmap_subtitle());
        assert_eq!(m.track(Kind::Attachment, 0).unwrap().filename.as_deref(), Some("Roboto.ttf"));
    }
}
