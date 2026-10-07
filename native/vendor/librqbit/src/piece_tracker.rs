//! Coordinates piece download state by wrapping ChunkTracker with inflight piece tracking.
//!
//! This module provides the [`PieceTracker`] type which encapsulates the relationship between
//! queued pieces (in ChunkTracker) and in-flight pieces (being downloaded by a peer).
//!
//! The key invariant maintained is: a piece is in exactly one state at any time:
//! - HAVE (completed)
//! - QUEUED (available to download)
//! - IN_FLIGHT (currently being downloaded)
//! - NOT_NEEDED (not selected for download)

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use buffers::ByteBuf;
use librqbit_core::lengths::ValidPieceIndex;
use peer_binary_protocol::Piece;

use crate::{
    chunk_tracker::{ChunkMarkingResult, ChunkTracker},
    file_info::FileInfo,
    type_aliases::{FileInfos, FilePriorities, PeerHandle},
};

/// Tracks a piece currently being downloaded.
#[derive(Debug, Clone)]
pub struct InflightPiece {
    pub peer: PeerHandle,
    pub started: Instant,
}

/// Huwa patch: an urgent piece (a stream is blocked on it) downloaded block by block by every
/// peer that has it, instead of one peer for the whole piece. Per chunk: who asked for it, when.
#[derive(Debug, Clone)]
pub struct SharedPiece {
    claims: Vec<Option<(PeerHandle, Instant)>>,
    /// Where its reader was when it became shared: the rest of the piece is fetched from there.
    from: u32,
}

/// Chunks a peer takes from a shared piece at a time (128 KiB): faster peers come back sooner and
/// take more, so a piece splits across peers in proportion to their speed.
pub const SHARED_CLAIM_BATCH: usize = 4;
/// Blocks of one shared piece a peer may have outstanding (256 KiB: more than a mobile
/// bandwidth-delay product per peer).
pub const SHARED_PEER_CAP: usize = 8;
/// A block asked from this same peer this long ago is asked again (the request was lost).
pub const SHARED_OWN_RETRY_AFTER: Duration = Duration::from_secs(5);
/// A chunk asked from a peer this long ago without an answer may be asked from another one too
/// (endgame: duplicates only for the late blocks of an urgent piece).
pub const SHARED_DUP_AFTER: Duration = Duration::from_millis(1500);

/// An urgent piece and the chunk its stream waits for (claims start there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UrgentPiece {
    pub piece: ValidPieceIndex,
    pub from_chunk: u32,
    /// A stream is blocked on it right now (else: it reads it next).
    pub blocked: bool,
}

/// Result of attempting to acquire a piece.
#[derive(Debug)]
pub enum AcquireResult {
    /// Huwa patch: chunks of an urgent shared piece, claimed for this peer.
    Shared { piece: ValidPieceIndex, chunks: Vec<u32> },
    /// Huwa patch: wait for this peer's outstanding urgent blocks before anything else.
    Busy,
    /// A new piece was reserved from the queue.
    Reserved(ValidPieceIndex),
    /// A piece was stolen from a slower peer.
    Stolen {
        piece: ValidPieceIndex,
        from_peer: PeerHandle,
    },
    /// No pieces are available for this peer.
    NoneAvailable,
}

/// Parameters for acquiring a piece.
pub struct AcquireRequest<'a, I, P, S>
where
    I: Iterator<Item = ValidPieceIndex>,
    P: Fn(ValidPieceIndex) -> bool,
    S: Fn(ValidPieceIndex) -> bool,
{
    /// The peer requesting a piece.
    pub peer: PeerHandle,
    /// The peer's average piece download time (for steal calculations).
    pub peer_avg_time: Option<Duration>,
    /// Priority pieces to check first (e.g., for streaming).
    pub priority_pieces: I,
    /// File download priority ordering.
    pub file_priorities: &'a FilePriorities,
    /// File metadata for iterating pieces.
    pub file_infos: &'a FileInfos,
    /// Returns true if the peer has the given piece.
    pub peer_has_piece: P,
    /// Returns true if the piece can be stolen (e.g., not locked for writing).
    pub can_steal: S,
    /// Huwa patch: pieces streams are blocked on, in order (see `SharedPiece`).
    pub urgent: Vec<UrgentPiece>,
}

/// Coordinates piece download state.
///
/// Wraps a [`ChunkTracker`] with tracking of which pieces are currently being downloaded
/// (in-flight) and by which peer. This ensures that:
///
/// - A piece is only assigned to one peer at a time (unless stolen)
/// - Pieces are properly requeued when a peer dies
/// - State transitions maintain invariants
pub struct PieceTracker {
    chunks: ChunkTracker,
    inflight: HashMap<ValidPieceIndex, InflightPiece>,
    /// Huwa patch: in-flight pieces downloaded by several peers (subset of `inflight`).
    shared: HashMap<ValidPieceIndex, SharedPiece>,
}

impl PieceTracker {
    // === CONSTRUCTION ===

    /// Create a new PieceTracker wrapping the given ChunkTracker.
    pub fn new(chunks: ChunkTracker) -> Self {
        Self {
            chunks,
            inflight: HashMap::new(),
            shared: HashMap::new(),
        }
    }

    /// Read-only access to the underlying ChunkTracker.
    pub fn chunks(&self) -> &ChunkTracker {
        &self.chunks
    }

    /// Consume the PieceTracker, requeuing any in-flight pieces.
    ///
    /// This is used when pausing a torrent - any pieces that were being downloaded
    /// need to be put back in the queue so they can be re-downloaded on resume.
    pub fn into_chunks(mut self) -> ChunkTracker {
        self.shared.clear();
        // Requeue all in-flight pieces so they'll be re-downloaded on resume
        for piece in self.inflight.into_keys() {
            self.chunks.mark_piece_broken_if_not_have(piece);
        }
        self.chunks
    }

    // === PIECE ACQUISITION ===

    /// Attempt to acquire a piece for the requesting peer.
    ///
    /// The acquisition strategy is:
    /// 1. Try to steal a piece from a peer that's 10x slower
    /// 2. Try to reserve a piece from the queue (priority pieces first)
    /// 3. Try to steal a piece from a peer that's 3x slower
    ///
    /// If `Stolen` is returned, the caller MUST call `peers.on_steal()` to notify
    /// the old peer and update counters.
    pub fn acquire_piece<I, P, S>(&mut self, mut req: AcquireRequest<I, P, S>) -> AcquireResult
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        // 0. Huwa patch: a block of a piece a stream is blocked on, shared with the other peers.
        if let Some(result) = self.acquire_shared(&req) {
            return result;
        }

        // 1. Try steal with 10x threshold (very slow peer)
        if let Some(result) = self.try_steal(&req, 10.0) {
            return result;
        }

        // 2. Try reserve from priority_pieces then queued pieces
        // First check priority pieces that aren't already downloaded or in-flight
        for piece in &mut req.priority_pieces {
            if !self.chunks.is_piece_have(piece)
                && !self.inflight.contains_key(&piece)
                && (req.peer_has_piece)(piece)
            {
                return self.reserve_piece(piece, req.peer);
            }
        }

        // Then check naturally ordered queued pieces
        // Note: iter_queued_pieces only returns pieces in queue_pieces (not in-flight)
        let queued: Vec<_> = self
            .chunks
            .iter_queued_pieces(req.file_priorities, req.file_infos)
            .collect();

        for piece in queued {
            if (req.peer_has_piece)(piece) {
                return self.reserve_piece(piece, req.peer);
            }
        }

        // 3. Try steal with 3x threshold (moderately slow peer)
        if let Some(result) = self.try_steal(&req, 3.0) {
            return result;
        }

        AcquireResult::NoneAvailable
    }

    /// Huwa patch: blocks of urgent pieces, shared between peers (the piece is in flight with
    /// every peer that has it). In order:
    /// 1. the blocks a blocked stream needs: from the block it waits for to the end of its piece;
    /// 2. the other missing blocks of shared pieces (before the reader's position, or a piece the
    ///    reader left for a moment): a shared piece is in flight, nobody else would complete it;
    /// then the regular choice. A peer holds at most `SHARED_PEER_CAP` outstanding blocks of a
    /// piece; `Busy` when it is at the cap while blocks of it are still unclaimed: it waits for one
    /// of its blocks instead of filling its (in-order) pipeline with other pieces.
    fn acquire_shared<I, P, S>(&mut self, req: &AcquireRequest<I, P, S>) -> Option<AcquireResult>
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        struct Cand {
            piece: ValidPieceIndex,
            n: usize,
            /// 0: a stream is blocked on it, 1: read next, 2: the rest of a shared piece.
            group: u8,
            mine: usize,
            /// Missing blocks nobody asked for, then the ones whose request looks lost or slow.
            free: Vec<u32>,
            stale: Vec<u32>,
        }
        let now = Instant::now();
        let mut orders: Vec<(ValidPieceIndex, u8, Vec<usize>)> = Vec::new();
        for u in &req.urgent {
            let n = self.chunks.get_lengths().chunks_per_piece(u.piece) as usize;
            orders.push((u.piece, if u.blocked { 0 } else { 1 }, (u.from_chunk as usize..n).collect()));
        }
        let mut shared: Vec<(ValidPieceIndex, u32)> = self.shared.iter().map(|(p, e)| (*p, e.from)).collect();
        shared.sort_by_key(|(p, _)| p.get());
        for (piece, from) in shared {
            let n = self.chunks.get_lengths().chunks_per_piece(piece) as usize;
            orders.push((piece, 2, (0..n).map(|k| (from as usize + k) % n).collect()));
        }
        let mut cands: Vec<Cand> = Vec::new();
        for (piece, group, order) in orders {
            if self.chunks.is_piece_have(piece) || !(req.peer_has_piece)(piece) {
                continue;
            }
            let n = self.chunks.get_lengths().chunks_per_piece(piece) as usize;
            if n == 0 {
                continue;
            }
            let entry = self.shared.get(&piece);
            let claim_of = |i: usize| entry.and_then(|e| e.claims.get(i).copied().flatten());
            let missing = |i: usize| !self.chunks.is_chunk_downloaded(piece, i as u32);
            // A claim is live while recent: another peer's for `SHARED_DUP_AFTER`, our own longer
            // (a request of ours is not lost because the peer is slow).
            let live = |i: usize| {
                claim_of(i).is_some_and(|(p, at)| {
                    now.duration_since(at) < if p == req.peer { SHARED_OWN_RETRY_AFTER } else { SHARED_DUP_AFTER }
                })
            };
            let mine = (0..n).filter(|i| missing(*i) && live(*i) && claim_of(*i).is_some_and(|(p, _)| p == req.peer)).count();
            let free = order.iter().copied().filter(|i| missing(*i) && claim_of(*i).is_none()).map(|i| i as u32).collect();
            let stale = order.iter().copied().filter(|i| missing(*i) && claim_of(*i).is_some() && !live(*i)).map(|i| i as u32).collect();
            if cands.iter().any(|c| c.piece == piece) {
                continue;
            }
            cands.push(Cand { piece, n, group, mine, free, stale });
        }
        // Blocked pieces first, the one this peer has the fewest blocks of in flight (a single peer
        // alternates between the head and the container index instead of finishing one first);
        // then in order. At the cap with blocks still free: `Busy` (wait, take nothing else).
        let pick = {
            let mut blocked: Vec<&Cand> = cands.iter().filter(|c| c.group == 0 && (!c.free.is_empty() || !c.stale.is_empty())).collect();
            blocked.sort_by_key(|c| c.mine);
            let rest = cands.iter().filter(|c| c.group != 0 && (!c.free.is_empty() || !c.stale.is_empty()));
            blocked.into_iter().chain(rest).next()
        }?;
        if pick.mine >= SHARED_PEER_CAP {
            return Some(AcquireResult::Busy);
        }
        let room = (SHARED_PEER_CAP - pick.mine).min(SHARED_CLAIM_BATCH);
        let picked: Vec<u32> = if !pick.free.is_empty() { pick.free.iter().copied().take(room).collect() } else { pick.stale.iter().copied().take(room).collect() };
        let (piece, n) = (pick.piece, pick.n);
        if !self.inflight.contains_key(&piece) {
            self.chunks.reserve_needed_piece(piece);
            self.inflight.insert(piece, InflightPiece { peer: req.peer, started: now });
        }
        let from = picked[0];
        let entry = self.shared.entry(piece).or_insert_with(|| SharedPiece { claims: vec![None; n], from });
        for c in &picked {
            entry.claims[*c as usize] = Some((req.peer, now));
        }
        Some(AcquireResult::Shared { piece, chunks: picked })
    }

    /// Huwa patch: may `peer` request chunk `chunk` of `piece` now? Never a chunk already written;
    /// for a shared piece, not one another peer asked for recently (the claim is taken).
    pub fn claim_chunk(&mut self, piece: ValidPieceIndex, chunk: u32, peer: PeerHandle) -> bool {
        if self.chunks.is_chunk_downloaded(piece, chunk) {
            return false;
        }
        let Some(entry) = self.shared.get_mut(&piece) else { return true };
        let Some(slot) = entry.claims.get_mut(chunk as usize) else { return true };
        let now = Instant::now();
        match slot {
            Some((p, at)) if *p != peer && now.duration_since(*at) < SHARED_DUP_AFTER => false,
            _ => {
                *slot = Some((peer, now));
                true
            }
        }
    }

    /// Huwa patch: `piece` is being downloaded by several peers.
    pub fn is_shared(&self, piece: ValidPieceIndex) -> bool {
        self.shared.contains_key(&piece)
    }

    /// Reserve a piece: remove from queue, add to inflight.
    fn reserve_piece(&mut self, piece: ValidPieceIndex, peer: PeerHandle) -> AcquireResult {
        self.chunks.reserve_needed_piece(piece);
        self.inflight.insert(
            piece,
            InflightPiece {
                peer,
                started: Instant::now(),
            },
        );
        AcquireResult::Reserved(piece)
    }

    /// Try to steal a piece from a slower peer.
    fn try_steal<I, P, S>(
        &mut self,
        req: &AcquireRequest<I, P, S>,
        threshold: f64,
    ) -> Option<AcquireResult>
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        let my_avg = req.peer_avg_time?;
        let min_elapsed = Duration::from_secs_f64(my_avg.as_secs_f64() * threshold);

        // Find the slowest piece from another peer that exceeds threshold
        // and that the stealing peer actually has (can download)
        let (piece, old_peer, _) = self
            .inflight
            .iter()
            .filter(|(_, info)| info.peer != req.peer)
            // Huwa patch: a shared piece already has every peer on it.
            .filter(|(p, _)| !self.shared.contains_key(*p))
            .filter(|(p, _)| (req.peer_has_piece)(**p))
            .map(|(p, info)| (*p, info.peer, info.started.elapsed()))
            .filter(|(_, _, elapsed)| *elapsed >= min_elapsed)
            .max_by_key(|(_, _, elapsed)| *elapsed)?;

        // Check can_steal (e.g., per_piece_lock)
        if !(req.can_steal)(piece) {
            return None;
        }

        // Update ownership (piece stays in inflight, just changes owner)
        let info = self.inflight.get_mut(&piece)?;
        info.peer = req.peer;
        info.started = Instant::now();

        Some(AcquireResult::Stolen {
            piece,
            from_peer: old_peer,
        })
    }

    // === PIECE COMPLETION ===

    /// Remove piece from inflight tracking (e.g., after all chunks received).
    ///
    /// Returns download duration if piece was in-flight.
    /// Note: Does NOT mark the piece as downloaded - caller should do hash check
    /// and then call `mark_piece_hash_ok` or `mark_piece_hash_failed`.
    pub fn take_inflight(&mut self, piece: ValidPieceIndex) -> Option<Duration> {
        self.shared.remove(&piece);
        let inflight = self.inflight.remove(&piece)?;
        Some(inflight.started.elapsed())
    }

    /// Mark piece as downloaded after successful hash verification.
    pub fn mark_piece_hash_ok(&mut self, piece: ValidPieceIndex) {
        self.chunks.mark_piece_downloaded(piece);
    }

    /// Mark piece as failed after hash verification failure - requeues the piece.
    pub fn mark_piece_hash_failed(&mut self, piece: ValidPieceIndex) {
        self.shared.remove(&piece);
        self.chunks.mark_piece_broken_if_not_have(piece);
    }

    /// Release all pieces owned by a peer (on peer death).
    ///
    /// Moves all pieces owned by the peer from IN_FLIGHT back to QUEUED.
    /// Returns the number of pieces released.
    pub fn release_pieces_owned_by(&mut self, peer: PeerHandle) -> usize {
        // Huwa patch: shared pieces lose this peer's claims (others take them over at once); one
        // nobody works on any more goes back to the queue keeping the blocks already written.
        let mut orphans = Vec::new();
        for (piece, entry) in self.shared.iter_mut() {
            for slot in entry.claims.iter_mut() {
                if slot.is_some_and(|(p, _)| p == peer) {
                    *slot = None;
                }
            }
            if entry.claims.iter().all(|c| c.is_none()) {
                orphans.push(*piece);
            }
        }
        for piece in &orphans {
            self.shared.remove(piece);
            self.inflight.remove(piece);
            self.chunks.requeue_keep_chunks(*piece);
        }
        // Collect pieces to release (can't modify while iterating)
        let pieces_to_release: Vec<_> = self
            .inflight
            .iter()
            .filter(|(p, info)| info.peer == peer && !self.shared.contains_key(*p))
            .map(|(p, _)| *p)
            .collect();

        let count = pieces_to_release.len() + orphans.len();
        for piece in pieces_to_release {
            self.inflight.remove(&piece);
            self.chunks.mark_piece_broken_if_not_have(piece);
        }
        count
    }

    // === QUERIES ===

    /// Get the inflight info for a piece, if it's currently being downloaded.
    pub fn get_inflight(&self, piece: ValidPieceIndex) -> Option<&InflightPiece> {
        self.inflight.get(&piece)
    }

    /// Check if a piece is currently in-flight.
    #[allow(dead_code)]
    pub fn is_inflight(&self, piece: ValidPieceIndex) -> bool {
        self.inflight.contains_key(&piece)
    }

    /// Get the number of pieces currently in-flight.
    #[allow(dead_code)]
    pub fn inflight_count(&self) -> usize {
        self.inflight.len()
    }

    // === PASS-THROUGH METHODS ===

    /// Mark a chunk as downloaded. Returns the result indicating if the piece is complete.
    pub fn mark_chunk_downloaded(
        &mut self,
        piece: &Piece<ByteBuf<'_>>,
    ) -> Option<ChunkMarkingResult> {
        self.chunks.mark_chunk_downloaded(piece)
    }

    /// Update which files are selected for download.
    pub fn update_only_files(
        &mut self,
        file_infos: &FileInfos,
        new_only_files: &HashSet<usize>,
    ) -> anyhow::Result<crate::chunk_tracker::HaveNeededSelected> {
        // Huwa patch: pieces in flight keep their chunks and their peer (see
        // `ChunkTracker::update_only_files_keeping`).
        let inflight = &self.inflight;
        let lengths = *self.chunks.get_lengths();
        self.chunks.update_only_files_keeping(file_infos, new_only_files, &|idx| {
            u32::try_from(idx)
                .ok()
                .and_then(|i| lengths.validate_piece_index(i))
                .is_some_and(|p| inflight.contains_key(&p))
        })
    }

    /// Update per-file have bytes when a piece completes. Returns remaining bytes for the file.
    pub fn update_file_have_on_piece_completed(
        &mut self,
        piece_id: ValidPieceIndex,
        file_id: usize,
        file_info: &FileInfo,
    ) -> u64 {
        self.chunks
            .update_file_have_on_piece_completed(piece_id, file_id, file_info)
    }

    /// Flush the have pieces bitfield to disk.
    pub fn flush_have_pieces(&mut self, flush_async: bool) -> anyhow::Result<()> {
        self.chunks.get_have_pieces_mut().flush(flush_async)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bitv::BitV as BitVTrait, type_aliases::BF};
    use librqbit_core::lengths::Lengths;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn peer(id: u8) -> PeerHandle {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, id)), 6881)
    }

    /// Create a simple ChunkTracker for testing.
    /// Creates a torrent with the specified number of pieces, all selected.
    fn make_test_chunk_tracker(num_pieces: u32) -> ChunkTracker {
        // Create a simple single-file torrent
        let piece_length = 16384u32; // 16KB pieces
        let total_length = piece_length as u64 * num_pieces as u64;

        let lengths = Lengths::new(total_length, piece_length).unwrap();

        let bf_len = lengths.piece_bitfield_bytes();

        // No pieces downloaded yet (empty have)
        let have = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());

        // All pieces selected
        let mut selected = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        for i in 0..num_pieces as usize {
            selected.set(i, true);
        }

        // Single file spanning all pieces
        let file_infos = vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: total_length,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }];

        ChunkTracker::new(have.into_dyn(), selected, lengths, &file_infos).unwrap()
    }

    fn make_test_file_infos(num_pieces: u32) -> FileInfos {
        let piece_length = 16384u64;
        vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: piece_length * num_pieces as u64,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }]
    }

    fn make_default_file_priorities(file_infos: &FileInfos) -> FilePriorities {
        (0..file_infos.len()).collect()
    }

    #[test]
    fn test_new_piece_tracker() {
        let chunks = make_test_chunk_tracker(10);
        let tracker = PieceTracker::new(chunks);
        assert_eq!(tracker.inflight_count(), 0);
    }

    #[test]
    fn test_reserve_piece_from_queue() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true, // Peer has all pieces
            can_steal: |_| true,
        });

        // Should reserve piece 0 (first in queue)
        match result {
            AcquireResult::Reserved(piece) => {
                assert_eq!(piece.get(), 0);
                assert!(tracker.is_inflight(piece));
                assert_eq!(tracker.inflight_count(), 1);
            }
            _ => panic!("Expected Reserved, got {:?}", result),
        }
    }

    #[test]
    fn test_reserve_filters_by_peer_has_piece() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Peer only has piece 2 and later
        // Note: iter_queued_pieces iterates in order: first, last, middle
        // So for 0..5: 0, 4, 1, 2, 3
        // With filter >= 2, we get 4 first (skips 0, takes 4)
        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p.get() >= 2,
            can_steal: |_| true,
        });

        match result {
            AcquireResult::Reserved(piece) => {
                // Got piece 4 (first one peer has in iteration order)
                assert!(piece.get() >= 2, "Should have gotten a piece >= 2");
            }
            _ => panic!("Expected Reserved, got {:?}", result),
        }
    }

    #[test]
    fn test_complete_piece() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve a piece first
        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        let piece = match result {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        // Complete the piece (take_inflight + hash check + mark_piece_hash_ok)
        let duration = tracker.take_inflight(piece);
        assert!(duration.is_some());
        assert!(!tracker.is_inflight(piece));
        // Simulate successful hash check
        tracker.mark_piece_hash_ok(piece);
        assert!(tracker.chunks().is_piece_have(piece));
    }

    #[test]
    fn test_fail_piece_requeues() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve piece 0
        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        let piece = match result {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        assert!(tracker.is_inflight(piece));

        // Fail the piece (take_inflight + hash check fails + mark_piece_hash_failed)
        let duration = tracker.take_inflight(piece);
        assert!(duration.is_some());
        // Simulate failed hash check
        tracker.mark_piece_hash_failed(piece);

        // Should no longer be in-flight
        assert!(!tracker.is_inflight(piece));
        // Should not be in have
        assert!(!tracker.chunks().is_piece_have(piece));
        // Should be back in queue - verify by trying to reserve it again
        let result2 = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(2),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p == piece, // Only has the failed piece
            can_steal: |_| true,
        });

        match result2 {
            AcquireResult::Reserved(p) => assert_eq!(p, piece),
            _ => panic!("Expected piece to be re-reservable after fail"),
        }
    }

    #[test]
    fn test_release_pieces_owned_by_peer() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let peer_a = peer(1);
        let peer_b = peer(2);

        // Peer A reserves first two pieces (order: 0, 4, 1, 2, 3)
        // So peer A gets pieces 0 and 4
        let piece_a1 = match tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };
        let piece_a2 = match tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        // Peer B reserves next piece
        let piece_b = match tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer_b,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        assert_eq!(tracker.inflight_count(), 3);
        assert!(tracker.is_inflight(piece_a1));
        assert!(tracker.is_inflight(piece_a2));
        assert!(tracker.is_inflight(piece_b));

        // Peer A dies
        let released = tracker.release_pieces_owned_by(peer_a);
        assert_eq!(released, 2);
        assert_eq!(tracker.inflight_count(), 1); // Only peer B's piece remains

        // Verify peer B's piece is still in-flight
        assert!(tracker.is_inflight(piece_b));
        // Verify peer A's pieces are no longer in-flight
        assert!(!tracker.is_inflight(piece_a1));
        assert!(!tracker.is_inflight(piece_a2));
    }

    #[test]
    fn test_into_chunks_requeues_inflight() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve pieces 0 and 1
        tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });
        tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        assert_eq!(tracker.inflight_count(), 2);

        // Convert back to chunks (simulates pause)
        let chunks = tracker.into_chunks();

        // Create a new tracker and verify pieces are back in queue
        let mut new_tracker = PieceTracker::new(chunks);
        let result = new_tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(2),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        // Should get piece 0 again (was requeued)
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 0),
            _ => panic!("Expected to reserve piece 0 after into_chunks"),
        }
    }

    #[test]
    fn test_priority_pieces_checked_first() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Priority pieces: piece 3, then piece 2
        let piece3 = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(3)
            .unwrap();
        let piece2 = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(2)
            .unwrap();
        let priority = vec![piece3, piece2];

        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: priority.into_iter(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        // Should get piece 3 (first priority piece)
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 3),
            _ => panic!("Expected Reserved(3), got {:?}", result),
        }
    }

    #[test]
    fn test_none_available_when_no_pieces() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Peer has no pieces
        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| false, // Peer has nothing
            can_steal: |_| true,
        });

        match result {
            AcquireResult::NoneAvailable => {}
            _ => panic!("Expected NoneAvailable, got {:?}", result),
        }
    }

    #[test]
    fn test_take_inflight_nonexistent_piece_returns_none() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);
        let piece = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(0)
            .unwrap();

        // Try to take a piece that's not in-flight
        let result = tracker.take_inflight(piece);
        assert!(result.is_none());
    }

    #[test]
    fn test_steal_only_pieces_peer_has() {
        // This test verifies the fix for a bug where try_steal didn't check
        // if the stealing peer actually has the piece in their bitfield.
        // Without this check, a peer could "steal" a piece they can't download,
        // leaving it stuck in inflight forever.

        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let peer_a = peer(1);
        let peer_b = peer(2);

        // Peer A reserves pieces 0 and 4 (first two in iteration order)
        let piece_0 = match tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => {
                assert_eq!(p.get(), 0);
                p
            }
            _ => panic!("Expected Reserved"),
        };

        let piece_4 = match tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => {
                assert_eq!(p.get(), 4);
                p
            }
            _ => panic!("Expected Reserved"),
        };

        // Sleep briefly so pieces become stealable
        std::thread::sleep(Duration::from_millis(5));

        // Peer B tries to acquire with:
        // - Very short avg_time (1ms) so 3x threshold = 3ms < 5ms elapsed
        // - peer_has_piece returns true ONLY for piece 4, NOT piece 0
        let result = tracker.acquire_piece(AcquireRequest {
            urgent: Vec::new(),
            peer: peer_b,
            peer_avg_time: Some(Duration::from_millis(1)),
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p.get() == 4, // Peer B only has piece 4
            can_steal: |_| true,
        });

        // Should steal piece 4 (which peer B has), NOT piece 0 (which peer B doesn't have)
        match result {
            AcquireResult::Stolen { piece, from_peer } => {
                assert_eq!(piece, piece_4, "Should steal piece 4 (the one peer B has)");
                assert_eq!(from_peer, peer_a);
                // Verify piece 0 is still owned by peer A (wasn't stolen)
                assert_eq!(tracker.get_inflight(piece_0).unwrap().peer, peer_a);
            }
            _ => panic!("Expected Stolen, got {:?}", result),
        }
    }
}
