//! Synthetic media: real MP4/MKV containers made with ffmpeg from a test pattern (+ noise so the
//! encoder really spends the target bitrate), their container layout (where the header, the data
//! and the index — `moov` / Matroska `Cues` — live), and a `.torrent` for each.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Container {
    Mkv,
    Mp4MoovEnd,
    Mp4Faststart,
}

pub struct MediaSpec {
    pub id: &'static str,
    pub container: Container,
    pub target_bytes: u64,
    pub video_bps: u64,
    pub size: &'static str,
    pub piece_length: u32,
}

pub const SPECS: &[MediaSpec] = &[
    MediaSpec { id: "small-mkv", container: Container::Mkv, target_bytes: 150_000_000, video_bps: 1_400_000, size: "640x360", piece_length: 256 * 1024 },
    MediaSpec { id: "medium-mkv", container: Container::Mkv, target_bytes: 700_000_000, video_bps: 3_900_000, size: "854x480", piece_length: 1024 * 1024 },
    MediaSpec { id: "medium-mp4-moovend", container: Container::Mp4MoovEnd, target_bytes: 700_000_000, video_bps: 3_900_000, size: "854x480", piece_length: 1024 * 1024 },
    MediaSpec { id: "medium-mp4-faststart", container: Container::Mp4Faststart, target_bytes: 700_000_000, video_bps: 3_900_000, size: "854x480", piece_length: 1024 * 1024 },
    MediaSpec { id: "large-mp4-moovend", container: Container::Mp4MoovEnd, target_bytes: 2_000_000_000, video_bps: 7_800_000, size: "1280x720", piece_length: 2 * 1024 * 1024 },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProfile {
    pub id: String,
    pub container: Container,
    pub path: PathBuf,
    pub dir: PathBuf,
    pub file_name: String,
    pub size: u64,
    pub duration_s: f64,
    /// Average total bitrate (bits/s) = size * 8 / duration: what the player consumes in real time.
    pub bitrate_bps: f64,
    pub piece_length: u32,
    pub info_hash: String,
    pub torrent_path: PathBuf,
    /// Bytes a player reads at open before media data (MP4 faststart: through `moov`; MKV: EBML
    /// header + SeekHead/Info/Tracks; MP4 moov-at-end: ftyp + the start of mdat).
    pub header_end: u64,
    /// First media byte (mdat payload / first Cluster).
    pub data_start: u64,
    /// Index stored at the end of the file (offset, length), if any.
    pub tail_index: Option<(u64, u64)>,
}

fn run(cmd: &mut Command) -> Result<()> {
    let st = cmd.status().with_context(|| format!("running {cmd:?}"))?;
    if !st.success() {
        bail!("{cmd:?} failed with {st}");
    }
    Ok(())
}

fn probe_duration(path: &Path) -> Result<f64> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"])
        .arg(path)
        .output()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<f64>().with_context(|| format!("ffprobe duration of {path:?}: {s:?}"))
}

pub async fn generate(root: &Path, only: Option<&str>) -> Result<Vec<MediaProfile>> {
    let media_root = root.join("media");
    let seg_dir = media_root.join("segments");
    fs::create_dir_all(&seg_dir)?;
    let mut out = Vec::new();
    let existing: Vec<MediaProfile> = fs::read(media_root.join("media.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    for spec in SPECS {
        if only.is_some_and(|o| !spec.id.contains(o)) {
            if let Some(p) = existing.iter().find(|p| p.id == spec.id) {
                out.push(p.clone());
            }
            continue;
        }
        if let Some(p) = existing.iter().find(|p| p.id == spec.id && p.path.exists() && p.torrent_path.exists()) {
            eprintln!("media {}: exists ({} bytes)", spec.id, p.size);
            out.push(p.clone());
            continue;
        }
        // 1. A 60 s segment at the target bitrate (shared by specs with the same bitrate/size).
        let seg = seg_dir.join(format!("seg-{}-{}.mp4", spec.video_bps, spec.size));
        if !seg.exists() {
            eprintln!("media {}: encoding 60 s segment {} @ {} bit/s…", spec.id, spec.size, spec.video_bps);
            let vbr = spec.video_bps.to_string();
            let buf = (spec.video_bps / 2).to_string();
            run(Command::new("ffmpeg").args([
                "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", &format!("testsrc2=s={}:r=24,noise=alls=40:allf=t", spec.size),
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                "-t", "60", "-c:v", "libx264", "-preset", "ultrafast",
                "-b:v", &vbr, "-maxrate", &vbr, "-bufsize", &buf, "-g", "48", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "96k",
            ]).arg(&seg))?;
        }
        let seg_len = fs::metadata(&seg)?.len() as f64;
        let seg_dur = probe_duration(&seg)?;
        let duration = (spec.target_bytes as f64 / (seg_len / seg_dur)).round();

        // 2. Loop it (stream copy) into the final container.
        let dir = media_root.join(spec.id);
        fs::create_dir_all(&dir)?;
        let ext = if spec.container == Container::Mkv { "mkv" } else { "mp4" };
        let file_name = format!("Huwa.Bench.{}.{}", spec.id, ext);
        let path = dir.join(&file_name);
        eprintln!("media {}: remuxing {duration:.0} s into {file_name}…", spec.id);
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i"])
            .arg(&seg)
            .args(["-t", &format!("{duration}"), "-map", "0", "-c", "copy"]);
        if spec.container == Container::Mp4Faststart {
            cmd.args(["-movflags", "+faststart"]);
        }
        run(cmd.arg(&path))?;

        let size = fs::metadata(&path)?.len();
        let duration_s = probe_duration(&path)?;
        let layout = match spec.container {
            Container::Mkv => mkv_layout(&path)?,
            _ => mp4_layout(&path)?,
        };

        // 3. Torrent (no trackers inside: the engine gets the local tracker through `sources`).
        eprintln!("media {}: hashing torrent ({} KiB pieces)…", spec.id, spec.piece_length / 1024);
        let spawner = librqbit::spawn_utils::BlockingSpawner::new(4);
        let t = librqbit::create_torrent(
            &path,
            librqbit::CreateTorrentOptions { name: None, trackers: vec![], piece_length: Some(spec.piece_length) },
            &spawner,
        )
        .await?;
        let info_hash = t.info_hash().as_string().to_lowercase();
        let torrent_path = dir.join(format!("{}.torrent", spec.id));
        fs::write(&torrent_path, t.as_bytes()?)?;

        let p = MediaProfile {
            id: spec.id.into(),
            container: spec.container,
            path: path.clone(),
            dir,
            file_name,
            size,
            duration_s,
            bitrate_bps: size as f64 * 8.0 / duration_s,
            piece_length: spec.piece_length,
            info_hash,
            torrent_path,
            header_end: layout.header_end,
            data_start: layout.data_start,
            tail_index: layout.tail_index,
        };
        eprintln!(
            "media {}: {} bytes, {:.0} s, {:.2} Mbit/s, data@{}, header_end={}, tail_index={:?}, btih={}",
            p.id, p.size, p.duration_s, p.bitrate_bps / 1e6, p.data_start, p.header_end, p.tail_index, p.info_hash
        );
        out.push(p);
        fs::write(media_root.join("media.json"), serde_json::to_vec_pretty(&out)?)?;
    }
    fs::write(media_root.join("media.json"), serde_json::to_vec_pretty(&out)?)?;
    Ok(out)
}

pub fn load(root: &Path) -> Result<Vec<MediaProfile>> {
    let b = fs::read(root.join("media/media.json")).context("media/media.json missing: run `gen-media` first")?;
    Ok(serde_json::from_slice(&b)?)
}

pub struct Layout {
    pub header_end: u64,
    pub data_start: u64,
    pub tail_index: Option<(u64, u64)>,
}

fn read_at(f: &fs::File, off: u64, buf: &mut [u8]) -> Result<usize> {
    use std::os::unix::fs::FileExt;
    Ok(f.read_at(buf, off)?)
}

pub fn mp4_layout(path: &Path) -> Result<Layout> {
    let f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut off = 0u64;
    let mut moov = None;
    let mut mdat = None;
    while off + 8 <= len {
        let mut h = [0u8; 16];
        read_at(&f, off, &mut h)?;
        let mut size = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let kind = &h[4..8];
        let mut hdr = 8;
        if size == 1 {
            size = u64::from_be_bytes(h[8..16].try_into().unwrap());
            hdr = 16;
        } else if size == 0 {
            size = len - off;
        }
        match kind {
            b"moov" => moov = Some((off, size)),
            b"mdat" => mdat = Some((off, size, hdr)),
            _ => {}
        }
        off += size;
    }
    let (moov_off, moov_len) = moov.context("no moov box")?;
    let (mdat_off, _, mdat_hdr) = mdat.context("no mdat box")?;
    let data_start = mdat_off + mdat_hdr;
    if moov_off < mdat_off {
        Ok(Layout { header_end: moov_off + moov_len, data_start, tail_index: None })
    } else {
        // AVPlayer/ExoPlayer read the beginning until they find mdat, then jump to moov.
        Ok(Layout { header_end: data_start, data_start, tail_index: Some((moov_off, moov_len)) })
    }
}

fn vint(f: &fs::File, off: u64, strip_marker: bool) -> Result<(u64, u64)> {
    let mut b = [0u8; 8];
    read_at(f, off, &mut b)?;
    let first = b[0];
    let len = first.leading_zeros() as u64 + 1;
    if len > 8 {
        bail!("bad vint at {off}");
    }
    let mut v: u64 = if strip_marker { (first as u64) & ((1u64 << (8 - len)) - 1) } else { first as u64 };
    for i in 1..len as usize {
        v = (v << 8) | b[i] as u64;
    }
    Ok((v, len))
}

pub fn mkv_layout(path: &Path) -> Result<Layout> {
    let f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    // EBML header
    let (id, il) = vint(&f, 0, false)?;
    if id != 0x1A45DFA3 {
        bail!("not an EBML file");
    }
    let (sz, sl) = vint(&f, il, true)?;
    let seg_off = il + sl + sz;
    let (sid, sil) = vint(&f, seg_off, false)?;
    if sid != 0x18538067 {
        bail!("no Segment");
    }
    let (_, ssl) = vint(&f, seg_off + sil, true)?;
    let mut off = seg_off + sil + ssl;
    let mut first_cluster = None;
    let mut cues = None;
    while off < len {
        let (cid, cil) = vint(&f, off, false)?;
        let (csz, csl) = vint(&f, off + cil, true)?;
        let total = cil + csl + csz;
        match cid {
            0x1F43B675 if first_cluster.is_none() => first_cluster = Some(off),
            0x1C53BB6B => cues = Some((off, total)),
            _ => {}
        }
        off += total;
    }
    let data_start = first_cluster.context("no Cluster")?;
    let tail_index = cues.filter(|(o, _)| *o > data_start);
    Ok(Layout { header_end: data_start, data_start, tail_index })
}
