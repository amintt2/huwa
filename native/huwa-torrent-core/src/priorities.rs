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
// interleaved. The policy below therefore decides *windows* (immediate / hot / warm / metadata
// bands in pieces, exactly like the original), and `prefetch_windows` maps the bands that
// librqbit cannot infer from the serving stream alone (startup head, container metadata at the
// end of the file) onto auxiliary `FileStream`s opened by the HTTP server. HLS intents and the
// disk-backed download intents were dropped: Huwa streams directly and caches on disk.

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
// Huwa: mapping of the decision onto librqbit `FileStream`s.
// ---------------------------------------------------------------------------------------------

/// A byte window (relative to the file) that the HTTP server materialises with an auxiliary
/// `FileStream` positioned at `offset` and read for `len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefetchWindow {
    pub offset: u64,
    pub len: u64,
    pub band: PriorityBand,
}

/// Windows the serving stream cannot express by itself:
/// - `Immediate`: the head of the request, bounded to the immediate band (startup ≈ 4 MiB,
///   seek = `SEEK_IMMEDIATE_PIECES`). librqbit already looks 32 MiB ahead of the serving stream,
///   so this only exists to be *read first* by a dedicated helper (it wakes as soon as the first
///   piece lands, which mirrors the "immediate" deadline of the original policy).
/// - `Metadata`: the container index at the end of the file, requested up-front on the initial
///   request so MP4 `moov` / MKV Cues are there when the player asks for them.
pub fn prefetch_windows(decision: &PriorityDecision, ctx: &PriorityContext, request_start: u64) -> Vec<PrefetchWindow> {
    let mut out = Vec::new();
    if ctx.piece_length == 0 || ctx.file_size == 0 {
        return out;
    }

    let immediate_bytes = (decision.immediate_pieces.max(0) as u64).saturating_mul(ctx.piece_length);
    if immediate_bytes > 0 && request_start < ctx.file_size {
        let len = immediate_bytes.min(ctx.file_size - request_start);
        let band = if ctx.intent == PlaybackIntent::ContainerMetadata { PriorityBand::Metadata } else { PriorityBand::Immediate };
        out.push(PrefetchWindow { offset: request_start, len, band });
    }

    if ctx.intent == PlaybackIntent::DirectInitial && !ctx.first_byte_sent {
        // Anchor the window to the end of the file (where `moov` / Cues live), bounded to 16 MiB.
        let meta_start = container_metadata_start(ctx.file_size)
            .max(ctx.file_size.saturating_sub(MAX_CONTAINER_METADATA_WINDOW_BYTES));
        if meta_start > request_start.saturating_add(immediate_bytes) {
            let len = ctx.file_size - meta_start;
            if len > 0 {
                out.push(PrefetchWindow { offset: meta_start, len, band: PriorityBand::Metadata });
            }
        }
    }
    out
}

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
    fn large_file_metadata_starts_ten_mib_before_end() {
        let file_size = 10 * 1024 * 1024 * 1024;
        assert_eq!(container_metadata_start(file_size), file_size - 10 * 1024 * 1024);
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
    fn prefetch_initial_adds_head_and_tail_metadata() {
        let mut ctx = base_context(PlaybackIntent::DirectInitial);
        ctx.current_piece = 0;
        ctx.first_byte_sent = false;
        let decision = PlaybackPriorityPolicy::decide(ctx.clone());
        let windows = prefetch_windows(&decision, &ctx, 0);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0], PrefetchWindow { offset: 0, len: 4 * 1024 * 1024, band: PriorityBand::Immediate });
        assert_eq!(windows[1].band, PriorityBand::Metadata);
        // 1000 MiB file: metadata region starts at 950 MiB, the prefetch keeps the last 16 MiB.
        assert_eq!(windows[1].offset, ctx.file_size - MAX_CONTAINER_METADATA_WINDOW_BYTES);
        assert_eq!(windows[1].len, MAX_CONTAINER_METADATA_WINDOW_BYTES);
        assert_eq!(windows[1].offset + windows[1].len, ctx.file_size);
    }

    #[test]
    fn prefetch_seek_is_head_only() {
        let ctx = base_context(PlaybackIntent::DirectSeek);
        let decision = PlaybackPriorityPolicy::decide(ctx.clone());
        let windows = prefetch_windows(&decision, &ctx, 100 * 1024 * 1024);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].offset, 100 * 1024 * 1024);
        assert_eq!(windows[0].len, SEEK_IMMEDIATE_PIECES as u64 * 1024 * 1024);
    }

    #[test]
    fn prefetch_is_clamped_to_file_end() {
        let mut ctx = base_context(PlaybackIntent::DirectSeek);
        ctx.current_piece = 999;
        let decision = PlaybackPriorityPolicy::decide(ctx.clone());
        let start = ctx.file_size - 100;
        let windows = prefetch_windows(&decision, &ctx, start);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].len, 100);
    }

    #[test]
    fn prefetch_small_file_skips_tail_when_head_covers_it() {
        let mut ctx = base_context(PlaybackIntent::DirectInitial);
        ctx.current_piece = 0;
        ctx.first_byte_sent = false;
        ctx.file_size = 3 * 1024 * 1024;
        ctx.last_piece = 2;
        let decision = PlaybackPriorityPolicy::decide(ctx.clone());
        let windows = prefetch_windows(&decision, &ctx, 0);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].band, PriorityBand::Immediate);
    }
}
