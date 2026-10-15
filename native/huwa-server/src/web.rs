//! The web app (`HUWA_WEB_DIR`, an `expo export -p web` build) at `/`, with SPA fallback,
//! `/huwa-config.json` generated from the environment, `/robots.txt`, and `X-Robots-Tag`.
//!
//! Legacy site (the `-web` image of huwa.mciut.fr copies `site/` under the app, the old landing
//! page as `get.html`), same rules as `site/nginx.conf`:
//! - `/.well-known/*` and `/altstore/*`: real files or 404, never the app; the passkey /
//!   universal-link files (`apple-app-site-association` has no extension, `assetlinks.json`) are
//!   JSON, no redirect;
//! - `/addon`, `/install` (universal links, app not installed) → `extensions.html`, `/get` →
//!   `get.html`, when those files exist (otherwise the app's own routes answer);
//! - an extensionless path with a matching `.html` file answers with it (`/privacy`, `/terms`,
//!   `/pack`, `/extensions`), then the SPA fallback.
//!
//! Caching: hashed bundles (`/_expo/static/…`, `/assets/…`) are immutable; HTML, the service
//! worker, the manifest and the config are `no-cache` (revalidated on every load).

use std::sync::Arc;

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
        // HUWA_DISCORD_INVITE: "Rejoins la communauté" in the web app; null hides it.
        "community": { "discord": cfg.discord_invite },
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

/// Where a request for the legacy site goes, before the generic static lookup.
#[derive(Debug, PartialEq, Eq)]
enum Legacy {
    /// Serve this file (web-dir relative path) if it exists, else continue normally.
    Alias(String),
    /// Real files only: 404 instead of the SPA fallback.
    FilesOnly,
}

/// `site/nginx.conf`'s rules, applied to the request path.
fn legacy_route(path: &str) -> Option<Legacy> {
    if path.starts_with("/.well-known/") || path.starts_with("/altstore/") {
        return Some(Legacy::FilesOnly);
    }
    let p = path.trim_end_matches('/');
    match p {
        "/addon" | "/install" => return Some(Legacy::Alias("/extensions.html".into())),
        "/get" => return Some(Legacy::Alias("/get.html".into())),
        _ => {}
    }
    // `$uri.html`: plain names only (no dot, no traversal, no encoded bytes).
    let plain = p.len() > 1
        && p.len() <= 128
        && p[1..].split('/').all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    plain.then(|| Legacy::Alias(format!("{p}.html")))
}

fn json_file(path: &str) -> bool {
    matches!(path, "/.well-known/apple-app-site-association" | "/apple-app-site-association" | "/.well-known/assetlinks.json")
}

/// Static files with SPA fallback (`index.html` for unknown paths). 404 without a web build.
pub async fn serve_static(st: Arc<AppState>, mut req: Request<Body>) -> Response {
    let Some(dir) = st.cfg.web_dir.clone() else {
        return crate::error::ApiError::not_found("no web app on this server (HUWA_WEB_DIR)").into_response();
    };
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return crate::error::ApiError::not_found("no such route").into_response();
    }
    let mut path = req.uri().path().to_string();
    let mut spa = true;
    match legacy_route(&path) {
        Some(Legacy::FilesOnly) => spa = false,
        Some(Legacy::Alias(file)) => {
            if tokio::fs::metadata(dir.join(file.trim_start_matches('/'))).await.is_ok_and(|m| m.is_file()) {
                let pq = match req.uri().query() {
                    Some(q) => format!("{file}?{q}"),
                    None => file.clone(),
                };
                if let Ok(uri) = pq.parse() {
                    *req.uri_mut() = uri;
                    path = file;
                }
            }
        }
        None => {}
    }
    let base = ServeDir::new(&dir).precompressed_br().precompressed_gzip();
    let served = if spa {
        base.append_index_html_on_directories(true).fallback(ServeFile::new(dir.join("index.html"))).oneshot(req).await
    } else {
        base.append_index_html_on_directories(false).oneshot(req).await
    };
    let mut resp = match served {
        Ok(r) => r.map(Body::new),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let fell_back = resp.headers().get(header::CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"text/html")) && !path.ends_with(".html");
    let cc = if fell_back { "no-cache" } else { cache_control(&path) };
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
    // Universal links / passkeys: the AASA file has no extension but must be JSON.
    if json_file(&path) && resp.status().is_success() {
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
        assert_eq!(v["community"]["discord"], Value::Null);
        let cfg = ServerConfig { discord_invite: Some("https://discord.gg/abc".into()), ..Default::default() };
        assert_eq!(config_json(&cfg)["community"]["discord"], "https://discord.gg/abc");
    }

    #[test]
    fn legacy_routes() {
        let alias = |s: &str| Some(Legacy::Alias(s.into()));
        assert_eq!(legacy_route("/.well-known/apple-app-site-association"), Some(Legacy::FilesOnly));
        assert_eq!(legacy_route("/altstore/icon.png"), Some(Legacy::FilesOnly));
        assert_eq!(legacy_route("/addon"), alias("/extensions.html"));
        assert_eq!(legacy_route("/install/"), alias("/extensions.html"));
        assert_eq!(legacy_route("/get"), alias("/get.html"));
        assert_eq!(legacy_route("/privacy"), alias("/privacy.html"));
        assert_eq!(legacy_route("/anime/21"), alias("/anime/21.html"));
        assert_eq!(legacy_route("/"), None);
        assert_eq!(legacy_route("/privacy.html"), None);
        assert_eq!(legacy_route("/a/../etc/passwd"), None);
        assert_eq!(legacy_route("/%2e%2e"), None);
        assert!(json_file("/.well-known/assetlinks.json"));
    }
}
