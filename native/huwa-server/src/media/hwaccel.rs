//! Video encoder for transcodes (`HUWA_HWACCEL`): probed once at start by encoding a few frames
//! of a test pattern with each candidate. Decoding stays in software (Hi10P, burned subtitles
//! and odd profiles all work the same way); frames are uploaded to the GPU for encoding only.

use std::{path::Path, time::Duration};

use tracing::{info, warn};

use crate::config::HwAccel;

pub const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    Software,
    Vaapi,
    Qsv,
    Nvenc,
}

impl Encoder {
    pub fn name(self) -> &'static str {
        match self {
            Encoder::Software => "libx264",
            Encoder::Vaapi => "h264_vaapi",
            Encoder::Qsv => "h264_qsv",
            Encoder::Nvenc => "h264_nvenc",
        }
    }

    /// Global options before `-i` (device setup).
    pub fn input_args(self) -> Vec<String> {
        let v: &[&str] = match self {
            Encoder::Software | Encoder::Nvenc => &[],
            Encoder::Vaapi => &["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va"],
            Encoder::Qsv => &["-init_hw_device", "qsv=qs:hw_any", "-filter_hw_device", "qs"],
        };
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Filters appended after the software chain (upload to the encoder's surfaces).
    pub fn upload_filter(self) -> &'static str {
        match self {
            Encoder::Software | Encoder::Nvenc => "format=yuv420p",
            Encoder::Vaapi => "format=nv12,hwupload",
            Encoder::Qsv => "format=nv12,hwupload=extra_hw_frames=64",
        }
    }

    /// Encoder options (quality-targeted, capped bitrate for `height`).
    pub fn codec_args(self, height: u32) -> Vec<String> {
        let maxrate = match height {
            0..=480 => "2M",
            481..=720 => "5M",
            _ => "9M",
        };
        let bufsize = match height {
            0..=480 => "4M",
            481..=720 => "10M",
            _ => "18M",
        };
        let v: Vec<&str> = match self {
            Encoder::Software => vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-maxrate", maxrate, "-bufsize", bufsize],
            Encoder::Vaapi => vec!["-c:v", "h264_vaapi", "-rc_mode", "QVBR", "-global_quality", "23", "-maxrate", maxrate, "-bufsize", bufsize, "-profile:v", "high"],
            Encoder::Qsv => vec!["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-maxrate", maxrate, "-bufsize", bufsize, "-profile:v", "high"],
            Encoder::Nvenc => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-maxrate", maxrate, "-bufsize", bufsize, "-profile:v", "high", "-forced-idr", "1"],
        };
        v.into_iter().map(String::from).collect()
    }
}

async fn works(ffmpeg: &Path, enc: Encoder) -> bool {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into()];
    args.extend(enc.input_args());
    args.extend(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=0.4"].map(String::from));
    args.extend(["-vf".to_string(), enc.upload_filter().to_string()]);
    args.extend(enc.codec_args(240));
    args.extend(["-f", "null", "-"].map(String::from));
    let run = tokio::process::Command::new(ffmpeg).args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true).output();
    match tokio::time::timeout(Duration::from_secs(20), run).await {
        Ok(Ok(out)) if out.status.success() => true,
        Ok(Ok(out)) => {
            let err = String::from_utf8_lossy(&out.stderr);
            info!(encoder = enc.name(), "not usable: {}", err.lines().last().unwrap_or(""));
            false
        }
        _ => false,
    }
}

/// The encoder to use for `pref` (software when nothing else works).
pub async fn probe(ffmpeg: &Path, pref: HwAccel) -> Encoder {
    let candidates: &[Encoder] = match pref {
        HwAccel::None => return Encoder::Software,
        HwAccel::Vaapi => &[Encoder::Vaapi],
        HwAccel::Qsv => &[Encoder::Qsv],
        HwAccel::Nvenc => &[Encoder::Nvenc],
        HwAccel::Auto => &[Encoder::Vaapi, Encoder::Qsv, Encoder::Nvenc],
    };
    for &c in candidates {
        if c == Encoder::Vaapi && !Path::new(VAAPI_DEVICE).exists() {
            continue;
        }
        if c == Encoder::Qsv && !Path::new("/dev/dri").exists() {
            continue;
        }
        if c == Encoder::Nvenc && !Path::new("/dev/nvidia0").exists() && !Path::new("/dev/nvidiactl").exists() {
            continue;
        }
        if works(ffmpeg, c).await {
            info!(encoder = c.name(), "hardware encoder enabled");
            return c;
        }
    }
    if pref != HwAccel::Auto {
        warn!(?pref, "requested hardware encoder unusable, transcoding in software");
    }
    Encoder::Software
}
