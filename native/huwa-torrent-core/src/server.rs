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
    engine::{Engine, Entry, ManagedTorrentHandle},
    priorities::{
        classify_request, prefetch_windows, MemoryPressure, PlaybackIntent, PlaybackPriorityPolicy, PriorityContext,
    },
    range::{parse_range, RangeSpec},
};

pub fn router(engine: Arc<Engine>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/stats.json", get(stats))
        .route("/{info_hash}/{file}", get(stream_file))
        .with_state(engine)
}

/// Binds the listener and serves forever on the engine runtime. Returns the port.
pub async fn start(engine: Arc<Engine>) -> anyhow::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    engine.set_port(port);
    let app = router(engine.clone());
    engine.runtime.spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            warn!("http server stopped: {e:#}");
        }
    });
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
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
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

    let timeout = Duration::from_secs(engine.config().resolve_timeout_secs);
    let handle = match entry.wait_ready(timeout).await {
        Ok(h) => h,
        Err(e) if e.to_string().starts_with("timeout") => return text(StatusCode::GATEWAY_TIMEOUT, e.to_string()),
        Err(e) => return text(StatusCode::BAD_GATEWAY, e.to_string()),
    };

    // Resolve the file index.
    let file_idx = if file == "auto" {
        match *entry.selected_file.read() {
            Some(i) => i,
            None => return text(StatusCode::NOT_FOUND, "no playable file in torrent"),
        }
    } else {
        match file.parse::<usize>() {
            Ok(i) => i,
            Err(_) => return text(StatusCode::BAD_REQUEST, "bad file index"),
        }
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

    // --- Priority policy: classify the request and materialise the windows librqbit cannot
    // infer from the serving stream (startup head + container index at the end of the file).
    apply_priority_policy(&engine, &entry, &handle, file_idx, start, to_send, len);

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
    let reader = GuardedReader { inner: stream.take(to_send), _guard: guard };
    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(reader, 64 * 1024));
    (status, out, body).into_response()
}

#[allow(clippy::too_many_arguments)]
fn apply_priority_policy(
    engine: &Arc<Engine>,
    entry: &Arc<Entry>,
    handle: &ManagedTorrentHandle,
    file_idx: usize,
    start: u64,
    requested_len: u64,
    file_len: u64,
) {
    let first_byte_sent = entry.first_byte_sent.load(Ordering::Relaxed);
    let last_end = entry.last_served_end.load(Ordering::Relaxed);
    let intent = classify_request(start, requested_len, file_len, first_byte_sent, (last_end > 0).then_some(last_end));

    let (piece_length, first_piece, last_piece) = handle
        .with_metadata(|m| {
            let pl = m.lengths().default_piece_length() as u64;
            let range = m.file_infos.get(file_idx).map(|f| f.piece_range.clone()).unwrap_or(0..0);
            (pl, range.start as i32, range.end.saturating_sub(1) as i32)
        })
        .unwrap_or((0, 0, 0));
    if piece_length == 0 {
        return;
    }

    let stats = handle.stats();
    let (download_rate, peers) = stats
        .live
        .as_ref()
        .map(|l| (l.download_speed.as_bytes(), l.snapshot.peer_stats.live as u64))
        .unwrap_or((0, 0));
    let file_offset = handle
        .with_metadata(|m| m.file_infos.get(file_idx).map(|f| f.offset_in_torrent).unwrap_or(0))
        .unwrap_or(0);
    let current_piece = ((file_offset + start) / piece_length) as i32;

    let ctx = PriorityContext {
        intent,
        current_piece,
        first_piece,
        last_piece,
        piece_length,
        file_size: file_len,
        bitrate_bytes_per_sec: None,
        download_rate_bytes_per_sec: download_rate,
        peers,
        cache_size_bytes: engine.config().cache_limit_bytes,
        memory_pressure: MemoryPressure::Normal,
        consecutive_waits: entry.consecutive_waits.load(Ordering::Relaxed) as u32,
        first_byte_sent,
    };
    let decision = PlaybackPriorityPolicy::decide(ctx.clone());
    let windows = prefetch_windows(&decision, &ctx, start);
    debug!(reason = %decision.reason, hot = decision.hot_window_pieces, warm = decision.warm_window_pieces, windows = windows.len(), "priority decision");

    // Every window becomes an auxiliary FileStream: librqbit interleaves the look-ahead queues of
    // all open streams, so these pieces are requested alongside the serving stream's.
    for w in windows {
        let handle = handle.clone();
        let entry = entry.clone();
        let is_background = intent == PlaybackIntent::Background;
        engine.runtime.spawn(async move {
            let job = async {
                let mut s = handle.stream(file_idx).await?;
                if w.offset > 0 {
                    s.seek(SeekFrom::Start(w.offset)).await?;
                }
                let mut left = w.len;
                let mut buf = vec![0u8; 256 * 1024];
                while left > 0 {
                    let chunk = buf.len().min(left as usize);
                    let n = s.read(&mut buf[..chunk]).await?;
                    if n == 0 {
                        break;
                    }
                    left -= n as u64;
                }
                anyhow::Ok(())
            };
            let budget = if is_background { 120 } else { 60 };
            match tokio::time::timeout(Duration::from_secs(budget), job).await {
                Ok(Ok(())) => {
                    entry.consecutive_waits.store(0, Ordering::Relaxed);
                }
                Ok(Err(e)) => debug!("prefetch window failed: {e:#}"),
                Err(_) => {
                    entry.consecutive_waits.fetch_add(1, Ordering::Relaxed);
                    debug!(offset = w.offset, len = w.len, "prefetch window timed out");
                }
            }
        });
    }
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
}
