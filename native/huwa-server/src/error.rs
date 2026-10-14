//! Error envelope: non-2xx status + `{"error": "<message>", "code": "<code>", …}` (docs/server-api.md).

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub extra: Map<String, Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), extra: Map::new() }
    }

    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.to_string(), value);
        self
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", msg)
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", msg)
    }

    pub fn quota(limit: usize) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", format!("stream quota exceeded ({limit} per session)"))
            .with("limit", json!(limit))
    }

    /// A per-session or server-wide transcode quota (`kind`: `session` or `server`).
    pub fn transcode_quota(limit: usize, kind: &str) -> Self {
        let msg = if kind == "server" {
            format!("the server is already running its {limit} transcode(s)")
        } else {
            format!("transcode quota exceeded ({limit} per session)")
        };
        Self::new(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", msg).with("limit", json!(limit)).with("kind", json!(format!("transcode_{kind}")))
    }

    pub fn unavailable(code: &'static str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, msg)
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", msg)
    }

    /// An engine / proxy error (`api::dispatch`): refused upstreams are 403, the rest 400.
    #[cfg(feature = "engine")]
    pub fn engine(e: anyhow::Error) -> Self {
        if let Some(b) = e.downcast_ref::<huwa_torrent_core::net_policy::UpstreamBlocked>() {
            return Self::new(StatusCode::FORBIDDEN, "upstream_blocked", b.to_string());
        }
        let msg = format!("{e:#}");
        if msg.starts_with("unknown torrent") || msg.starts_with("unknown probe") || msg.starts_with("unknown http session") {
            return Self::not_found(msg);
        }
        Self::new(StatusCode::BAD_REQUEST, "engine_error", msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        body.insert("error".into(), Value::String(self.message));
        body.insert("code".into(), Value::String(self.code.into()));
        body.extend(self.extra);
        let mut resp = (self.status, Json(Value::Object(body))).into_response();
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if self.status == StatusCode::TOO_MANY_REQUESTS || self.status == StatusCode::SERVICE_UNAVAILABLE {
            resp.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("10"));
        }
        if self.status == StatusCode::UNAUTHORIZED {
            resp.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        resp
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
