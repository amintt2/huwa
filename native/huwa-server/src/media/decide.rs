//! Direct / remux / transcode decision (D13), from ffprobe and the client's capabilities.
//!
//! Capabilities come as query parameters, Stremio-style (repeated or comma-separated):
//! `videoCodecs=h264&videoCodecs=hevc&audioCodecs=aac&audioCodecs=opus&maxAudioChannels=2`, plus
//! Huwa's `containers=mp4,webm`, `audioTrack=<n>`, `burnSubtitle=<n>`, `forceTranscoding=1`,
//! `start=<seconds>` (resume position: the first ffmpeg run starts there).
//!
//! - **direct**: the browser can play the file as it is: supported container, video and audio
//!   codecs, at most one audio track (a browser cannot switch tracks of a plain file), nothing
//!   to burn. Text subtitles are sidecars and never prevent it.
//! - **remux**: the video is copied into fMP4 HLS; the audio is copied when the browser plays it,
//!   else converted to AAC (AC3, E-AC3, DTS, TrueHD, FLAC, …, or too many channels). Needs the
//!   keyframe index (MKV Cues) for the segment boundaries; without it: transcode.
//! - **transcode**: H.264 8-bit + AAC. For HEVC / AV1 / VP9 the browser does not decode, for
//!   H.264 Hi10P (fansubs: no browser decodes it in hardware, most not at all), and for a bitmap
//!   subtitle (PGS, VobSub) to burn in.

use serde::Serialize;

use super::probe::{Kind, MediaInfo};

#[derive(Debug, Clone, PartialEq)]
pub struct ClientCaps {
    pub video: Vec<String>,
    pub audio: Vec<String>,
    pub max_channels: u32,
    pub containers: Vec<String>,
    pub audio_track: Option<usize>,
    pub burn_subtitle: Option<usize>,
    pub force_transcode: bool,
    pub start: Option<f64>,
}

impl Default for ClientCaps {
    fn default() -> Self {
        Self {
            video: vec!["h264".into()],
            audio: vec!["aac".into(), "mp3".into()],
            max_channels: 2,
            containers: vec!["mp4".into(), "webm".into()],
            audio_track: None,
            burn_subtitle: None,
            force_transcode: false,
            start: None,
        }
    }
}

pub fn norm_video(c: &str) -> String {
    let c = c.trim().to_ascii_lowercase();
    let base = c.split('.').next().unwrap_or(&c).to_string();
    match base.as_str() {
        "avc" | "avc1" | "avc3" | "x264" => "h264".into(),
        "h265" | "hev1" | "hvc1" | "x265" => "hevc".into(),
        "av01" => "av1".into(),
        "vp09" => "vp9".into(),
        "h264hi10" | "h264-10bit" | "hi10p" => "h264hi10".into(),
        _ => base,
    }
}

pub fn norm_audio(c: &str) -> String {
    let c = c.trim().to_ascii_lowercase();
    let base = c.split('.').next().unwrap_or(&c).to_string();
    match base.as_str() {
        "mp4a" | "aac_latm" => "aac".into(),
        "ac-3" => "ac3".into(),
        "ec-3" | "e-ac3" | "e-ac-3" => "eac3".into(),
        "mp3float" | "mpeg" => "mp3".into(),
        "dca" => "dts".into(),
        _ => base,
    }
}

impl ClientCaps {
    /// From query pairs (keys repeated and / or values comma-separated). Unknown keys are ignored.
    pub fn from_query(pairs: &[(String, String)]) -> Self {
        let mut c = ClientCaps::default();
        let list = |k: &str| -> Option<Vec<String>> {
            let v: Vec<String> = pairs.iter().filter(|(key, _)| key == k || key == &format!("{k}[]")).flat_map(|(_, v)| v.split(',').map(str::to_string).collect::<Vec<_>>()).filter(|s| !s.trim().is_empty()).collect();
            (!v.is_empty()).then_some(v)
        };
        let one = |k: &str| pairs.iter().rev().find(|(key, _)| key == k).map(|(_, v)| v.trim().to_string());
        if let Some(v) = list("videoCodecs") {
            c.video = v.iter().map(|s| norm_video(s)).collect();
        }
        if let Some(v) = list("audioCodecs") {
            c.audio = v.iter().map(|s| norm_audio(s)).collect();
        }
        if let Some(v) = list("containers") {
            c.containers = v.iter().map(|s| s.trim().to_ascii_lowercase()).collect();
        }
        if let Some(n) = one("maxAudioChannels").and_then(|v| v.parse::<u32>().ok()) {
            c.max_channels = n.clamp(1, 8);
        }
        c.audio_track = one("audioTrack").and_then(|v| v.parse().ok());
        c.burn_subtitle = one("burnSubtitle").and_then(|v| v.parse().ok());
        c.force_transcode = one("forceTranscoding").is_some_and(|v| v == "1" || v == "true");
        c.start = one("start").and_then(|v| v.parse::<f64>().ok()).filter(|s| s.is_finite() && *s > 0.0);
        c
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Direct,
    Remux,
    Transcode,
}

/// What an HLS variant runs. Serialized in `/api/v1/media/probe` as `decision`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub mode: Mode,
    /// Absolute stream index of the video (`None`: audio only).
    pub video: Option<usize>,
    /// Source video codec (normalized: `h264`, `hevc`, …).
    pub video_codec: Option<String>,
    /// Absolute stream index of the audio.
    pub audio: Option<usize>,
    pub video_copy: bool,
    pub audio_copy: bool,
    /// Output audio channels when converting.
    pub audio_channels: u32,
    /// Absolute stream index of a bitmap subtitle to burn in.
    pub burn: Option<usize>,
    /// Output video height cap (transcode).
    pub max_height: u32,
    pub reasons: Vec<String>,
}

impl Plan {
    /// Stable key of the HLS variant: same plan, same files.
    pub fn key(&self) -> String {
        let m = match self.mode {
            Mode::Direct => "d",
            Mode::Remux => "r",
            Mode::Transcode => "t",
        };
        let o = |x: Option<usize>| x.map_or("x".to_string(), |v| v.to_string());
        format!("{m}{}a{}{}c{}b{}", o(self.video), o(self.audio), if self.audio_copy { "k" } else { "e" }, self.audio_channels, o(self.burn))
    }
}

/// Converted to AAC even when the client claims them: MSE support of these in fMP4 is patchy.
const ALWAYS_CONVERT: &[&str] = &["ac3", "dts", "truehd", "mlp", "flac", "pcm_s16le", "pcm_s24le", "pcm_bluray"];

/// The H.264 profiles no browser decodes (10-bit and 4:2:2 / 4:4:4).
fn h264_high_bit(profile: Option<&str>, depth: Option<u32>) -> bool {
    depth.is_some_and(|d| d > 8) || profile.is_some_and(|p| p.contains("10") || p.contains("4:2:2") || p.contains("4:4:4"))
}

/// `has_index`: a keyframe index is available for copy-mode segments (MKV Cues).
pub fn decide(info: &MediaInfo, caps: &ClientCaps, has_index: bool) -> Plan {
    let mut reasons = Vec::new();
    let video = info.main_video();
    let audios: Vec<_> = info.of_kind(Kind::Audio).collect();
    let audio = caps
        .audio_track
        .and_then(|t| audios.iter().find(|a| a.track == t))
        .or_else(|| audios.iter().find(|a| a.default))
        .or_else(|| audios.first())
        .copied();
    let burn = caps.burn_subtitle.and_then(|t| info.track(Kind::Subtitle, t)).filter(|s| s.is_bitmap_subtitle());

    let video_ok = match video {
        None => true,
        Some(v) => {
            let codec = norm_video(&v.codec);
            if codec == "h264" && h264_high_bit(v.profile.as_deref(), v.bit_depth) {
                if caps.video.iter().any(|c| c == "h264hi10") {
                    true
                } else {
                    reasons.push("video:h264-10bit".into());
                    false
                }
            } else if caps.video.contains(&codec) {
                true
            } else {
                reasons.push(format!("video:{codec}"));
                false
            }
        }
    };
    let audio_codec_ok = audio.is_none_or(|a| {
        let c = norm_audio(&a.codec);
        caps.audio.contains(&c) && !ALWAYS_CONVERT.contains(&c.as_str())
    });
    let channels_ok = audio.is_none_or(|a| a.channels.unwrap_or(2) <= caps.max_channels);
    if let Some(a) = audio {
        if !audio_codec_ok {
            reasons.push(format!("audio:{}", norm_audio(&a.codec)));
        } else if !channels_ok {
            reasons.push("audio:channels".into());
        }
    }
    let audio_ok = audio_codec_ok && channels_ok;
    let container_ok = if info.is_mp4() {
        caps.containers.iter().any(|c| c == "mp4" || c == "mov")
    } else if info.is_matroska() {
        let webm_codecs = video.is_none_or(|v| matches!(norm_video(&v.codec).as_str(), "vp8" | "vp9" | "av1")) && audio.is_none_or(|a| matches!(a.codec.as_str(), "opus" | "vorbis"));
        caps.containers.iter().any(|c| c == "mkv" || c == "matroska") || (webm_codecs && caps.containers.iter().any(|c| c == "webm"))
    } else {
        caps.containers.iter().any(|c| info.container.split(',').any(|f| f == c))
    };
    if !container_ok {
        reasons.push(format!("container:{}", info.container.split(',').next().unwrap_or("?")));
    }
    if audios.len() > 1 {
        reasons.push("audioTracks".into());
    }
    if burn.is_some() {
        reasons.push("subtitle:burn".into());
    }
    if caps.force_transcode {
        reasons.push("forced".into());
    }
    let channels = audio.map_or(2, |a| a.channels.unwrap_or(2).min(caps.max_channels).min(6));
    let base = Plan {
        mode: Mode::Direct,
        video: video.map(|v| v.index),
        video_codec: video.map(|v| norm_video(&v.codec)),
        audio: audio.map(|a| a.index),
        video_copy: true,
        audio_copy: audio_ok,
        audio_channels: channels,
        burn: burn.map(|b| b.index),
        max_height: 1080,
        reasons,
    };
    if !caps.force_transcode && video_ok && audio_ok && container_ok && audios.len() <= 1 && burn.is_none() {
        return base;
    }
    if !caps.force_transcode && video_ok && burn.is_none() && video.is_some() {
        if has_index {
            return Plan { mode: Mode::Remux, ..base };
        }
        let mut p = base;
        p.reasons.push("noKeyframeIndex".into());
        return Plan { mode: Mode::Transcode, video_copy: false, ..p };
    }
    Plan { mode: Mode::Transcode, video_copy: false, ..base }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::probe::parse;
    use serde_json::json;

    fn info(vcodec: &str, profile: &str, pix: &str, acodec: &str, ch: u32, fmt: &str) -> MediaInfo {
        parse(&json!({
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": vcodec, "profile": profile, "pix_fmt": pix},
                {"index": 1, "codec_type": "audio", "codec_name": acodec, "channels": ch},
                {"index": 2, "codec_type": "subtitle", "codec_name": "ass"},
                {"index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"}
            ],
            "format": {"format_name": fmt, "duration": "60"}
        }))
        .unwrap()
    }

    fn q(s: &str) -> ClientCaps {
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(s.as_bytes()).into_owned().collect();
        ClientCaps::from_query(&pairs)
    }

    #[test]
    fn caps_parsing() {
        let c = q("videoCodecs=h264&videoCodecs=H265,vp9&audioCodecs=mp4a.40.2&audioCodecs=opus&maxAudioChannels=6&audioTrack=1&forceTranscoding=1&start=812.5");
        assert_eq!(c.video, vec!["h264", "hevc", "vp9"]);
        assert_eq!(c.audio, vec!["aac", "opus"]);
        assert_eq!((c.max_channels, c.audio_track, c.force_transcode, c.start), (6, Some(1), true, Some(812.5)));
        assert_eq!(q(""), ClientCaps::default());
    }

    #[test]
    fn decisions() {
        let caps = q("videoCodecs=h264&audioCodecs=aac");
        // H.264 / AAC in MKV: remux (container), direct in MP4.
        let mkv = info("h264", "High", "yuv420p", "aac", 2, "matroska,webm");
        let p = decide(&mkv, &caps, true);
        assert_eq!(p.mode, Mode::Remux);
        assert!(p.video_copy && p.audio_copy);
        assert_eq!(p.reasons, vec!["container:matroska"]);
        let mp4 = info("h264", "High", "yuv420p", "aac", 2, "mov,mp4,m4a,3gp,3g2,mj2");
        assert_eq!(decide(&mp4, &caps, false).mode, Mode::Direct);
        // AC3 5.1 → AAC 2.0.
        let ac3 = info("h264", "Main", "yuv420p", "ac3", 6, "matroska,webm");
        let p = decide(&ac3, &caps, true);
        assert_eq!((p.mode, p.audio_copy, p.audio_channels), (Mode::Remux, false, 2));
        assert!(p.reasons.contains(&"audio:ac3".to_string()));
        // FLAC is converted even if a browser claims it (MSE in fMP4 is patchy).
        assert!(!decide(&info("h264", "High", "yuv420p", "flac", 2, "matroska,webm"), &q("audioCodecs=aac,flac"), true).audio_copy);
        // Hi10P: transcode, even when the browser says h264.
        let hi10 = info("h264", "High 10", "yuv420p10le", "aac", 2, "matroska,webm");
        let p = decide(&hi10, &caps, true);
        assert_eq!(p.mode, Mode::Transcode);
        assert_eq!(p.reasons[0], "video:h264-10bit");
        // HEVC: transcode unless supported; supported + MKV → remux.
        let hevc = info("hevc", "Main 10", "yuv420p10le", "ac3", 6, "matroska,webm");
        assert_eq!(decide(&hevc, &caps, true).mode, Mode::Transcode);
        assert_eq!(decide(&hevc, &q("videoCodecs=h264,hevc&audioCodecs=aac"), true).mode, Mode::Remux);
        // No Cues: copy impossible → transcode.
        let p = decide(&mkv, &caps, false);
        assert_eq!(p.mode, Mode::Transcode);
        assert!(p.reasons.contains(&"noKeyframeIndex".to_string()));
        // Bitmap subtitle to burn → transcode; a text one is ignored (sidecar).
        let p = decide(&mp4, &q("burnSubtitle=1"), true);
        assert_eq!((p.mode, p.burn), (Mode::Transcode, Some(3)));
        assert_eq!(decide(&mp4, &q("burnSubtitle=0"), true).mode, Mode::Direct);
        assert_eq!(decide(&mp4, &q("forceTranscoding=1"), true).mode, Mode::Transcode);
        // Keys differ by plan.
        assert_ne!(decide(&ac3, &caps, true).key(), decide(&ac3, &q("maxAudioChannels=6"), true).key());
    }
}
