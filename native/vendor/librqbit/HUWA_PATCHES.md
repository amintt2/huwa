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
