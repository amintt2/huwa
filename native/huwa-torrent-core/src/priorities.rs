// Adapted from stream-server `enginefs/src/backend/priorities.rs`
// (https://github.com/perpetus/stream-server), MIT License.
//
// MIT License
//
// Copyright (c) 2025 perpetus
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Huwa adaptation (MIT): the original drives libtorrent piece priorities and deadlines.
// librqbit has no per-piece priority API; what it offers is `FileStream` — a seekable reader
// whose position drives a 32 MiB look-ahead queue, with the queues of all open streams
// interleaved. The policy below decides *windows* (immediate / hot / warm / metadata bands in
// pieces, exactly like the original); the HTTP server uses `classify_request` to tell playback
// requests from container-index probes, and `streaming.rs` materialises the read-ahead and the
// tail prefetch sized by `readahead_target_bytes` / `tail_prefetch_bytes` (end of this file).
// HLS intents and the disk-backed download intents were dropped: Huwa streams directly and
// caches on disk.

/// Startup is gated on the actual first readable bytes. Keep speculative work near the player's
/// ~4 MiB network buffer so rare seek/Cues pieces are not starved by a large urgent head window.
pub const MIN_STARTUP_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_STARTUP_WINDOW_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_SEEK_HOT_WINDOW_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_WARM_WINDOW_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_CONTAINER_METADATA_WINDOW_BYTES: u64 = 16 * 1024 * 1024;
pub const SMALL_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum pieces to prioritize before first byte is delivered.
pub const MAX_STARTUP_PIECES: i32 = 4;
pub const MAX_SMALL_FILE_STARTUP_PIECES: i32 = 32;
/// Minimum pieces to prioritize before first byte is delivered.
pub const MIN_STARTUP_PIECES: i32 = 2;

pub const MIN_SEEK_HOT_PIECES: i32 = 24;
pub const SEEK_IMMEDIATE_PIECES: i32 = 12;
pub const MAX_HOT_PIECES: i32 = 96;
pub const MAX_WARM_PIECES: i32 = 192;
const MIN_PIECE_DEADLINE_STEP_MS: u64 = 500;
const MAX_PIECE_DEADLINE_STEP_MS: u64 = 30_000;

/// Start treating reads as "container metadata" when they fall in the last 10 MiB or the last 5%
/// of the file, whichever starts earlier (MKV Cues, MP4 `moov` at the end).
pub fn container_metadata_start(file_size: u64) -> u64 {
    if file_size == 0 {
        0
    } else if file_size < SMALL_FILE_BYTES {
        file_size.saturating_mul(95) / 100
    } else {
        file_size
            .saturating_sub(10 * 1024 * 1024)
            .min(file_size.saturating_mul(95) / 100)
    }
}

pub fn is_container_metadata_request(start: u64, requested_len: u64, file_size: u64) -> bool {
    start > 0
        && file_size > 0
        && requested_len > 0
        && requested_len <= MAX_CONTAINER_METADATA_WINDOW_BYTES
        && start >= container_metadata_start(file_size)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackIntent {
    /// First request of a playback session (offset 0 or first bytes not sent yet).
    DirectInitial,
    /// Range request far from the current position.
    DirectSeek,
    /// Continuation of an established playback.
    DirectSequential,
    /// Small read near the end of the file (seek index).
    ContainerMetadata,
    /// Anything else (probe by the player, prefetch of a paused torrent…).
    Background,
}

impl PlaybackIntent {
    pub fn sequential_after_first_byte(self) -> Self {
        match self {
            Self::DirectInitial | Self::DirectSeek | Self::DirectSequential => Self::DirectSequential,
            other => other,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectInitial => "initial",
            Self::DirectSeek => "seek",
            Self::DirectSequential => "sequential",
            Self::ContainerMetadata => "container-metadata",
            Self::Background => "background",
        }
    }
}

/// Classify an HTTP range request against the state of its playback session.
pub fn classify_request(
    start: u64,
    requested_len: u64,
    file_size: u64,
    first_byte_sent: bool,
    last_served_end: Option<u64>,
) -> PlaybackIntent {
    if is_container_metadata_request(start, requested_len, file_size) {
        return PlaybackIntent::ContainerMetadata;
    }
    if !first_byte_sent || start == 0 {
        return PlaybackIntent::DirectInitial;
    }
    match last_served_end {
        // Resumed right where the previous body stopped (players re-request in chunks).
        Some(end) if start.abs_diff(end) <= 2 * 1024 * 1024 => PlaybackIntent::DirectSequential,
        _ => PlaybackIntent::DirectSeek,
    }
}

pub fn playback_deadline_step_ms(
    piece_length: u64,
    bitrate_bytes_per_sec: Option<u64>,
    download_rate_bytes_per_sec: u64,
) -> i32 {
    let bitrate = bitrate_bytes_per_sec.filter(|rate| *rate > 0);
    let download_rate = (download_rate_bytes_per_sec > 0).then_some(download_rate_bytes_per_sec);
    let effective_rate = match (bitrate, download_rate) {
        (Some(bitrate), Some(download_rate)) => bitrate.min(download_rate),
        (Some(bitrate), None) => bitrate,
        (None, Some(download_rate)) => download_rate,
        (None, None) => 1024 * 1024,
    };
    let step_ms = piece_length
        .saturating_mul(1_000)
        .div_ceil(effective_rate)
        .clamp(MIN_PIECE_DEADLINE_STEP_MS, MAX_PIECE_DEADLINE_STEP_MS);
    step_ms as i32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryPressure {
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriorityBand {
    Immediate,
    Hot,
    Warm,
    Metadata,
    Background,
}

#[derive(Debug, Clone)]
pub struct PriorityContext {
    pub intent: PlaybackIntent,
    pub current_piece: i32,
    pub first_piece: i32,
    pub last_piece: i32,
    pub piece_length: u64,
    pub file_size: u64,
    pub bitrate_bytes_per_sec: Option<u64>,
    pub download_rate_bytes_per_sec: u64,
    pub peers: u64,
    pub cache_size_bytes: u64,
    pub memory_pressure: MemoryPressure,
    pub consecutive_waits: u32,
    pub first_byte_sent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriorityAssignment {
    pub piece_idx: i32,
    pub piece_priority: i32,
    pub deadline: i32,
    pub band: PriorityBand,
}

#[derive(Debug, Clone)]
pub struct PriorityDecision {
    pub assignments: Vec<PriorityAssignment>,
    pub target_window_pieces: i32,
    pub immediate_pieces: i32,
    pub hot_window_pieces: i32,
    pub warm_window_pieces: i32,
    pub reason: String,
}

pub struct PlaybackPriorityPolicy;

impl PlaybackPriorityPolicy {
    pub fn decide(ctx: PriorityContext) -> PriorityDecision {
        if ctx.piece_length == 0 || ctx.current_piece < ctx.first_piece || ctx.last_piece < ctx.first_piece {
            return PriorityDecision {
                assignments: Vec::new(),
                target_window_pieces: 0,
                immediate_pieces: 0,
                hot_window_pieces: 0,
                warm_window_pieces: 0,
                reason: "invalid-context".to_string(),
            };
        }

        let max_cache_pieces = if ctx.cache_size_bytes > 0 {
            (ctx.cache_size_bytes / ctx.piece_length).max(1).min(i32::MAX as u64) as i32
        } else {
            MAX_HOT_PIECES
        };
        let remaining_pieces = ctx.last_piece.saturating_sub(ctx.current_piece) + 1;

        let bitrate_ratio = ctx
            .bitrate_bytes_per_sec
            .filter(|bitrate| *bitrate > 0)
            .map(|bitrate| ctx.download_rate_bytes_per_sec as f64 / bitrate as f64);

        let mut reason = ctx.intent.as_str().to_string();

        let (mut immediate, mut hot, mut warm) = match ctx.intent {
            PlaybackIntent::DirectInitial if !ctx.first_byte_sent => {
                let target_bytes = match ctx.bitrate_bytes_per_sec {
                    Some(bitrate) => bitrate.saturating_mul(10).max(MIN_STARTUP_BYTES),
                    None if ctx.file_size > 0 && ctx.file_size <= SMALL_FILE_BYTES => {
                        ctx.file_size.min(MAX_STARTUP_WINDOW_BYTES)
                    }
                    None => MIN_STARTUP_BYTES,
                }
                .max(ctx.piece_length)
                .min(MAX_STARTUP_WINDOW_BYTES.max(ctx.piece_length));
                let pieces = target_bytes.saturating_add(ctx.piece_length.saturating_sub(1)) / ctx.piece_length;
                let max_startup_pieces = if ctx.bitrate_bytes_per_sec.is_none() && ctx.file_size <= SMALL_FILE_BYTES {
                    pieces_for_bytes(ctx.file_size.min(MAX_STARTUP_WINDOW_BYTES), ctx.piece_length)
                        .clamp(1, MAX_SMALL_FILE_STARTUP_PIECES)
                } else {
                    MAX_STARTUP_PIECES
                };
                let min_startup_pieces = MIN_STARTUP_PIECES.min(max_startup_pieces).max(1);
                let pieces = (pieces.min(i32::MAX as u64) as i32).clamp(min_startup_pieces, max_startup_pieces);
                // Keep the immediate band small so the swarm focuses bandwidth on the head pieces
                // the player needs for its first bytes.
                (pieces.min(MAX_STARTUP_PIECES), pieces, 0)
            }
            PlaybackIntent::DirectInitial | PlaybackIntent::DirectSequential => {
                (2, dynamic_hot_window(&ctx, bitrate_ratio), 32)
            }
            PlaybackIntent::DirectSeek if !ctx.first_byte_sent => {
                reason.push_str("-first-piece-only");
                (1, 1, 0)
            }
            PlaybackIntent::DirectSeek => {
                let mut hot = dynamic_hot_window(&ctx, bitrate_ratio).max(MIN_SEEK_HOT_PIECES);
                let mut immediate = SEEK_IMMEDIATE_PIECES;
                if ctx.consecutive_waits >= 3 {
                    hot = (hot * 2).min(MAX_HOT_PIECES);
                    immediate = (immediate * 2).min(hot);
                    reason.push_str("-blocked-expand");
                }
                (immediate, hot, 32)
            }
            PlaybackIntent::ContainerMetadata => (1, 2, 0),
            PlaybackIntent::Background => (0, 4, 0),
        };

        if matches!(ctx.memory_pressure, MemoryPressure::High) {
            hot = hot.min(MIN_SEEK_HOT_PIECES);
            warm = 0;
            reason.push_str("-memory-clamp");
        }

        if matches!(ctx.intent, PlaybackIntent::Background) {
            warm = 0;
        }

        let original_hot = hot;
        let original_warm = warm;
        hot = cap_pieces_by_bytes(hot, ctx.piece_length, hot_byte_cap(&ctx));
        warm = cap_pieces_by_bytes(warm, ctx.piece_length, warm_byte_cap(ctx.intent));
        if hot < original_hot || warm < original_warm {
            reason.push_str("-byte-cap");
        }

        hot = hot.clamp(0, MAX_HOT_PIECES).min(max_cache_pieces).min(remaining_pieces);
        warm = warm
            .clamp(0, MAX_WARM_PIECES)
            .min(max_cache_pieces.saturating_sub(hot))
            .min(remaining_pieces.saturating_sub(hot));
        immediate = immediate.min(hot).max(0);

        let target_window = hot + warm;
        let mut assignments = Vec::with_capacity(target_window as usize);
        for distance in 0..target_window {
            let piece_idx = ctx.current_piece + distance;
            if piece_idx > ctx.last_piece {
                break;
            }
            let (band, piece_priority, deadline) = assignment_for(&ctx, distance, immediate, hot);
            assignments.push(PriorityAssignment { piece_idx, piece_priority, deadline, band });
        }

        PriorityDecision {
            assignments,
            target_window_pieces: target_window,
            immediate_pieces: immediate,
            hot_window_pieces: hot,
            warm_window_pieces: warm,
            reason,
        }
    }
}

fn pieces_for_bytes(bytes: u64, piece_length: u64) -> i32 {
    if bytes == 0 || piece_length == 0 {
        return 0;
    }
    let pieces = bytes.saturating_add(piece_length.saturating_sub(1)) / piece_length;
    pieces.clamp(1, i32::MAX as u64) as i32
}

fn cap_pieces_by_bytes(pieces: i32, piece_length: u64, max_bytes: u64) -> i32 {
    if pieces <= 0 || max_bytes == 0 {
        return 0;
    }
    pieces.min(pieces_for_bytes(max_bytes, piece_length).max(1))
}

fn hot_byte_cap(ctx: &PriorityContext) -> u64 {
    match ctx.intent {
        PlaybackIntent::DirectInitial if !ctx.first_byte_sent => MAX_STARTUP_WINDOW_BYTES,
        PlaybackIntent::DirectInitial | PlaybackIntent::DirectSeek | PlaybackIntent::DirectSequential => {
            MAX_SEEK_HOT_WINDOW_BYTES
        }
        PlaybackIntent::ContainerMetadata | PlaybackIntent::Background => MAX_CONTAINER_METADATA_WINDOW_BYTES,
    }
}

fn warm_byte_cap(intent: PlaybackIntent) -> u64 {
    match intent {
        PlaybackIntent::DirectInitial | PlaybackIntent::DirectSeek | PlaybackIntent::DirectSequential => {
            MAX_WARM_WINDOW_BYTES
        }
        PlaybackIntent::ContainerMetadata | PlaybackIntent::Background => 0,
    }
}

fn dynamic_hot_window(ctx: &PriorityContext, bitrate_ratio: Option<f64>) -> i32 {
    let mut hot = if let Some(ratio) = bitrate_ratio {
        if ratio >= 3.0 {
            96
        } else if ratio >= 1.5 {
            48
        } else if ratio >= 1.0 {
            32
        } else {
            MIN_SEEK_HOT_PIECES
        }
    } else if ctx.download_rate_bytes_per_sec > 10 * 1024 * 1024 {
        96
    } else if ctx.download_rate_bytes_per_sec > 5 * 1024 * 1024 {
        48
    } else if ctx.download_rate_bytes_per_sec > 1024 * 1024 {
        MIN_SEEK_HOT_PIECES
    } else {
        16
    };

    if let Some(bitrate) = ctx.bitrate_bytes_per_sec.filter(|bitrate| *bitrate > 0) {
        let pieces_for_10s = ((bitrate.saturating_mul(10)) / ctx.piece_length).max(1).min(i32::MAX as u64) as i32;
        hot = hot.max(pieces_for_10s);
    }

    if ctx.peers < 3 {
        hot = hot.min(MIN_SEEK_HOT_PIECES);
    }

    hot
}

fn assignment_for(ctx: &PriorityContext, distance: i32, immediate_pieces: i32, hot_pieces: i32) -> (PriorityBand, i32, i32) {
    let deadline_step = playback_deadline_step_ms(ctx.piece_length, ctx.bitrate_bytes_per_sec, ctx.download_rate_bytes_per_sec);
    match ctx.intent {
        PlaybackIntent::ContainerMetadata => (PriorityBand::Metadata, 7, distance * deadline_step),
        PlaybackIntent::Background => (PriorityBand::Background, 1, 30_000 + distance * deadline_step),
        _ if distance < immediate_pieces => (PriorityBand::Immediate, 7, distance * deadline_step),
        _ if distance < hot_pieces => (PriorityBand::Hot, 4, distance * deadline_step),
        _ => (PriorityBand::Warm, 2, 10_000 + distance * deadline_step),
    }
}

// ---------------------------------------------------------------------------------------------
// Huwa: byte windows materialised by `streaming.rs` with librqbit `FileStream`s.
// ---------------------------------------------------------------------------------------------
//
// The original helper streams (an "immediate" copy of the request head and a 16 MiB tail, one
// set per HTTP request, each alive up to 60 s) were replaced: librqbit interleaves the queues of
// all open streams, so a copy of the head added nothing, a 16 MiB tail took half the priority
// slots from the head at startup, and AVPlayer's burst of small probe requests piled up streams
// (each holding one of librqbit's blocking permits). `streaming.rs` now keeps one read-ahead
// walker per playback and one small tail prefetch, sized below.

/// How far ahead of the playhead the read-ahead walker keeps priority, in bytes.
///
/// Duration is unknown to the engine, so the window is a share of the file: 1/12 is about two
/// minutes of a 24-minute episode at any quality (and more for longer files, up to the cap),
/// which rides out a swarm hiccup or a peer churn. librqbit's own look-ahead is a fixed 32 MiB
/// (≈ 25 s of a 10 Mbit/s remux). Bounded to a quarter of the cache quota. On an unmetered
/// network, beyond the window pieces still download in natural order (the whole selected file is
/// wanted), so this changes the order, not the data usage.
///
/// On a metered network (cellular) the file is *not* selected in librqbit (see
/// `Engine::sync_selection`): only the stream windows download, and the window is ~60–90 s of
/// video: 1/16 of the file (90 s of a 24-minute episode), between 32 MiB (librqbit's own fixed
/// look-ahead of the serving stream, which cannot be made smaller) and 64 MiB.
pub const MIN_READAHEAD_BYTES: u64 = 48 * 1024 * 1024;
pub const MAX_READAHEAD_BYTES: u64 = 256 * 1024 * 1024;
pub const METERED_MIN_READAHEAD_BYTES: u64 = 32 * 1024 * 1024;
pub const METERED_MAX_READAHEAD_BYTES: u64 = 64 * 1024 * 1024;

pub fn readahead_target_bytes(file_size: u64, cache_limit_bytes: u64, metered: bool) -> u64 {
    if metered {
        return (file_size / 16).clamp(METERED_MIN_READAHEAD_BYTES, METERED_MAX_READAHEAD_BYTES).min(file_size);
    }
    let mut target = (file_size / 12).clamp(MIN_READAHEAD_BYTES, MAX_READAHEAD_BYTES);
    if cache_limit_bytes > 0 {
        target = target.min((cache_limit_bytes / 4).max(MIN_STARTUP_BYTES));
    }
    target.min(file_size)
}

/// Bytes at the end of the file prefetched with the head on the first request (container index).
///
/// MKV Cues are tens of KiB; an MP4 `moov` grows with the sample count (≈ 1–3 MiB for an episode,
/// ≈ 5–8 MiB for a feature film). 1/512 of the file, between 1 and 8 MiB, covers both without
/// competing long with the head; the piece granularity rounds it up anyway.
pub const MIN_TAIL_PREFETCH_BYTES: u64 = 1024 * 1024;
pub const MAX_TAIL_PREFETCH_BYTES: u64 = 8 * 1024 * 1024;

pub fn tail_prefetch_bytes(file_size: u64, piece_length: u64) -> u64 {
    if file_size == 0 || piece_length == 0 || file_size <= SMALL_FILE_BYTES / 4 {
        // Tiny files: the head's look-ahead covers the whole file.
        return 0;
    }
    (file_size / 512).clamp(MIN_TAIL_PREFETCH_BYTES, MAX_TAIL_PREFETCH_BYTES).min(file_size)
}

/// What the player reads at the end of the file before its first frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerIndex {
    /// MP4 / MOV: the `moov` (sample tables) may sit at the end; nothing plays without it.
    MoovAtEnd,
    /// Matroska / WebM: mkvmerge writes the Cues and the track statistics Tags after the last
    /// cluster, and mpv's Matroska demuxer reads every SeekHead element it can reach before
    /// playing (it only defers the Cues when they are the *only* element left): one seek to the
    /// end before frame 1, serialized after piece 0. Cues + Tags are tens of KiB.
    MatroskaTail,
    /// Anything else (AVI, TS…): the tail only serves seeking.
    Other,
}

/// Matroska tail fetched with the head. Cues hold ~20 bytes per keyframe (≈ 15 KiB for a
/// 24-minute episode, ≈ 100 KiB for a film) and the statistics Tags a few KiB: the last 256 KiB
/// hold both, i.e. the last piece (two when the file ends just past a piece boundary).
pub const MATROSKA_TAIL_BYTES: u64 = 256 * 1024;

/// Bytes at the end of the file prefetched on the first request, and whether they go with the
/// head (read before the first frame) or only once the head delivered.
pub fn startup_tail_plan(kind: ContainerIndex, file_size: u64, piece_length: u64) -> (u64, bool) {
    let tail = tail_prefetch_bytes(file_size, piece_length);
    match kind {
        ContainerIndex::MoovAtEnd => (tail, true),
        ContainerIndex::MatroskaTail => (tail.min(MATROSKA_TAIL_BYTES), true),
        ContainerIndex::Other => (tail, false),
    }
}

/// What the player reads at the end of the file before its first frame, known from the file's
/// first bytes (`index_need`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexNeed {
    /// Everything from this offset to the end (MP4 `moov` after `mdat`; Matroska elements the
    /// SeekHead places after the first cluster, Tags/Chapters with the Cues).
    From(u64),
    /// Nothing before the first frame (MP4 faststart; Matroska with only the Cues at the end:
    /// mpv defers them to the first seek).
    Nothing,
    /// Not parseable from these bytes: fetch the startup plan (`startup_tail_plan`).
    Unknown,
}

const MKV_EBML: u32 = 0x1A45_DFA3;
const MKV_SEGMENT: u32 = 0x1853_8067;
const MKV_SEEKHEAD: u32 = 0x114D_9B74;
const MKV_SEEK: u32 = 0x4DBB;
const MKV_SEEK_ID: u32 = 0x53AB;
const MKV_SEEK_POSITION: u32 = 0x53AC;
const MKV_CLUSTER: u32 = 0x1F43_B675;
const MKV_CUES: u32 = 0x1C53_BB6B;

/// EBML element ID (1–4 bytes, marker bits kept) at `pos`.
fn ebml_id(b: &[u8], pos: usize) -> Option<(u32, usize)> {
    let first = *b.get(pos)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 4 || pos + len > b.len() {
        return None;
    }
    Some((b[pos..pos + len].iter().fold(0u32, |v, x| (v << 8) | *x as u32), len))
}

/// EBML size (1–8 bytes, marker removed) at `pos`; `None` for "unknown size" (all ones).
fn ebml_size(b: &[u8], pos: usize) -> Option<(Option<u64>, usize)> {
    let first = *b.get(pos)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || pos + len > b.len() {
        return None;
    }
    let mut v = (first as u64) & (0xFF >> len);
    for x in &b[pos + 1..pos + len] {
        v = (v << 8) | *x as u64;
    }
    let unknown = v == (1u64 << (7 * len)) - 1;
    Some(((!unknown).then_some(v), len))
}

fn be_uint(b: &[u8]) -> u64 {
    b.iter().take(8).fold(0u64, |v, x| (v << 8) | *x as u64)
}

/// mpv's Matroska demuxer before frame 1 reads every element its SeekHead points to, but defers
/// the Cues when they are the only one left (`demux_mkv.c`): elements placed after the first
/// cluster (mkvmerge: Cues + statistics Tags at the end) are read at the end of the file.
fn mkv_index_need(head: &[u8], file_len: u64) -> IndexNeed {
    let parse = || -> Option<IndexNeed> {
        let (id, l) = ebml_id(head, 0)?;
        if id != MKV_EBML {
            return None;
        }
        let (size, l2) = ebml_size(head, l)?;
        let mut p = l + l2 + size? as usize;
        let (id, l) = ebml_id(head, p)?;
        if id != MKV_SEGMENT {
            return None;
        }
        let (_, l2) = ebml_size(head, p + l)?;
        p += l + l2;
        let segment = p as u64;
        let mut seeks: Vec<(u32, u64)> = Vec::new();
        let mut first_cluster = None;
        while p < head.len() {
            let (id, l) = ebml_id(head, p)?;
            let (size, l2) = ebml_size(head, p + l)?;
            let data = p + l + l2;
            if id == MKV_CLUSTER {
                first_cluster = Some(p as u64);
                break;
            }
            let size = size? as usize;
            if id == MKV_SEEKHEAD {
                let end = (data + size).min(head.len());
                let mut q = data;
                while q < end {
                    let (sid, sl) = ebml_id(head, q)?;
                    let (ssize, sl2) = ebml_size(head, q + sl)?;
                    let sdata = q + sl + sl2;
                    let ssize = ssize? as usize;
                    if sid == MKV_SEEK {
                        let (mut target, mut pos) = (None, None);
                        let mut r = sdata;
                        while r < (sdata + ssize).min(end) {
                            let (cid, cl) = ebml_id(head, r)?;
                            let (csize, cl2) = ebml_size(head, r + cl)?;
                            let cdata = r + cl + cl2;
                            let csize = csize? as usize;
                            let bytes = head.get(cdata..cdata + csize)?;
                            match cid {
                                MKV_SEEK_ID => target = Some(be_uint(bytes) as u32),
                                MKV_SEEK_POSITION => pos = Some(be_uint(bytes)),
                                _ => {}
                            }
                            r = cdata + csize;
                        }
                        if let (Some(t), Some(at)) = (target, pos) {
                            seeks.push((t, segment + at));
                        }
                    }
                    q = sdata + ssize;
                }
            }
            p = data + size;
        }
        let first_cluster = first_cluster.or_else(|| seeks.iter().find(|(id, _)| *id == MKV_CLUSTER).map(|(_, at)| *at))?;
        let late: Vec<&(u32, u64)> = seeks.iter().filter(|(id, at)| *id != MKV_CLUSTER && *at > first_cluster && *at < file_len).collect();
        if late.iter().all(|(id, _)| *id == MKV_CUES) {
            return Some(IndexNeed::Nothing);
        }
        late.iter().map(|(_, at)| *at).min().map(IndexNeed::From)
    };
    parse().unwrap_or(IndexNeed::Unknown)
}

/// Offset of the first Matroska cluster, from the file's first bytes: the top-level elements are
/// walked by their headers (Attachments — the fonts of a fansub release, often several MiB — sit
/// between the tracks and the first cluster, and mpv reads them all before frame 1). When the next
/// element header lies past `head`, its offset is returned (the clusters start there or later).
pub fn mkv_first_cluster(head: &[u8]) -> Option<u64> {
    let (id, l) = ebml_id(head, 0)?;
    if id != MKV_EBML {
        return None;
    }
    let (size, l2) = ebml_size(head, l)?;
    let mut p = l + l2 + size? as usize;
    let (id, l) = ebml_id(head, p)?;
    if id != MKV_SEGMENT {
        return None;
    }
    let (_, l2) = ebml_size(head, p + l)?;
    p += l + l2;
    loop {
        if p >= head.len() {
            return Some(p as u64);
        }
        let (id, l) = ebml_id(head, p)?;
        if id == MKV_CLUSTER {
            return Some(p as u64);
        }
        let (size, l2) = ebml_size(head, p + l)?;
        p += l + l2 + size? as usize;
    }
}

/// MP4 top-level boxes: `moov` before `mdat` = nothing at the end; `mdat` first = the `moov`
/// right after it, to the end of the file.
fn mp4_index_need(head: &[u8], file_len: u64) -> IndexNeed {
    let mut off = 0u64;
    loop {
        let o = off as usize;
        let Some(h) = head.get(o..o + 8) else { return IndexNeed::Unknown };
        let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        let size = match size32 {
            0 => file_len - off,
            1 => match head.get(o + 8..o + 16) {
                Some(l) => be_uint(l),
                None => return IndexNeed::Unknown,
            },
            s => s,
        };
        if size < 8 {
            return IndexNeed::Unknown;
        }
        match &h[4..8] {
            b"moov" => return IndexNeed::Nothing,
            b"mdat" => {
                let next = off + size;
                return if next < file_len { IndexNeed::From(next) } else { IndexNeed::Unknown };
            }
            _ => off += size,
        }
    }
}

/// What the player reads at the end before frame 1, from the first bytes of the file.
pub fn index_need(kind: ContainerIndex, head: &[u8], file_len: u64) -> IndexNeed {
    match kind {
        ContainerIndex::MoovAtEnd => mp4_index_need(head, file_len),
        ContainerIndex::MatroskaTail => mkv_index_need(head, file_len),
        ContainerIndex::Other => IndexNeed::Unknown,
    }
}

/// Bytes of the head read to plan the container index (`index_need`): the MP4 box headers and
/// the Matroska SeekHead are in the first KiB; one piece arrives anyway for the player.
pub const INDEX_HEAD_BYTES: u64 = 64 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    fn base_context(intent: PlaybackIntent) -> PriorityContext {
        PriorityContext {
            intent,
            current_piece: 100,
            first_piece: 0,
            last_piece: 999,
            piece_length: 1024 * 1024,
            file_size: 1000 * 1024 * 1024,
            bitrate_bytes_per_sec: None,
            download_rate_bytes_per_sec: 2 * 1024 * 1024,
            peers: 10,
            cache_size_bytes: 1024 * 1024 * 1024,
            memory_pressure: MemoryPressure::Normal,
            consecutive_waits: 0,
            first_byte_sent: true,
        }
    }

    #[test]
    fn initial_before_first_byte_is_small() {
        let mut ctx = base_context(PlaybackIntent::DirectInitial);
        ctx.current_piece = 0;
        ctx.first_byte_sent = false;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert!(decision.target_window_pieces >= MIN_STARTUP_PIECES);
        assert!(decision.target_window_pieces <= MAX_STARTUP_PIECES);
        assert_eq!(decision.assignments[0].deadline, 0);
        assert_eq!(decision.assignments[0].piece_priority, 7);
        // 4 MiB startup window with 1 MiB pieces.
        assert_eq!(decision.hot_window_pieces, 4);
    }

    #[test]
    fn initial_after_first_byte_expands() {
        let decision = PlaybackPriorityPolicy::decide(base_context(PlaybackIntent::DirectInitial));
        assert!(decision.hot_window_pieces >= MIN_SEEK_HOT_PIECES);
        assert_eq!(decision.assignments[0].band, PriorityBand::Immediate);
    }

    #[test]
    fn direct_seek_has_minimum_hot_window() {
        let decision = PlaybackPriorityPolicy::decide(base_context(PlaybackIntent::DirectSeek));
        assert!(decision.hot_window_pieces >= MIN_SEEK_HOT_PIECES);
        assert_eq!(decision.immediate_pieces, SEEK_IMMEDIATE_PIECES);
        assert_eq!(decision.assignments[SEEK_IMMEDIATE_PIECES as usize - 1].piece_priority, 7);
        assert_eq!(decision.assignments[SEEK_IMMEDIATE_PIECES as usize].piece_priority, 4);
    }

    #[test]
    fn fast_swarm_expands_seek_window() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.download_rate_bytes_per_sec = 12 * 1024 * 1024;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert!(decision.hot_window_pieces >= 96);
    }

    #[test]
    fn blocked_seek_expands() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.consecutive_waits = 3;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert!(decision.reason.contains("blocked-expand"));
        assert_eq!(decision.immediate_pieces, SEEK_IMMEDIATE_PIECES * 2);
    }

    #[test]
    fn memory_pressure_clamps_window() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.download_rate_bytes_per_sec = 12 * 1024 * 1024;
        ctx.memory_pressure = MemoryPressure::High;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(decision.hot_window_pieces, MIN_SEEK_HOT_PIECES);
        assert_eq!(decision.warm_window_pieces, 0);
    }

    #[test]
    fn few_peers_limit_hot_window() {
        let mut ctx = base_context(PlaybackIntent::DirectSequential);
        ctx.download_rate_bytes_per_sec = 12 * 1024 * 1024;
        ctx.peers = 1;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(decision.hot_window_pieces, MIN_SEEK_HOT_PIECES);
    }

    #[test]
    fn blocking_container_metadata_is_urgent() {
        let decision = PlaybackPriorityPolicy::decide(base_context(PlaybackIntent::ContainerMetadata));
        assert_eq!(decision.assignments[0].piece_priority, 7);
        assert_eq!(decision.assignments[0].deadline, 0);
        assert_eq!(decision.assignments[0].band, PriorityBand::Metadata);
        assert_eq!(decision.warm_window_pieces, 0);
    }

    #[test]
    fn background_is_low_priority() {
        let decision = PlaybackPriorityPolicy::decide(base_context(PlaybackIntent::Background));
        assert!(decision.assignments.iter().all(|a| a.piece_priority <= 1));
        assert_eq!(decision.immediate_pieces, 0);
    }

    #[test]
    fn small_file_metadata_starts_at_final_five_percent() {
        let file_size = 8 * 1024 * 1024;
        assert_eq!(container_metadata_start(file_size), file_size * 95 / 100);
        assert!(!is_container_metadata_request(1024 * 1024, 1024, file_size));
        assert!(is_container_metadata_request(container_metadata_start(file_size), 1024, file_size));
    }

    #[test]
    fn large_file_metadata_starts_at_earlier_of_ten_mib_or_five_percent() {
        // Same rule as stream-server: whichever comes first, 10 MiB before the end or the final 5 %.
        let file_size = 10 * 1024 * 1024 * 1024;
        assert_eq!(container_metadata_start(file_size), file_size * 95 / 100);
        let medium = 100 * 1024 * 1024;
        assert_eq!(container_metadata_start(medium), medium - 10 * 1024 * 1024);
        let start = container_metadata_start(file_size);
        assert!(is_container_metadata_request(start, MAX_CONTAINER_METADATA_WINDOW_BYTES, file_size));
        assert!(!is_container_metadata_request(start, MAX_CONTAINER_METADATA_WINDOW_BYTES + 1, file_size));
        assert!(!is_container_metadata_request(0, 1024, file_size));
    }

    #[test]
    fn seek_window_is_capped_by_bytes_for_large_pieces() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.piece_length = 16 * 1024 * 1024;
        ctx.download_rate_bytes_per_sec = 12 * 1024 * 1024;
        let expected_hot = (MAX_SEEK_HOT_WINDOW_BYTES / ctx.piece_length) as i32;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(decision.hot_window_pieces, expected_hot);
        assert!(decision.reason.contains("byte-cap"));
    }

    #[test]
    fn startup_window_is_capped_by_bytes_for_huge_pieces() {
        let mut ctx = base_context(PlaybackIntent::DirectInitial);
        ctx.current_piece = 0;
        ctx.first_byte_sent = false;
        ctx.piece_length = 64 * 1024 * 1024;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(decision.hot_window_pieces, 1);
    }

    #[test]
    fn cold_seek_only_prioritizes_the_requested_piece() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.first_byte_sent = false;
        ctx.piece_length = 16 * 1024 * 1024;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(decision.assignments.len(), 1);
        assert_eq!(decision.assignments[0].piece_idx, 100);
        assert!(decision.reason.contains("first-piece-only"));
    }

    #[test]
    fn window_never_exceeds_remaining_pieces() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.current_piece = 995;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(decision.hot_window_pieces + decision.warm_window_pieces, 5);
        assert_eq!(decision.assignments.len(), 5);
        assert_eq!(decision.assignments.last().unwrap().piece_idx, 999);
    }

    #[test]
    fn invalid_context_yields_nothing() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.piece_length = 0;
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert!(decision.assignments.is_empty());
        assert_eq!(decision.reason, "invalid-context");
    }

    #[test]
    fn deadlines_track_the_slower_of_playback_and_download_rates() {
        let mut ctx = base_context(PlaybackIntent::DirectSequential);
        ctx.piece_length = 16 * 1024 * 1024;
        ctx.bitrate_bytes_per_sec = Some(8 * 1024 * 1024);
        ctx.download_rate_bytes_per_sec = 32 * 1024 * 1024;
        let step = playback_deadline_step_ms(ctx.piece_length, ctx.bitrate_bytes_per_sec, ctx.download_rate_bytes_per_sec);
        let decision = PlaybackPriorityPolicy::decide(ctx);
        assert_eq!(step, 2_000);
        assert_eq!(decision.assignments[0].deadline, 0);
        assert_eq!(decision.assignments[1].deadline, 2_000);
    }

    #[test]
    fn classify_initial_seek_sequential_metadata() {
        let size = 2 * 1024 * 1024 * 1024;
        assert_eq!(classify_request(0, 1024, size, false, None), PlaybackIntent::DirectInitial);
        assert_eq!(classify_request(0, 1024, size, true, Some(500)), PlaybackIntent::DirectInitial);
        assert_eq!(classify_request(700 * 1024 * 1024, 1024 * 1024, size, true, Some(100)), PlaybackIntent::DirectSeek);
        assert_eq!(classify_request(1_000_000, 1024, size, true, Some(1_000_000)), PlaybackIntent::DirectSequential);
        assert_eq!(classify_request(size - 1024, 1024, size, true, Some(100)), PlaybackIntent::ContainerMetadata);
    }

    #[test]
    fn readahead_is_a_share_of_the_file_within_bounds() {
        let mib = 1024 * 1024;
        // 1.4 GiB episode → 1/12 ≈ 119 MiB.
        let ep = 1400 * mib;
        assert_eq!(readahead_target_bytes(ep, 0, false), ep / 12);
        // Small file → floor, but never more than the file.
        assert_eq!(readahead_target_bytes(300 * mib, 0, false), MIN_READAHEAD_BYTES);
        assert_eq!(readahead_target_bytes(10 * mib, 0, false), 10 * mib);
        // Large file → cap.
        assert_eq!(readahead_target_bytes(20 * 1024 * mib, 0, false), MAX_READAHEAD_BYTES);
        // A small cache quota bounds it.
        assert_eq!(readahead_target_bytes(20 * 1024 * mib, 400 * mib, false), 100 * mib);
    }

    #[test]
    fn metered_readahead_is_about_a_minute_and_a_half() {
        let mib = 1024 * 1024;
        // 350 MiB episode: 1/16 ≈ 22 MiB, raised to the 32 MiB floor (librqbit's own look-ahead).
        assert_eq!(readahead_target_bytes(350 * mib, 0, true), METERED_MIN_READAHEAD_BYTES);
        // 1 GiB, 24 min (≈ 0.7 MiB/s): 64 MiB ≈ 90 s.
        assert_eq!(readahead_target_bytes(1024 * mib, 0, true), 64 * mib);
        // 1.4 GiB / 20 GiB: capped at 64 MiB whatever the size, far below the unmetered window.
        assert_eq!(readahead_target_bytes(1400 * mib, 0, true), METERED_MAX_READAHEAD_BYTES);
        assert_eq!(readahead_target_bytes(20 * 1024 * mib, 0, true), METERED_MAX_READAHEAD_BYTES);
        assert!(readahead_target_bytes(1400 * mib, 0, true) < readahead_target_bytes(1400 * mib, 0, false));
        assert_eq!(readahead_target_bytes(10 * mib, 0, true), 10 * mib);
    }

    #[test]
    fn tail_prefetch_is_small_and_bounded() {
        let mib = 1024 * 1024;
        assert_eq!(tail_prefetch_bytes(0, mib), 0);
        assert_eq!(tail_prefetch_bytes(8 * mib, mib), 0, "tiny file: head covers it");
        assert_eq!(tail_prefetch_bytes(200 * mib, mib), MIN_TAIL_PREFETCH_BYTES);
        assert_eq!(tail_prefetch_bytes(1400 * mib, mib), 1400 * mib / 512);
        assert_eq!(tail_prefetch_bytes(40 * 1024 * mib, mib), MAX_TAIL_PREFETCH_BYTES);
    }

    fn ebml(id: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let idb = id.to_be_bytes();
        let skip = idb.iter().position(|b| *b != 0).unwrap();
        out.extend_from_slice(&idb[skip..]);
        // 8-byte size, like mkvmerge's reserved sizes.
        out.push(0x01);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes()[1..]);
        out.extend_from_slice(payload);
        out
    }

    fn seek(id: u32, pos: u64) -> Vec<u8> {
        let mut body = ebml(MKV_SEEK_ID, &id.to_be_bytes());
        body.extend(ebml(MKV_SEEK_POSITION, &pos.to_be_bytes()));
        ebml(MKV_SEEK, &body)
    }

    /// EBML header, Segment, SeekHead (entries), Info, then a Cluster at `cluster` (segment-relative).
    fn mkv_head(entries: &[(u32, u64)]) -> Vec<u8> {
        let mut seekhead = Vec::new();
        for (id, pos) in entries {
            seekhead.extend(seek(*id, *pos));
        }
        let mut seg = ebml(MKV_SEEKHEAD, &seekhead);
        seg.extend(ebml(0x1549_A966, &[0u8; 20]));
        let cluster_at = seg.len() as u64;
        seg.extend(ebml(MKV_CLUSTER, &[0u8; 64]));
        let mut out = ebml(MKV_EBML, &[0u8; 16]);
        out.extend_from_slice(&MKV_SEGMENT.to_be_bytes());
        out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]); // unknown size
        let segment_start = out.len() as u64;
        out.extend(seg);
        assert!(cluster_at > 0 && segment_start > 0);
        out
    }

    #[test]
    fn matroska_tail_needs_follow_mpv() {
        let len = 1_000_000_000;
        // mkvmerge: Cues and Tags after the clusters → read before frame 1, from the earliest.
        let head = mkv_head(&[(MKV_CUES, 999_000_000), (0x1254_C367, 999_003_000)]);
        match index_need(ContainerIndex::MatroskaTail, &head, len) {
            IndexNeed::From(at) => assert!(at > 999_000_000 && at < 999_000_100, "{at}"),
            other => panic!("{other:?}"),
        }
        // ffmpeg / Cues only at the end: deferred by mpv to the first seek.
        let head = mkv_head(&[(MKV_CUES, 999_000_000), (0x1254_C367, 50)]);
        assert_eq!(index_need(ContainerIndex::MatroskaTail, &head, len), IndexNeed::Nothing);
        // Not Matroska / cut too short: the startup plan.
        assert_eq!(index_need(ContainerIndex::MatroskaTail, b"RIFF....AVI ", len), IndexNeed::Unknown);
        assert_eq!(index_need(ContainerIndex::MatroskaTail, &head[..20], len), IndexNeed::Unknown);
    }

    #[test]
    fn first_cluster_after_the_attachments() {
        // EBML header, Segment, SeekHead, then 6 MiB of attachments: only their header is in the
        // head, the cluster offset comes from its size.
        let mut head = ebml(MKV_EBML, &[0u8; 16]);
        head.extend_from_slice(&MKV_SEGMENT.to_be_bytes());
        head.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        let seg = head.len();
        head.extend(ebml(MKV_SEEKHEAD, &[0u8; 8]));
        let att = head.len();
        head.extend_from_slice(&0x1941_A469u32.to_be_bytes());
        head.push(0x01);
        head.extend_from_slice(&(6u64 << 20).to_be_bytes()[1..]);
        assert_eq!(mkv_first_cluster(&head), Some((att + 12 + (6 << 20)) as u64));
        // No attachments: the cluster itself.
        let mut plain = head[..att].to_vec();
        let cl = plain.len();
        plain.extend(ebml(MKV_CLUSTER, &[0u8; 4]));
        assert_eq!(mkv_first_cluster(&plain), Some(cl as u64));
        assert!(seg > 0);
        assert_eq!(mkv_first_cluster(b"\x00\x00\x00\x20ftypisom"), None);
    }

    #[test]
    fn mp4_moov_at_the_end_or_first() {
        let len = 1_115_809_099u64;
        let mut head = Vec::new();
        head.extend_from_slice(&32u32.to_be_bytes());
        head.extend_from_slice(b"ftypisom");
        head.extend_from_slice(&[0u8; 20]);
        head.extend_from_slice(&8u32.to_be_bytes());
        head.extend_from_slice(b"free");
        let mdat = 1_114_676_020u64;
        head.extend_from_slice(&(mdat as u32).to_be_bytes());
        head.extend_from_slice(b"mdat");
        assert_eq!(index_need(ContainerIndex::MoovAtEnd, &head, len), IndexNeed::From(40 + mdat));
        // 64-bit mdat size.
        let mut big = head[..40].to_vec();
        big.extend_from_slice(&1u32.to_be_bytes());
        big.extend_from_slice(b"mdat");
        big.extend_from_slice(&(mdat + 8).to_be_bytes());
        assert_eq!(index_need(ContainerIndex::MoovAtEnd, &big, len), IndexNeed::From(40 + mdat + 8));
        // faststart: moov before mdat.
        let mut fast = head[..40].to_vec();
        fast.extend_from_slice(&1_133_039u32.to_be_bytes());
        fast.extend_from_slice(b"moov");
        assert_eq!(index_need(ContainerIndex::MoovAtEnd, &fast, len), IndexNeed::Nothing);
        assert_eq!(index_need(ContainerIndex::MoovAtEnd, &head[..12], len), IndexNeed::Unknown);
    }

    #[test]
    fn index_read_before_the_first_frame_goes_with_the_head() {
        let mib = 1024 * 1024;
        // MP4: the whole moov budget, with the head.
        assert_eq!(startup_tail_plan(ContainerIndex::MoovAtEnd, 1400 * mib, 2 * mib), (1400 * mib / 512, true));
        // MKV: only the last MiB (Cues + Tags), but with the head: mpv seeks there before frame 1.
        assert_eq!(startup_tail_plan(ContainerIndex::MatroskaTail, 1400 * mib, 2 * mib), (MATROSKA_TAIL_BYTES, true));
        assert_eq!(startup_tail_plan(ContainerIndex::MatroskaTail, 8 * mib, mib), (0, true), "tiny file: nothing extra");
        // Others: after the head, as before.
        assert_eq!(startup_tail_plan(ContainerIndex::Other, 1400 * mib, 2 * mib), (1400 * mib / 512, false));
    }
}
