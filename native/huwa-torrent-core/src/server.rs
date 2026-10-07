//! Loopback HTTP server for the video player.
//!
//! - `GET /{infoHash}/{fileIdx|auto}` → the file, with `Accept-Ranges`, `Range` → `206`.
//! - `GET /stats.json` → `EngineStats`.
//! - `GET /health` → `ok`.
//!
//! Bound to `127.0.0.1:0` (random port); the port is stored in the engine and part of every URL.

use std::{io::SeekFrom, sync::atomic::Ordering, sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tracing::{debug, warn};

use crate::{
    engine::{Engine, Entry, ServerHandle},
    priorities::{classify_request, ContainerIndex, PlaybackIntent},
    range::{parse_range, RangeSpec},
    streaming::{startup_lookahead, TrackedReader, DEFAULT_LOOKAHEAD_BYTES},
};

/// Body chunk size. librqbit's `FileStream` reads at most up to the end of the current piece per
/// call, each read is one `block_in_place` + `pread`: 256 KiB chunks cut those calls (and the
/// hyper frames) by 4 compared with 64 KiB while staying far below a piece.
const BODY_CHUNK: usize = 256 * 1024;

pub fn router(engine: Arc<Engine>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/stats.json", get(stats))
        .route("/{info_hash}/{file}", get(stream_file))
        .with_state(engine)
}

/// Binds the listener and serves on the engine runtime until `Engine::shutdown`. Returns the port.
pub async fn start(engine: Arc<Engine>) -> anyhow::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    engine.set_port(port);
    let app = router(engine.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = engine.runtime.spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = stopped.await;
        });
        if let Err(e) = serve.await {
            warn!("http server stopped: {e:#}");
        }
    });
    engine.set_server(ServerHandle { stop, task });
    Ok(port)
}

async fn stats(State(engine): State<Arc<Engine>>) -> Response {
    Json(engine.stats()).into_response()
}

fn text(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

pub fn mime_for(name: &str) -> &'static str {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "mp3" => "audio/mpeg",
        "aac" => "audio/aac",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

/// What the player reads at the end of the file before its first frame (see `ContainerIndex`).
pub fn container_index(name: &str) -> ContainerIndex {
    match mime_for(name) {
        "video/mp4" | "video/quicktime" => ContainerIndex::MoovAtEnd,
        "video/x-matroska" | "video/webm" => ContainerIndex::MatroskaTail,
        _ => ContainerIndex::Other,
    }
}

/// The `{file}` path segment: `3`, `3.mkv`, `auto` or `auto.mkv` (the extension only informs the
/// app's player choice, see `Engine::url_for`). `Some(None)` = auto, `None` = malformed.
pub fn parse_file(segment: &str) -> Option<Option<usize>> {
    let idx = segment.split_once('.').map_or(segment, |(i, _)| i);
    if idx == "auto" {
        return Some(None);
    }
    idx.parse::<usize>().ok().map(Some)
}

/// Keeps `active_streams` accurate for the lifetime of a response body.
struct StreamGuard {
    entry: Arc<Entry>,
    end: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.entry.active_streams.fetch_sub(1, Ordering::Relaxed);
        self.entry.last_served_end.store(self.end, Ordering::Relaxed);
        self.entry.touch();
    }
}

/// `AsyncRead` wrapper that owns the guard, so the counter drops with the body.
struct GuardedReader<R> {
    inner: R,
    _guard: StreamGuard,
}

impl<R: AsyncRead + Unpin> AsyncRead for GuardedReader<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let res = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        let n = (buf.filled().len() - before) as u64;
        let entry = &self._guard.entry;
        if entry.timeline.on_bytes(n) {
            // First bytes of this start: how many peers were sending by then.
            let peers = entry.handle().and_then(|h| h.stats().live.map(|l| l.snapshot.peer_stats.live)).unwrap_or(0);
            entry.timeline.set_peers_at_first_byte(peers);
        }
        res
    }
}

async fn stream_file(
    State(engine): State<Arc<Engine>>,
    Path((info_hash, file)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let hex = info_hash.to_lowercase();
    let Some(entry) = engine.entry(&hex) else {
        return text(StatusCode::NOT_FOUND, "unknown torrent");
    };
    entry.touch();
    entry.timeline.on_request();

    let timeout = Duration::from_secs(engine.config().resolve_timeout_secs);
    let deadline = tokio::time::Instant::now() + timeout;
    let handle = match entry.wait_ready(timeout).await {
        Ok(h) => h,
        Err(e) if e.to_string().starts_with("timeout") => return text(StatusCode::GATEWAY_TIMEOUT, e.to_string()),
        Err(e) => return text(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    // Right after the metadata arrives the torrent is still `initializing` (files checked /
    // created), and `FileStream` refuses that state: the first request of every cold start used
    // to get a 503. Wait for it, within the same budget.
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now()).max(Duration::from_secs(5));
    match tokio::time::timeout(remaining, handle.wait_until_initialized()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return text(StatusCode::SERVICE_UNAVAILABLE, format!("torrent failed to initialize: {e:#}")),
        Err(_) => return text(StatusCode::GATEWAY_TIMEOUT, "timeout: torrent still initializing"),
    }

    // Resolve the file index.
    let file_idx = match parse_file(&file) {
        Some(Some(i)) => i,
        Some(None) => match *entry.selected_file.read() {
            Some(i) => i,
            None => return text(StatusCode::NOT_FOUND, "no playable file in torrent"),
        },
        None => return text(StatusCode::BAD_REQUEST, "bad file index"),
    };

    let file_name = handle
        .with_metadata(|m| m.file_infos.get(file_idx).map(|f| f.relative_filename.to_string_lossy().into_owned()))
        .ok()
        .flatten();
    let Some(file_name) = file_name else {
        return text(StatusCode::NOT_FOUND, "file index out of range");
    };

    // Make sure the torrent is running (it may have been paused by the user or on restore).
    if handle.is_paused() {
        if let Err(e) = engine.session.unpause(&handle).await {
            return text(StatusCode::SERVICE_UNAVAILABLE, format!("cannot resume torrent: {e:#}"));
        }
    }

    let mut stream = match handle.clone().stream(file_idx).await {
        Ok(s) => s,
        Err(e) => return text(StatusCode::SERVICE_UNAVAILABLE, format!("cannot open stream: {e:#}")),
    };
    let len = stream.len();

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let spec = parse_range(range_header, len);
    debug!(hex = %hex, file_idx, ?range_header, ?spec, "stream request");

    let mut out = HeaderMap::new();
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime_for(&file_name)));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    let (status, start, end) = match spec {
        RangeSpec::Unsatisfiable => {
            out.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{len}")).unwrap_or(HeaderValue::from_static("bytes */0")),
            );
            return (StatusCode::RANGE_NOT_SATISFIABLE, out).into_response();
        }
        RangeSpec::Full => (StatusCode::OK, 0, len),
        RangeSpec::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
    };
    let to_send = end - start;

    // --- Priorities: classify the request (playback vs container-index probe) and let
    // `streaming` move the read-ahead walker / start the tail prefetch (see streaming.rs).
    let first_byte_sent = entry.first_byte_sent.load(Ordering::Relaxed);
    let last_end = entry.last_served_end.load(Ordering::Relaxed);
    let intent = classify_request(start, to_send, len, first_byte_sent, (last_end > 0).then_some(last_end));
    if intent == PlaybackIntent::ContainerMetadata {
        entry.timeline.on_tail_request();
    }
    let cache_limit = engine.config().cache_limit_bytes;
    let metered = entry.metered.load(Ordering::Relaxed);
    let index = container_index(&file_name);
    // Two answering peers (probe) or connected ones: the container index can come in parallel.
    let parallel = entry.answering.load(Ordering::Relaxed) >= 2 || handle.stats().live.is_some_and(|l| l.snapshot.peer_stats.live >= 2);
    let playback = engine.streaming.on_request(
        &engine.runtime,
        &hex,
        &handle,
        file_idx,
        start,
        intent,
        cache_limit,
        metered,
        index,
        parallel,
    );
    debug!(intent = intent.as_str(), start, to_send, metered, "priority intent");
    // Our stream is registered (opened above): a new window narrows librqbit to the stream queues
    // until its first bytes arrive; metered networks never select the whole file (see streaming.rs).
    let settled = playback.as_ref().is_none_or(|(p, _)| p.settled());
    let quiet = playback.as_ref().is_none_or(|(p, _)| p.settled_for(crate::streaming::QUIET_AFTER_DATA));
    let focused = engine.focus().as_deref() == Some(hex.as_str());
    engine.sync_selection(&entry, &handle, !metered && quiet && focused).await;
    // A window that has not delivered yet: only the pieces the player needs first are asked for,
    // widened back to librqbit's default with the first bytes (see `startup_lookahead`).
    let narrow = matches!(intent, PlaybackIntent::DirectInitial | PlaybackIntent::DirectSeek) && !settled;
    if narrow {
        let piece = playback.as_ref().map_or(0, |(p, _)| p.geometry.piece_len);
        // A single peer serves one piece after the other: the first request asks for its first
        // piece only, so the container index the player reads next (planned from that piece, see
        // `Streaming::on_request`) comes right after it, not after the rest of the 4 MiB.
        let single = intent == PlaybackIntent::DirectInitial && !parallel && index != ContainerIndex::Other;
        stream.set_lookahead(if single { piece.max(1) } else { startup_lookahead(piece) });
    }
    // The player waits for these bytes: the piece it is blocked on is fetched block by block from
    // every peer that has it (vendor/librqbit HUWA_PATCHES.md), starting at the block it needs.
    stream.set_urgent(true);
    // Opening reads (head, container index, resume / seek target), with `unverifiedStart`: blocks
    // are served as soon as written, before their piece's SHA-1 (see `Config::unverified_start`).
    let unverified = engine.config().unverified_start && !quiet && intent != PlaybackIntent::Background;
    if unverified {
        stream.set_unverified(true);
    }

    if start > 0 {
        if let Err(e) = stream.seek(SeekFrom::Start(start)).await {
            return text(StatusCode::INTERNAL_SERVER_ERROR, format!("seek failed: {e}"));
        }
    }

    if let Ok(v) = HeaderValue::from_str(&to_send.to_string()) {
        out.insert(header::CONTENT_LENGTH, v);
    }
    if status == StatusCode::PARTIAL_CONTENT {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end - 1, len)) {
            out.insert(header::CONTENT_RANGE, v);
        }
    }

    entry.active_streams.fetch_add(1, Ordering::Relaxed);
    entry.first_byte_sent.store(true, Ordering::Relaxed);
    let guard = StreamGuard { entry: entry.clone(), end };
    let mut tracked = TrackedReader::new(stream.take(to_send), playback, start);
    if narrow || unverified {
        tracked.on_quiet(Box::new(move |r: &mut tokio::io::Take<librqbit::FileStream>| {
            let s = r.get_mut();
            if narrow {
                s.set_lookahead(DEFAULT_LOOKAHEAD_BYTES);
            }
            s.set_unverified(false);
        }));
    }
    let reader = GuardedReader { inner: tracked, _guard: guard };
    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(reader, BODY_CHUNK));
    (status, out, body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_types() {
        assert_eq!(mime_for("Show.S01E01.mkv"), "video/x-matroska");
        assert_eq!(mime_for("a/b/c.MP4"), "video/mp4");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    #[test]
    fn container_index_read_before_the_first_frame() {
        for n in ["a.mp4", "b.MOV", "c.m4v"] {
            assert_eq!(container_index(n), ContainerIndex::MoovAtEnd, "{n}");
        }
        // mpv reads an mkvmerge file's Cues + Tags (after the last cluster) before playing.
        assert_eq!(container_index("Show - 01.mkv"), ContainerIndex::MatroskaTail);
        assert_eq!(container_index("x.webm"), ContainerIndex::MatroskaTail);
        assert_eq!(container_index("y.avi"), ContainerIndex::Other);
    }

    #[test]
    fn file_segment_with_or_without_extension() {
        assert_eq!(parse_file("3"), Some(Some(3)));
        assert_eq!(parse_file("3.mkv"), Some(Some(3)));
        assert_eq!(parse_file("auto"), Some(None));
        assert_eq!(parse_file("auto.mp4"), Some(None));
        assert_eq!(parse_file("x.mkv"), None);
        assert_eq!(parse_file(""), None);
    }

    #[test]
    fn stream_urls_carry_the_extension_when_known() {
        let h = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(crate::engine::url_of(8080, h, Some(2), Some("mkv")), format!("http://127.0.0.1:8080/{h}/2.mkv"));
        assert_eq!(crate::engine::url_of(8080, h, None, None), format!("http://127.0.0.1:8080/{h}/auto"));
        assert_eq!(crate::engine::video_ext("[Grp] Show - 01 [1080p].MKV"), Some("mkv"));
        assert_eq!(crate::engine::video_ext("readme.txt"), None);
        // Every URL the engine builds is understood by the route.
        for (file, ext) in [(Some(2), Some("mkv")), (Some(0), None), (None, Some("mp4")), (None, None)] {
            let url = crate::engine::url_of(1, h, file, ext);
            let seg = url.rsplit('/').next().unwrap();
            assert_eq!(parse_file(seg), Some(file), "{url}");
        }
    }
}
