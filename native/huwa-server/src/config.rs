//! Server configuration from `HUWA_*` environment variables (docs/WEB_DOCKER_PLAN.md §5; the
//! subset implemented by this spike is listed in docs/server-api.md).

use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use huwa_torrent_core::net_policy::Lookup;

/// The origin of the public web app, always allowed by default (D12).
pub const HUWA_WEB_ORIGIN: &str = "https://huwa.mciut.fr";

#[derive(Clone)]
pub struct ServerConfig {
    /// `HUWA_PORT` (8080).
    pub port: u16,
    /// `HUWA_BIND` (0.0.0.0).
    pub bind: IpAddr,
    /// `HUWA_PUBLIC_URL`: `https://huwa.example.org` (no trailing slash). Media URLs returned by
    /// the API are absolute when set, server-relative otherwise.
    pub public_url: Option<String>,
    /// `HUWA_ALLOWED_ORIGINS`: comma-separated origins for CORS, `*` for any. Default: the public
    /// URL's origin and https://huwa.mciut.fr.
    pub allowed_origins: Vec<String>,
    /// `HUWA_CACHE_DIR` (/cache): torrent data and engine state (`<dir>/engine`).
    pub cache_dir: PathBuf,
    /// `HUWA_DATA_DIR` (/data): persistent state (`token.key`). Unwritable → ephemeral key.
    pub data_dir: Option<PathBuf>,
    /// `HUWA_CACHE_MAX_GB` (20): torrent cache quota (LRU eviction of idle torrents).
    pub cache_max_bytes: u64,
    /// `HUWA_STREAMS_PER_SESSION` (2; 0 = unlimited).
    pub streams_per_session: usize,
    /// `HUWA_ALLOW_PRIVATE_UPSTREAMS` (0): the HTTP proxy may reach RFC 1918 / CGNAT / ULA hosts.
    /// Loopback and link-local (metadata) stay refused.
    pub allow_private_upstreams: bool,
    /// `HUWA_SESSION_TTL_DAYS` (30).
    pub session_ttl: Duration,
    /// `HUWA_WORKER_THREADS` (available parallelism, at least 2).
    pub worker_threads: usize,
    /// Tests only: loopback upstreams for the HTTP proxy.
    pub allow_loopback_upstreams: bool,
    /// Tests only: name resolution used by the upstream policy (rebinding simulation).
    pub dns: Option<Arc<dyn Lookup>>,
}

impl std::fmt::Debug for ServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerConfig")
            .field("port", &self.port)
            .field("bind", &self.bind)
            .field("public_url", &self.public_url)
            .field("allowed_origins", &self.allowed_origins)
            .field("cache_dir", &self.cache_dir)
            .field("data_dir", &self.data_dir)
            .field("cache_max_bytes", &self.cache_max_bytes)
            .field("streams_per_session", &self.streams_per_session)
            .field("allow_private_upstreams", &self.allow_private_upstreams)
            .field("session_ttl", &self.session_ttl)
            .field("worker_threads", &self.worker_threads)
            .finish_non_exhaustive()
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 8080,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            public_url: None,
            allowed_origins: vec![HUWA_WEB_ORIGIN.to_string()],
            cache_dir: PathBuf::from("/cache"),
            data_dir: Some(PathBuf::from("/data")),
            cache_max_bytes: 20 * GIB,
            streams_per_session: 2,
            allow_private_upstreams: false,
            session_ttl: Duration::from_secs(30 * 24 * 3600),
            worker_threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2),
            allow_loopback_upstreams: false,
            dns: None,
        }
    }
}

const GIB: u64 = 1024 * 1024 * 1024;

pub fn parse_bool(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" | "" => Some(false),
        _ => None,
    }
}

/// `scheme://host[:port]` of a URL (CORS origins compare on it).
pub fn origin_of(u: &str) -> Option<String> {
    let url = url::Url::parse(u.trim()).ok()?;
    match url.origin() {
        url::Origin::Tuple(..) => Some(url.origin().ascii_serialization()),
        url::Origin::Opaque(_) => None,
    }
}

impl ServerConfig {
    /// Reads `HUWA_*` through `get` (the process environment in `from_env`).
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let mut c = Self::default();
        let var = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if let Some(v) = var("HUWA_PORT") {
            c.port = v.parse().with_context(|| format!("HUWA_PORT={v}"))?;
        }
        if let Some(v) = var("HUWA_BIND") {
            c.bind = v.parse().with_context(|| format!("HUWA_BIND={v}"))?;
        }
        if let Some(v) = var("HUWA_PUBLIC_URL") {
            let u = url::Url::parse(&v).with_context(|| format!("HUWA_PUBLIC_URL={v}"))?;
            if !matches!(u.scheme(), "http" | "https") {
                return Err(anyhow!("HUWA_PUBLIC_URL must be http(s)"));
            }
            c.public_url = Some(v.trim_end_matches('/').to_string());
        }
        c.allowed_origins = match var("HUWA_ALLOWED_ORIGINS") {
            Some(v) => v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| if s == "*" || s.eq_ignore_ascii_case("self") { s.to_ascii_lowercase() } else { origin_of(s).unwrap_or_else(|| s.to_string()) })
                .collect(),
            None => vec!["self".to_string(), HUWA_WEB_ORIGIN.to_string()],
        };
        // `self` = the public URL's origin (same-origin requests need no CORS anyway).
        let own = c.public_url.as_deref().and_then(origin_of);
        let mut origins: Vec<String> = Vec::new();
        for o in std::mem::take(&mut c.allowed_origins) {
            let o = if o == "self" { match &own { Some(s) => s.clone(), None => continue } } else { o };
            if !origins.contains(&o) {
                origins.push(o);
            }
        }
        c.allowed_origins = origins;
        if let Some(v) = var("HUWA_CACHE_DIR") {
            c.cache_dir = PathBuf::from(v);
        }
        if let Some(v) = var("HUWA_DATA_DIR") {
            c.data_dir = Some(PathBuf::from(v));
        }
        if let Some(v) = var("HUWA_CACHE_MAX_GB") {
            let gb: f64 = v.parse().with_context(|| format!("HUWA_CACHE_MAX_GB={v}"))?;
            if !(gb.is_finite() && gb >= 0.0) {
                return Err(anyhow!("HUWA_CACHE_MAX_GB must be >= 0"));
            }
            c.cache_max_bytes = (gb * GIB as f64) as u64;
        }
        if let Some(v) = var("HUWA_STREAMS_PER_SESSION") {
            c.streams_per_session = v.parse().with_context(|| format!("HUWA_STREAMS_PER_SESSION={v}"))?;
        }
        if let Some(v) = var("HUWA_ALLOW_PRIVATE_UPSTREAMS") {
            c.allow_private_upstreams = parse_bool(&v).ok_or_else(|| anyhow!("HUWA_ALLOW_PRIVATE_UPSTREAMS={v}"))?;
        }
        if let Some(v) = var("HUWA_SESSION_TTL_DAYS") {
            let d: u64 = v.parse().with_context(|| format!("HUWA_SESSION_TTL_DAYS={v}"))?;
            c.session_ttl = Duration::from_secs(d.max(1) * 24 * 3600);
        }
        if let Some(v) = var("HUWA_WORKER_THREADS") {
            c.worker_threads = v.parse::<usize>().with_context(|| format!("HUWA_WORKER_THREADS={v}"))?.max(1);
        }
        Ok(c)
    }

    pub fn from_env() -> Result<Self> {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    /// Prefix of the media URLs of a session: `{public_url}/s/{token}` or `/s/{token}`.
    pub fn media_base(&self, token: &str) -> String {
        format!("{}/s/{token}", self.public_url.as_deref().unwrap_or(""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(vars: &[(&str, &str)]) -> Result<ServerConfig> {
        let m: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ServerConfig::from_vars(|k| m.get(k).cloned())
    }

    #[test]
    fn defaults() {
        let c = cfg(&[]).unwrap();
        assert_eq!(c.port, 8080);
        assert_eq!(c.streams_per_session, 2);
        assert_eq!(c.cache_max_bytes, 20 * GIB);
        assert!(!c.allow_private_upstreams);
        assert_eq!(c.allowed_origins, vec![HUWA_WEB_ORIGIN.to_string()]);
        assert_eq!(c.media_base("tok"), "/s/tok");
    }

    #[test]
    fn env_values() {
        let c = cfg(&[
            ("HUWA_PORT", "9000"),
            ("HUWA_PUBLIC_URL", "https://huwa.example.org/"),
            ("HUWA_CACHE_MAX_GB", "1.5"),
            ("HUWA_STREAMS_PER_SESSION", "3"),
            ("HUWA_ALLOW_PRIVATE_UPSTREAMS", "true"),
        ])
        .unwrap();
        assert_eq!(c.port, 9000);
        assert_eq!(c.public_url.as_deref(), Some("https://huwa.example.org"));
        assert_eq!(c.allowed_origins, vec!["https://huwa.example.org".to_string(), HUWA_WEB_ORIGIN.to_string()]);
        assert_eq!(c.cache_max_bytes, (1.5 * GIB as f64) as u64);
        assert_eq!(c.streams_per_session, 3);
        assert!(c.allow_private_upstreams);
        assert_eq!(c.media_base("tok"), "https://huwa.example.org/s/tok");
    }

    #[test]
    fn origins_list() {
        let c = cfg(&[("HUWA_ALLOWED_ORIGINS", "https://a.example/path, http://localhost:8081 ,*")]).unwrap();
        assert_eq!(c.allowed_origins, vec!["https://a.example", "http://localhost:8081", "*"]);
        assert!(cfg(&[("HUWA_PORT", "x")]).is_err());
        assert!(cfg(&[("HUWA_ALLOW_PRIVATE_UPSTREAMS", "maybe")]).is_err());
        assert!(cfg(&[("HUWA_PUBLIC_URL", "ftp://x")]).is_err());
    }
}
