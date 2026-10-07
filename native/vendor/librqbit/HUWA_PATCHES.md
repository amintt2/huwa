# librqbit 9.0.1 — Huwa patches

Unmodified copy of the crates.io `librqbit-9.0.1` sources (Apache-2.0, https://github.com/ikatson/rqbit)
minus `webui/` and `resources/` (not compiled without the `webui` / test features), with the
changes below. Every change is marked `Huwa patch` in the code. Measured with
`native/huwa-torrent-core/bench` (see its README).

1. **In-flight pieces survive a re-selection** (`chunk_tracker.rs` `update_only_files_keeping`,
   `piece_tracker.rs` `update_only_files`). Upstream, `update_only_files` requeues every newly
   selected piece it does not have *and clears its chunk bits*, including pieces a peer is
   downloading right now (a `FileStream` downloads unselected pieces). The chunks received so far
   are forgotten, the remaining ones never complete the piece, and the piece stays in flight with
   that peer for ever; the streams' priority list skips in-flight pieces, so the player waited
   until the natural order reached it. Huwa selects the played file again once a window delivered
   its first bytes: every resume / seek / mid-swarm start hit it (resume at 10 min: 40 s+).
2. **Idle peers are woken when the wanted pieces change** (`TorrentStateLive::notify_new_pieces`,
   called from `FileStream` when it opens or moves to another piece, and from `update_only_files`).
   A peer that finds nothing to request sleeps up to 5 s (`new_pieces_notify` was only notified
   on peer death / hash failure): after a seek the new window waited for those sleeps.
3. **Per-stream look-ahead** (`FileStream::set_lookahead`, `StreamState::lookahead`). Upstream
   every stream queues 32 MiB from its position. Huwa narrows the streams that only need a few
   pieces (the player's first request of a window, the anchor, the pre-warm of the head) so the
   first connected peers are not spread over 32 pieces while the player waits for one. Also
   exports `FileStream` (to call it on the server's response streams).
4. **Per-peer request window 64 chunks** (`DEFAULT_PEER_REQUEST_WINDOW`, upstream 128 = 2 MiB in
   flight per peer). Requests already sent cannot be taken back: with 30 peers the downlink held
   seconds of data requested before a seek, and a peer took a second piece (the container index
   the player needs next) before the other peers had a first one. 1 MiB per peer still covers a
   5 MB/s peer at 200 ms RTT. Measured: popular MKV start 2.2 s → 1.0 s, mid resume 9.1 s → 5.1 s.
5. **Urgent pieces shared block by block between peers** (`piece_tracker.rs` `SharedPiece`,
   `acquire_shared`, `claim_chunk`; `FileStream::set_urgent`; `TorrentStreams::urgent_pieces`).
   Upstream a piece is downloaded by one peer: the first piece of a start took
   `piece size / that peer's rate` (16 MiB at 1–3 MB/s: 5–16 s; at 300 KB/s: 56 s) however many
   peers were connected. The pieces an *urgent* stream (a player response) reads next — the one
   it is blocked on, from the block it waits for, then up to 4 MiB of its look-ahead — are split
   into blocks: every peer that has the piece claims at most 4 blocks at a time (8 outstanding),
   so the piece comes at the swarm's aggregate rate, in the reader's order; blocked pieces first,
   the one this peer has the fewest blocks of in flight first (a single peer alternates between
   the head and the container index). A peer at its cap while blocks are still free waits
   (`Busy`) instead of filling its in-order pipeline with other pieces. A block asked from
   another peer 1.5 s ago without an answer may be asked again (endgame, urgent blocks only); the
   same peer re-asks after 5 s. Blocks already written are never requested again; a shared piece
   nobody works on any more goes back to the queue keeping its blocks; any peer may complete a
   shared piece (`write_to_disk`).
6. **Unverified reads** (`FileStream::set_unverified`, `ChunkTracker::downloaded_run`,
   `wake_streams_on_chunk`). A stream allowed to may read the blocks already written of a piece
   not verified yet, from its position on (woken as each block lands). Used by Huwa only for the
   opening reads of a playback (`Config::unverified_start`); a piece failing its SHA-1 is still
   downloaded again, but the bytes already read stay read.
