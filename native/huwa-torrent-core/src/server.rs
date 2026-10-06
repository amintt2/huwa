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
    priorities::classify_request,
    range::{parse_range, RangeSpec},
    streaming::TrackedReader,
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

    // --- Priorities: classify the request (playback vs container-index probe) and let
    // `streaming` move the read-ahead walker / start the tail prefetch (see streaming.rs).
    let first_byte_sent = entry.first_byte_sent.load(Ordering::Relaxed);
    let last_end = entry.last_served_end.load(Ordering::Relaxed);
    let intent = classify_request(start, to_send, len, first_byte_sent, (last_end > 0).then_some(last_end));
    let cache_limit = engine.config().cache_limit_bytes;
    let playback = engine.streaming.on_request(&engine.runtime, &hex, &handle, file_idx, start, intent, cache_limit);
    debug!(intent = intent.as_str(), start, to_send, "priority intent");

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
    let reader = GuardedReader { inner: TrackedReader::new(stream.take(to_send), playback, start), _guard: guard };
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
}
