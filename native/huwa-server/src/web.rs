//! The web app (`HUWA_WEB_DIR`, an `expo export -p web` build) at `/`, with SPA fallback,
//! `/huwa-config.json` generated from the environment, `/robots.txt`, and `X-Robots-Tag`.
//!
//! Caching: hashed bundles (`/_expo/static/…`, `/assets/…`) are immutable; HTML, the service
//! worker, the manifest and the config are `no-cache` (revalidated on every load).

use std::{path::PathBuf, sync::Arc};

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::{AppState, ServerConfig};

/// `GET /huwa-config.json`: runtime configuration of the web app served by this instance.
/// Schema `v: 1`; clients ignore unknown fields.
pub fn config_json(cfg: &ServerConfig) -> Value {
    json!({
        "v": 1,
        "server": {
            // Same origin as the page unless the operator set HUWA_PUBLIC_URL.
            "url": cfg.public_url.clone().unwrap_or_default(),
            "api": "/api/v1",
            "version": crate::VERSION,
        },
        "features": features(cfg),
        "p2p": {
            "gateway": cfg.p2p_gateway.then_some("/p2p"),
            "rendezvous": cfg.p2p_gateway.then_some("/p2p/rendezvous"),
        },
        "instance": {
            "name": cfg.instance_name,
            "operatorContact": cfg.operator_contact,
            "indexable": cfg.indexable,
        },
        "anilist": { "clientId": cfg.anilist_client_id },
    })
}

/// `features` of `/api/v1/info` and `/huwa-config.json`.
pub fn features(cfg: &ServerConfig) -> Value {
    json!({
        "torrent": cfg.engine_enabled(),
        "httpProxy": cfg.engine_enabled(),
        "transcode": cfg.media_enabled(),
        "fetchProxy": false,
        "stremioCompat": cfg.engine_enabled() && cfg.stremio_compat,
        "p2pGateway": cfg.p2p_gateway,
        "relay": cfg.relay,
        "seeding": false,
    })
}

pub async fn huwa_config(State(st): State<Arc<AppState>>) -> Response {
    let mut r = Json(config_json(&st.cfg)).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}

pub async fn robots(State(st): State<Arc<AppState>>) -> Response {
    if st.cfg.indexable {
        if let Some(dir) = &st.cfg.web_dir {
            if let Ok(b) = tokio::fs::read(dir.join("robots.txt")).await {
                return ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], b).into_response();
            }
        }
        return ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "User-agent: *\nAllow: /\n").into_response();
    }
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "User-agent: *\nDisallow: /\n").into_response()
}

fn cache_control(path: &str) -> &'static str {
    if path.starts_with("/_expo/static/") || path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path.ends_with(".html") || path == "/" || path.ends_with("sw.js") || path.ends_with(".webmanifest") || path.ends_with("manifest.json") {
        "no-cache"
    } else {
        "public, max-age=3600"
    }
}

/// Static files with SPA fallback (`index.html` for unknown paths). 404 without a web build.
pub async fn serve_static(st: Arc<AppState>, req: Request<Body>) -> Response {
    let Some(dir) = st.cfg.web_dir.clone() else {
        return crate::error::ApiError::not_found("no web app on this server (HUWA_WEB_DIR)").into_response();
    };
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return crate::error::ApiError::not_found("no such route").into_response();
    }
    let path = req.uri().path().to_string();
    let index: PathBuf = dir.join("index.html");
    let svc = ServeDir::new(&dir).precompressed_br().precompressed_gzip().append_index_html_on_directories(true).fallback(ServeFile::new(index));
    let mut resp = match svc.oneshot(req).await {
        Ok(r) => r.map(Body::new),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let fell_back = resp.headers().get(header::CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"text/html")) && !path.ends_with(".html");
    let cc = if fell_back { "no-cache" } else { cache_control(&path) };
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
    // Universal links: the AASA file has no extension but must be JSON.
    if path == "/.well-known/apple-app-site-association" || path == "/apple-app-site-association" {
        resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    resp
}

/// `X-Robots-Tag: noindex` unless `HUWA_INDEXABLE=1`, plus baseline security headers.
pub async fn headers_layer(State(st): State<Arc<AppState>>, req: Request<Body>, next: Next) -> Response {
    crate::metrics::inc(&st.metrics.http_requests);
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    if !st.cfg.indexable {
        h.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    }
    h.entry(header::X_CONTENT_TYPE_OPTIONS).or_insert(HeaderValue::from_static("nosniff"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_shape() {
        let cfg = ServerConfig { instance_name: Some("Maison".into()), ..Default::default() };
        let v = config_json(&cfg);
        assert_eq!(v["v"], 1);
        assert_eq!(v["server"]["api"], "/api/v1");
        assert_eq!(v["instance"]["name"], "Maison");
        assert_eq!(v["features"]["seeding"], false);
        assert_eq!(v["p2p"]["gateway"], "/p2p");
        assert_eq!(cache_control("/_expo/static/js/web/entry-abc.js"), "public, max-age=31536000, immutable");
        assert_eq!(cache_control("/index.html"), "no-cache");
    }
}
