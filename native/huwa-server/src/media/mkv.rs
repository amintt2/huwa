//! Matroska keyframe index from the Cues (D13): copy-mode HLS segment boundaries.
//!
//! The SeekHead, Info and Tracks are in the first KiB of the file; mkvmerge writes the Cues after
//! the last cluster, in the tail the engine already prefetches for the player (see
//! `huwa_torrent_core::priorities::startup_tail_plan`). Two range reads: the head, then the Cues.

use std::{future::Future, pin::Pin};

use anyhow::{anyhow, Result};

pub const EBML: u32 = 0x1A45_DFA3;
pub const SEGMENT: u32 = 0x1853_8067;
pub const SEEK_HEAD: u32 = 0x114D_9B74;
pub const SEEK: u32 = 0x4DBB;
pub const SEEK_ID: u32 = 0x53AB;
pub const SEEK_POSITION: u32 = 0x53AC;
pub const INFO: u32 = 0x1549_A966;
pub const TIMECODE_SCALE: u32 = 0x2A_D7B1;
pub const TRACKS: u32 = 0x1654_AE6B;
pub const TRACK_ENTRY: u32 = 0xAE;
pub const TRACK_NUMBER: u32 = 0xD7;
pub const TRACK_TYPE: u32 = 0x83;
pub const CUES: u32 = 0x1C53_BB6B;
pub const CUE_POINT: u32 = 0xBB;
pub const CUE_TIME: u32 = 0xB3;
pub const CUE_TRACK_POSITIONS: u32 = 0xB7;
pub const CUE_TRACK: u32 = 0xF7;
pub const CLUSTER: u32 = 0x1F43_B675;

/// Bytes read at the start of the file.
pub const HEAD_BYTES: u64 = 256 * 1024;
/// Largest Cues element accepted (a 3 h film at 1 cue / s is ~ 100 KiB).
pub const MAX_CUES: u64 = 32 * 1024 * 1024;

/// Element ID (marker bits kept, as written in the spec) and its length.
pub fn read_id(b: &[u8], pos: usize) -> Option<(u32, usize)> {
    let first = *b.get(pos)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 4 {
        return None;
    }
    let bytes = b.get(pos..pos + len)?;
    Some((bytes.iter().fold(0u32, |v, x| (v << 8) | *x as u32), len))
}

/// Element data size (`None` = unknown size) and its length.
pub fn read_size(b: &[u8], pos: usize) -> Option<(Option<u64>, usize)> {
    let first = *b.get(pos)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 {
        return None;
    }
    let bytes = b.get(pos..pos + len)?;
    let mut v = (first as u64) & (0xFFu64 >> len);
    for x in &bytes[1..] {
        v = (v << 8) | *x as u64;
    }
    let unknown = v == (1u64 << (7 * len)) - 1;
    Some(((!unknown).then_some(v), len))
}

fn uint(b: &[u8]) -> u64 {
    b.iter().take(8).fold(0u64, |v, x| (v << 8) | *x as u64)
}

/// Element at `pos`: `(id, data_start, data_size)`.
fn element(b: &[u8], pos: usize) -> Option<(u32, usize, Option<u64>)> {
    let (id, l) = read_id(b, pos)?;
    let (size, l2) = read_size(b, pos + l)?;
    Some((id, pos + l + l2, size))
}

/// Children of a master element's data `[start, end)`: `(id, data_start, data_end)`.
fn children(b: &[u8], start: usize, end: usize) -> Vec<(u32, usize, usize)> {
    let mut out = Vec::new();
    let mut p = start;
    let end = end.min(b.len());
    while p < end {
        let Some((id, data, size)) = element(b, p) else { break };
        let Some(size) = size else { break };
        let data_end = data + size as usize;
        if data_end > end {
            break;
        }
        out.push((id, data, data_end));
        p = data_end;
    }
    out
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Layout {
    /// Offset of the Segment's data (SeekPosition origin).
    pub segment: u64,
    pub timecode_scale: u64,
    pub video_tracks: Vec<u64>,
    /// Absolute offsets of the top-level elements the SeekHead lists (or found in the head).
    pub cues: Option<u64>,
    pub info: Option<u64>,
    pub tracks: Option<u64>,
}

fn parse_info(b: &[u8], start: usize, end: usize, l: &mut Layout) {
    for (id, d, e) in children(b, start, end) {
        if id == TIMECODE_SCALE {
            l.timecode_scale = uint(&b[d..e]);
        }
    }
}

fn parse_tracks(b: &[u8], start: usize, end: usize, l: &mut Layout) {
    for (id, d, e) in children(b, start, end) {
        if id != TRACK_ENTRY {
            continue;
        }
        let (mut num, mut kind) = (None, None);
        for (cid, cd, ce) in children(b, d, e) {
            match cid {
                TRACK_NUMBER => num = Some(uint(&b[cd..ce])),
                TRACK_TYPE => kind = Some(uint(&b[cd..ce])),
                _ => {}
            }
        }
        if let (Some(n), Some(1)) = (num, kind) {
            l.video_tracks.push(n);
        }
    }
}

/// Reads what the head says: segment origin, SeekHead targets, Info and Tracks when present.
pub fn parse_head(head: &[u8]) -> Option<Layout> {
    let (id, data, size) = element(head, 0)?;
    if id != EBML {
        return None;
    }
    let mut p = data + size? as usize;
    let (id, seg_data, _) = element(head, p)?;
    if id != SEGMENT {
        return None;
    }
    let mut l = Layout { segment: seg_data as u64, timecode_scale: 1_000_000, ..Default::default() };
    p = seg_data;
    while p < head.len() {
        let Some((id, d, size)) = element(head, p) else { break };
        if id == CLUSTER {
            break;
        }
        let Some(size) = size else { break };
        let e = d + size as usize;
        match id {
            SEEK_HEAD if e <= head.len() => {
                for (sid, sd, se) in children(head, d, e) {
                    if sid != SEEK {
                        continue;
                    }
                    let (mut target, mut pos) = (None, None);
                    for (cid, cd, ce) in children(head, sd, se) {
                        match cid {
                            SEEK_ID => target = Some(uint(&head[cd..ce]) as u32),
                            SEEK_POSITION => pos = Some(uint(&head[cd..ce])),
                            _ => {}
                        }
                    }
                    if let (Some(t), Some(at)) = (target, pos) {
                        let abs = l.segment + at;
                        match t {
                            CUES => l.cues = l.cues.or(Some(abs)),
                            INFO => l.info = l.info.or(Some(abs)),
                            TRACKS => l.tracks = l.tracks.or(Some(abs)),
                            _ => {}
                        }
                    }
                }
            }
            INFO if e <= head.len() => {
                l.info = Some(p as u64);
                parse_info(head, d, e, &mut l);
            }
            TRACKS if e <= head.len() => {
                l.tracks = Some(p as u64);
                parse_tracks(head, d, e, &mut l);
            }
            CUES => l.cues = Some(p as u64),
            _ => {}
        }
        p = e;
    }
    Some(l)
}

/// Keyframe times (seconds) of `video_tracks` in a Cues element (`b` starts at its header).
pub fn parse_cues(b: &[u8], timecode_scale: u64, video_tracks: &[u64]) -> Vec<f64> {
    let Some((id, d, size)) = element(b, 0) else { return Vec::new() };
    if id != CUES {
        return Vec::new();
    }
    let end = size.map_or(b.len(), |s| (d + s as usize).min(b.len()));
    let mut out = Vec::new();
    for (pid, pd, pe) in children(b, d, end) {
        if pid != CUE_POINT {
            continue;
        }
        let mut time = None;
        let mut video = false;
        for (cid, cd, ce) in children(b, pd, pe) {
            match cid {
                CUE_TIME => time = Some(uint(&b[cd..ce])),
                CUE_TRACK_POSITIONS => {
                    for (tid, td, te) in children(b, cd, ce) {
                        if tid == CUE_TRACK && (video_tracks.is_empty() || video_tracks.contains(&uint(&b[td..te]))) {
                            video = true;
                        }
                    }
                }
                _ => {}
            }
        }
        if let (Some(t), true) = (time, video) {
            out.push((t as u128 * timecode_scale as u128) as f64 / 1e9);
        }
    }
    out.sort_by(f64::total_cmp);
    out.dedup_by(|a, b| (*a - *b).abs() < 0.0005);
    out
}

pub type ReadFut<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>>> + Send + 'a>>;

/// Keyframe times from the Cues, reading through `read(start, end_exclusive)`. `Ok(None)` when the
/// file has no usable Cues.
pub async fn keyframes<'a>(read: &'a (dyn Fn(u64, u64) -> ReadFut<'a> + Send + Sync), file_len: u64) -> Result<Option<Vec<f64>>> {
    let head = read(0, HEAD_BYTES.min(file_len)).await?;
    let Some(mut l) = parse_head(&head) else { return Ok(None) };
    // Info / Tracks placed after the head (rare): read them where the SeekHead says.
    for (at, is_info) in [(l.info, true), (l.tracks, false)] {
        let Some(at) = at else { continue };
        let known = if is_info { l.timecode_scale != 1_000_000 } else { !l.video_tracks.is_empty() };
        if known || at + 16 <= head.len() as u64 {
            continue;
        }
        let hdr = read(at, (at + 16).min(file_len)).await?;
        let Some((_, d, Some(size))) = element(&hdr, 0) else { continue };
        let total = d as u64 + size;
        if total > 4 * 1024 * 1024 {
            continue;
        }
        let el = read(at, (at + total).min(file_len)).await?;
        if is_info {
            parse_info(&el, d, el.len(), &mut l);
        } else {
            parse_tracks(&el, d, el.len(), &mut l);
        }
    }
    let Some(cues_at) = l.cues.filter(|c| *c < file_len) else { return Ok(None) };
    let hdr = if cues_at + 16 <= head.len() as u64 { head[cues_at as usize..cues_at as usize + 16].to_vec() } else { read(cues_at, (cues_at + 16).min(file_len)).await? };
    let Some((CUES, d, Some(size))) = element(&hdr, 0) else { return Err(anyhow!("no Cues element where the SeekHead points")) };
    let total = d as u64 + size;
    if total > MAX_CUES {
        return Ok(None);
    }
    let cues = if cues_at + total <= head.len() as u64 {
        head[cues_at as usize..(cues_at + total) as usize].to_vec()
    } else {
        read(cues_at, (cues_at + total).min(file_len)).await?
    };
    let k = parse_cues(&cues, l.timecode_scale.max(1), &l.video_tracks);
    Ok((k.len() >= 2).then_some(k))
}

/// Segment start times for copy mode: a cut at the first keyframe at least `target` seconds after
/// the previous cut (always on a keyframe, so a restarted ffmpeg cuts at the same places).
pub fn copy_segments(keyframes: &[f64], duration: f64, target: f64) -> Vec<(f64, f64)> {
    let mut starts = vec![0.0];
    for &k in keyframes.iter().filter(|k| **k > 0.05 && **k < duration - 0.05) {
        if k - starts.last().copied().unwrap_or(0.0) >= target {
            starts.push(k);
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (i, s) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(duration);
        out.push((*s, (end - s).max(0.001)));
    }
    out
}

/// Fixed-length segments (transcode: keyframes are forced on the grid).
/// A remainder under half a second joins the last segment (no near-empty final segment).
pub fn grid_segments(duration: f64, target: f64) -> Vec<(f64, f64)> {
    let mut n = (duration / target).ceil().max(1.0) as usize;
    if n > 1 && duration - (n - 1) as f64 * target < 0.5 {
        n -= 1;
    }
    (0..n).map(|i| (i as f64 * target, if i + 1 == n { (duration - i as f64 * target).max(0.001) } else { target })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal EBML writer for the tests.
    fn el(id: u32, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let idb = id.to_be_bytes();
        let skip = idb.iter().position(|b| *b != 0).unwrap_or(3);
        out.extend_from_slice(&idb[skip..]);
        let n = data.len() as u64;
        // 8-byte size.
        out.push(0x01);
        out.extend_from_slice(&n.to_be_bytes()[1..]);
        out.extend_from_slice(data);
        out
    }

    fn u(id: u32, v: u64) -> Vec<u8> {
        el(id, &v.to_be_bytes())
    }

    fn sample() -> (Vec<u8>, Vec<f64>) {
        let ebml = el(EBML, &[]);
        let info = el(INFO, &u(TIMECODE_SCALE, 1_000_000));
        let tracks = el(TRACKS, &[el(TRACK_ENTRY, &[u(TRACK_NUMBER, 1), u(TRACK_TYPE, 1)].concat()), el(TRACK_ENTRY, &[u(TRACK_NUMBER, 2), u(TRACK_TYPE, 2)].concat())].concat());
        let times = [0u64, 2002, 4004, 6006, 9500];
        let mut cues_data = Vec::new();
        for t in times {
            cues_data.extend(el(CUE_POINT, &[u(CUE_TIME, t), el(CUE_TRACK_POSITIONS, &[u(CUE_TRACK, 1), u(0xF1, 1234)].concat())].concat()));
        }
        // An audio cue that must be ignored.
        cues_data.extend(el(CUE_POINT, &[u(CUE_TIME, 7000), el(CUE_TRACK_POSITIONS, &u(CUE_TRACK, 2))].concat()));
        let cues = el(CUES, &cues_data);
        let cluster = el(CLUSTER, &vec![0u8; 5000]);
        // SeekHead with a fixed size so positions can be computed.
        let seek = |id: u32, pos: u64| el(SEEK, &[el(SEEK_ID, &id.to_be_bytes()), u(SEEK_POSITION, pos)].concat());
        let seekhead_len = el(SEEK_HEAD, &[seek(CUES, 0), seek(INFO, 0), seek(TRACKS, 0)].concat()).len() as u64;
        let info_pos = seekhead_len;
        let tracks_pos = info_pos + info.len() as u64;
        let cues_pos = tracks_pos + tracks.len() as u64 + cluster.len() as u64;
        let seekhead = el(SEEK_HEAD, &[seek(CUES, cues_pos), seek(INFO, info_pos), seek(TRACKS, tracks_pos)].concat());
        let body = [seekhead, info, tracks, cluster, cues].concat();
        let segment = el(SEGMENT, &body);
        let file = [ebml, segment].concat();
        (file, times.iter().map(|t| *t as f64 / 1000.0).collect())
    }

    #[test]
    fn reads_cues_through_ranges() {
        let (file, want) = sample();
        let reads = std::sync::Mutex::new(Vec::new());
        let f = file.clone();
        let read = |s: u64, e: u64| -> ReadFut<'_> {
            reads.lock().unwrap().push((s, e));
            let v = f[s as usize..e as usize].to_vec();
            Box::pin(async move { Ok(v) })
        };
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let k = rt.block_on(keyframes(&read, file.len() as u64)).unwrap().unwrap();
        assert_eq!(k, want);
        let l = parse_head(&file).unwrap();
        assert_eq!(l.video_tracks, vec![1]);
        assert_eq!(l.timecode_scale, 1_000_000);
    }

    #[test]
    fn segments() {
        let k = [0.0, 2.002, 4.004, 6.006, 9.5, 11.0, 30.0];
        let s = copy_segments(&k, 40.0, 4.0);
        assert_eq!(s.iter().map(|x| x.0).collect::<Vec<_>>(), vec![0.0, 4.004, 9.5, 30.0]);
        assert!((s.last().unwrap().1 - 10.0).abs() < 1e-9);
        let g = grid_segments(10.0, 4.0);
        assert_eq!(g, vec![(0.0, 4.0), (4.0, 4.0), (8.0, 2.0)]);
        let g = grid_segments(240.02, 4.0);
        assert_eq!(g.len(), 60);
        assert!((g[59].1 - 4.02).abs() < 1e-9);
        assert!(parse_head(b"not mkv").is_none());
    }
}
