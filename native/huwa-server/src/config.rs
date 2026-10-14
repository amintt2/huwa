//! Server configuration from `HUWA_*` environment variables (docs/WEB_DOCKER_PLAN.md §5,
//! docs/server-api.md §2, docs/SELF_HOSTING.md).

use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
#[cfg(feature = "engine")]
use huwa_torrent_core::net_policy::Lookup;

/// The origin of the public web app, always allowed by default (D12).
pub const HUWA_WEB_ORIGIN: &str = "https://huwa.mciut.fr";

/// `HUWA_HWACCEL`: video encoder used for transcodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwAccel {
    /// Probe VAAPI, QSV, NVENC at start (in that order), software when none works.
    Auto,
    None,
    Vaapi,
    Qsv,
    Nvenc,
}

impl HwAccel {
    pub fn parse(v: &str) -> Option<Self> {
        Some(match v.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => Self::Auto,
            "none" | "off" | "0" | "software" | "cpu" => Self::None,
            "vaapi" => Self::Vaapi,
            "qsv" => Self::Qsv,
            "nvenc" | "cuda" | "nvidia" => Self::Nvenc,
            _ => return None,
        })
    }
}

/// `HUWA_METRICS`: who may read `/metrics`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricsAccess {
    /// Only clients connecting from a loopback address (and never through the reverse proxy when
    /// `HUWA_TRUST_PROXY` is on, since the proxy itself is the peer).
    Loopback,
    Public,
    Off,
}

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
    /// `HUWA_TRUST_PROXY` (0): take the client address from `X-Forwarded-For` / `X-Real-IP`
    /// (per-IP session limits). Only behind a reverse proxy that sets them.
    pub trust_proxy: bool,
    /// `HUWA_TLS_CERT` / `HUWA_TLS_KEY`: PEM files; built-in HTTPS when both are set.
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    /// `HUWA_CACHE_DIR` (/cache): torrent data and engine state (`<dir>/engine`), HLS (`<dir>/hls`).
    pub cache_dir: PathBuf,
    /// `HUWA_DATA_DIR` (/data): persistent state (`token.key`, relay store). Unwritable → ephemeral key.
    pub data_dir: Option<PathBuf>,
    /// `HUWA_WEB_DIR` (/opt/huwa/web when it exists): static web build served at `/` (SPA).
    pub web_dir: Option<PathBuf>,
    /// `HUWA_TORRENT` (1): torrent engine and HTTP proxy routes (engine builds only).
    pub torrent: bool,
    /// `HUWA_TRANSCODE` (1): media module (ffprobe, HLS remux / transcode, sidecars).
    pub transcode: bool,
    /// `HUWA_HWACCEL` (auto).
    pub hwaccel: HwAccel,
    /// `HUWA_FFMPEG` / `HUWA_FFPROBE`: binaries (jellyfin-ffmpeg in the image, else `$PATH`).
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// `HUWA_STREMIO_COMPAT` (0): Stremio streaming-server routes at the root.
    pub stremio_compat: bool,
    /// `HUWA_STREMIO_COMPAT_STREAMS` (4): streams of the shared anonymous compat bucket.
    pub compat_streams: usize,
    /// `HUWA_P2P_GATEWAY` (1): supervise the Node P2P gateway and proxy `/p2p` to it.
    pub p2p_gateway: bool,
    /// `HUWA_GATEWAY_SCRIPT` (/opt/huwa/gateway/relay.js), `HUWA_GATEWAY_PORT` (18081, loopback).
    pub gateway_script: PathBuf,
    pub gateway_port: u16,
    /// `HUWA_RELAY` (1): supervise the blind-peer relay (`services/blind-peer/server.js`).
    pub relay: bool,
    /// `HUWA_RELAY_SCRIPT` (/opt/huwa/blind-peer/server.js).
    pub relay_script: PathBuf,
    /// `HUWA_RELAY_MAX_STORAGE_MB` (2048).
    pub relay_max_storage_mb: u64,
    /// `HUWA_DHT_PORT` (49737/udp): the relay's DHT port.
    pub dht_port: u16,
    /// `HUWA_BOOTSTRAP`: custom HyperDHT bootstrap, `host:port,…`.
    pub bootstrap: Option<String>,
    /// `HUWA_NODE` (node).
    pub node: PathBuf,
    /// `HUWA_CACHE_MAX_GB` (20): torrent cache quota (LRU eviction of idle torrents).
    pub cache_max_bytes: u64,
    /// `HUWA_MAX_SESSIONS` (50): active sessions server-wide (0 = unlimited).
    pub max_sessions: usize,
    /// `HUWA_SESSIONS_PER_IP` (5): active sessions created from one client address (0 = unlimited).
    pub sessions_per_ip: usize,
    /// `HUWA_STREAMS_PER_SESSION` (2; 0 = unlimited). Torrent and HTTP proxy streams.
    pub streams_per_session: usize,
    /// `HUWA_TRANSCODES_MAX` (1) / `HUWA_TRANSCODES_PER_SESSION` (1): concurrent video transcodes.
    pub transcodes_max: usize,
    pub transcodes_per_session: usize,
    /// `HUWA_DOWNLOAD_LIMIT_MBPS` (0 = unlimited): engine download cap, megabits per second.
    pub download_limit_mbps: f64,
    /// `HUWA_PROXY_SESSIONS` (32): live HTTP proxy sessions server-wide.
    pub proxy_sessions: usize,
    /// `HUWA_PROXY_SESSIONS_PER_SESSION` (8): HTTP proxy sessions one browser session may hold.
    pub proxy_sessions_per_session: usize,
    /// `HUWA_PROXY_READAHEAD_MB` (48): read-ahead bytes kept per HTTP proxy session.
    pub proxy_readahead_bytes: u64,
    /// `HUWA_MAX_WS` (200): concurrent `/p2p` WebSocket connections.
    pub max_ws: usize,
    /// `HUWA_REQUIRE_IDENTITY` (0): `POST /session` must carry an Ed25519 proof.
    pub require_identity: bool,
    /// `HUWA_ALLOW_PRIVATE_UPSTREAMS` (0): the HTTP proxy may reach RFC 1918 / CGNAT / ULA hosts.
    /// Loopback and link-local (metadata) stay refused.
    pub allow_private_upstreams: bool,
    /// `HUWA_INDEXABLE` (0): without it every response says `X-Robots-Tag: noindex`.
    pub indexable: bool,
    /// `HUWA_INSTANCE_NAME`, `HUWA_OPERATOR_CONTACT`, `HUWA_ANILIST_CLIENT_ID` (`/huwa-config.json`).
    pub instance_name: Option<String>,
    pub operator_contact: Option<String>,
    pub anilist_client_id: Option<String>,
    /// `HUWA_METRICS` (loopback | 1 | 0).
    pub metrics: MetricsAccess,
    /// `HUWA_SESSION_TTL_DAYS` (30).
    pub session_ttl: Duration,
    /// `HUWA_STREAM_TOKEN_HOURS` (6): lifetime of the per-stream media tokens.
    pub stream_token_ttl: Duration,
    /// `HUWA_WORKER_THREADS` (available parallelism, at least 2).
    pub worker_threads: usize,
    /// Tests only: loopback upstreams for the HTTP proxy.
    pub allow_loopback_upstreams: bool,
    /// Tests only: name resolution used by the upstream policy (rebinding simulation).
    #[cfg(feature = "engine")]
    pub dns: Option<Arc<dyn Lookup>>,
    #[cfg(not(feature = "engine"))]
    pub dns: Option<Arc<()>>,
}

impl std::fmt::Debug for ServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerConfig")
            .field("port", &self.port)
            .field("bind", &self.bind)
            .field("public_url", &self.public_url)
            .field("allowed_origins", &self.allowed_origins)
            .field("trust_proxy", &self.trust_proxy)
            .field("tls", &self.tls_cert.is_some())
            .field("cache_dir", &self.cache_dir)
            .field("data_dir", &self.data_dir)
            .field("web_dir", &self.web_dir)
            .field("torrent", &self.torrent)
            .field("transcode", &self.transcode)
            .field("hwaccel", &self.hwaccel)
            .field("stremio_compat", &self.stremio_compat)
            .field("p2p_gateway", &self.p2p_gateway)
            .field("relay", &self.relay)
            .field("cache_max_bytes", &self.cache_max_bytes)
            .field("max_sessions", &self.max_sessions)
            .field("sessions_per_ip", &self.sessions_per_ip)
            .field("streams_per_session", &self.streams_per_session)
            .field("transcodes_max", &self.transcodes_max)
            .field("transcodes_per_session", &self.transcodes_per_session)
            .field("proxy_sessions", &self.proxy_sessions)
            .field("require_identity", &self.require_identity)
            .field("allow_private_upstreams", &self.allow_private_upstreams)
            .field("indexable", &self.indexable)
            .field("metrics", &self.metrics)
            .field("worker_threads", &self.worker_threads)
            .finish_non_exhaustive()
    }
}

const JELLYFIN_FFMPEG: &str = "/usr/lib/jellyfin-ffmpeg/ffmpeg";
const JELLYFIN_FFPROBE: &str = "/usr/lib/jellyfin-ffmpeg/ffprobe";
const IMAGE_WEB_DIR: &str = "/opt/huwa/web";

impl Default for ServerConfig {
    fn default() -> Self {
        let jf = std::path::Path::new(JELLYFIN_FFMPEG).exists();
        Self {
            port: 8080,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            public_url: None,
            allowed_origins: vec![HUWA_WEB_ORIGIN.to_string()],
            trust_proxy: false,
            tls_cert: None,
            tls_key: None,
            cache_dir: PathBuf::from("/cache"),
            data_dir: Some(PathBuf::from("/data")),
            web_dir: None,
            torrent: true,
            transcode: true,
            hwaccel: HwAccel::Auto,
            ffmpeg: PathBuf::from(if jf { JELLYFIN_FFMPEG } else { "ffmpeg" }),
            ffprobe: PathBuf::from(if jf { JELLYFIN_FFPROBE } else { "ffprobe" }),
            stremio_compat: false,
            compat_streams: 4,
            p2p_gateway: true,
            gateway_script: PathBuf::from("/opt/huwa/gateway/relay.js"),
            gateway_port: 18081,
            relay: true,
            relay_script: PathBuf::from("/opt/huwa/blind-peer/server.js"),
            relay_max_storage_mb: 2048,
            dht_port: 49737,
            bootstrap: None,
            node: PathBuf::from("node"),
            cache_max_bytes: 20 * GIB,
            max_sessions: 50,
            sessions_per_ip: 5,
            streams_per_session: 2,
            transcodes_max: 1,
            transcodes_per_session: 1,
            download_limit_mbps: 0.0,
            proxy_sessions: 32,
            proxy_sessions_per_session: 8,
            proxy_readahead_bytes: 48 * MIB,
            max_ws: 200,
            require_identity: false,
            allow_private_upstreams: false,
            indexable: false,
            instance_name: None,
            operator_contact: None,
            anilist_client_id: None,
            metrics: MetricsAccess::Loopback,
            session_ttl: Duration::from_secs(30 * 24 * 3600),
            stream_token_ttl: Duration::from_secs(6 * 3600),
            worker_threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(2),
            allow_loopback_upstreams: false,
            dns: None,
        }
    }
}

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

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
        let flag = |k: &str, cur: bool| -> Result<bool> {
            match var(k) {
                Some(v) => parse_bool(&v).ok_or_else(|| anyhow!("{k}={v}: expected 1/0, true/false, yes/no, on/off")),
                None => Ok(cur),
            }
        };
        fn num<T: std::str::FromStr>(k: &str, v: Option<String>, cur: T) -> Result<T>
        where
            T::Err: std::error::Error + Send + Sync + 'static,
        {
            match v {
                Some(v) => v.parse::<T>().with_context(|| format!("{k}={v}")),
                None => Ok(cur),
            }
        }
        c.port = num("HUWA_PORT", var("HUWA_PORT"), c.port)?;
        c.bind = num("HUWA_BIND", var("HUWA_BIND"), c.bind)?;
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
            let o = if o == "self" {
                match &own {
                    Some(s) => s.clone(),
                    None => continue,
                }
            } else {
                o
            };
            if !origins.contains(&o) {
                origins.push(o);
            }
        }
        c.allowed_origins = origins;
        c.trust_proxy = flag("HUWA_TRUST_PROXY", c.trust_proxy)?;
        c.tls_cert = var("HUWA_TLS_CERT").map(PathBuf::from);
        c.tls_key = var("HUWA_TLS_KEY").map(PathBuf::from);
        if c.tls_cert.is_some() != c.tls_key.is_some() {
            return Err(anyhow!("HUWA_TLS_CERT and HUWA_TLS_KEY go together"));
        }
        if let Some(v) = var("HUWA_CACHE_DIR") {
            c.cache_dir = PathBuf::from(v);
        }
        if let Some(v) = var("HUWA_DATA_DIR") {
            c.data_dir = Some(PathBuf::from(v));
        }
        c.web_dir = match var("HUWA_WEB_DIR") {
            Some(v) if v == "-" || v.eq_ignore_ascii_case("none") => None,
            Some(v) => Some(PathBuf::from(v)),
            None => std::path::Path::new(IMAGE_WEB_DIR).join("index.html").exists().then(|| PathBuf::from(IMAGE_WEB_DIR)),
        };
        c.torrent = flag("HUWA_TORRENT", c.torrent)?;
        c.transcode = flag("HUWA_TRANSCODE", c.transcode)?;
        if let Some(v) = var("HUWA_HWACCEL") {
            c.hwaccel = HwAccel::parse(&v).ok_or_else(|| anyhow!("HUWA_HWACCEL={v}: auto, none, vaapi, qsv or nvenc"))?;
        }
        if let Some(v) = var("HUWA_FFMPEG") {
            c.ffmpeg = PathBuf::from(v);
        }
        if let Some(v) = var("HUWA_FFPROBE") {
            c.ffprobe = PathBuf::from(v);
        }
        c.stremio_compat = flag("HUWA_STREMIO_COMPAT", c.stremio_compat)?;
        c.compat_streams = num("HUWA_STREMIO_COMPAT_STREAMS", var("HUWA_STREMIO_COMPAT_STREAMS"), c.compat_streams)?;
        c.p2p_gateway = flag("HUWA_P2P_GATEWAY", c.p2p_gateway)?;
        if let Some(v) = var("HUWA_GATEWAY_SCRIPT") {
            c.gateway_script = PathBuf::from(v);
        }
        c.gateway_port = num("HUWA_GATEWAY_PORT", var("HUWA_GATEWAY_PORT"), c.gateway_port)?;
        c.relay = flag("HUWA_RELAY", c.relay)?;
        if let Some(v) = var("HUWA_RELAY_SCRIPT") {
            c.relay_script = PathBuf::from(v);
        }
        c.relay_max_storage_mb = num("HUWA_RELAY_MAX_STORAGE_MB", var("HUWA_RELAY_MAX_STORAGE_MB"), c.relay_max_storage_mb)?;
        c.dht_port = num("HUWA_DHT_PORT", var("HUWA_DHT_PORT"), c.dht_port)?;
        c.bootstrap = var("HUWA_BOOTSTRAP");
        if let Some(v) = var("HUWA_NODE") {
            c.node = PathBuf::from(v);
        }
        if let Some(v) = var("HUWA_CACHE_MAX_GB") {
            let gb: f64 = v.parse().with_context(|| format!("HUWA_CACHE_MAX_GB={v}"))?;
            if !(gb.is_finite() && gb >= 0.0) {
                return Err(anyhow!("HUWA_CACHE_MAX_GB must be >= 0"));
            }
            c.cache_max_bytes = (gb * GIB as f64) as u64;
        }
        c.max_sessions = num("HUWA_MAX_SESSIONS", var("HUWA_MAX_SESSIONS"), c.max_sessions)?;
        c.sessions_per_ip = num("HUWA_SESSIONS_PER_IP", var("HUWA_SESSIONS_PER_IP"), c.sessions_per_ip)?;
        c.streams_per_session = num("HUWA_STREAMS_PER_SESSION", var("HUWA_STREAMS_PER_SESSION"), c.streams_per_session)?;
        c.transcodes_max = num("HUWA_TRANSCODES_MAX", var("HUWA_TRANSCODES_MAX"), c.transcodes_max)?;
        c.transcodes_per_session = num("HUWA_TRANSCODES_PER_SESSION", var("HUWA_TRANSCODES_PER_SESSION"), c.transcodes_per_session)?;
        c.download_limit_mbps = num("HUWA_DOWNLOAD_LIMIT_MBPS", var("HUWA_DOWNLOAD_LIMIT_MBPS"), c.download_limit_mbps)?;
        if !(c.download_limit_mbps.is_finite() && c.download_limit_mbps >= 0.0) {
            return Err(anyhow!("HUWA_DOWNLOAD_LIMIT_MBPS must be >= 0"));
        }
        c.proxy_sessions = num("HUWA_PROXY_SESSIONS", var("HUWA_PROXY_SESSIONS"), c.proxy_sessions)?.max(1);
        c.proxy_sessions_per_session = num("HUWA_PROXY_SESSIONS_PER_SESSION", var("HUWA_PROXY_SESSIONS_PER_SESSION"), c.proxy_sessions_per_session)?;
        let mb: u64 = num("HUWA_PROXY_READAHEAD_MB", var("HUWA_PROXY_READAHEAD_MB"), c.proxy_readahead_bytes / MIB)?;
        c.proxy_readahead_bytes = mb.max(4) * MIB;
        c.max_ws = num("HUWA_MAX_WS", var("HUWA_MAX_WS"), c.max_ws)?;
        c.require_identity = flag("HUWA_REQUIRE_IDENTITY", c.require_identity)?;
        c.allow_private_upstreams = flag("HUWA_ALLOW_PRIVATE_UPSTREAMS", c.allow_private_upstreams)?;
        c.indexable = flag("HUWA_INDEXABLE", c.indexable)?;
        c.instance_name = var("HUWA_INSTANCE_NAME");
        c.operator_contact = var("HUWA_OPERATOR_CONTACT");
        c.anilist_client_id = var("HUWA_ANILIST_CLIENT_ID");
        if let Some(v) = var("HUWA_METRICS") {
            c.metrics = match v.to_ascii_lowercase().as_str() {
                "loopback" | "local" => MetricsAccess::Loopback,
                x => match parse_bool(x) {
                    Some(true) => MetricsAccess::Public,
                    Some(false) => MetricsAccess::Off,
                    None if x == "public" => MetricsAccess::Public,
                    None => return Err(anyhow!("HUWA_METRICS={v}: loopback, 1 or 0")),
                },
            };
        }
        if let Some(v) = var("HUWA_SESSION_TTL_DAYS") {
            let d: u64 = v.parse().with_context(|| format!("HUWA_SESSION_TTL_DAYS={v}"))?;
            c.session_ttl = Duration::from_secs(d.max(1) * 24 * 3600);
        }
        if let Some(v) = var("HUWA_STREAM_TOKEN_HOURS") {
            let h: u64 = v.parse().with_context(|| format!("HUWA_STREAM_TOKEN_HOURS={v}"))?;
            c.stream_token_ttl = Duration::from_secs(h.clamp(1, 24 * 30) * 3600);
        }
        if let Some(v) = var("HUWA_WORKER_THREADS") {
            c.worker_threads = v.parse::<usize>().with_context(|| format!("HUWA_WORKER_THREADS={v}"))?.max(1);
        }
        Ok(c)
    }

    pub fn from_env() -> Result<Self> {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    /// Prefix of the media URLs of a token: `{public_url}/s/{token}` or `/s/{token}`.
    pub fn media_base(&self, token: &str) -> String {
        format!("{}/s/{token}", self.public_url.as_deref().unwrap_or(""))
    }

    /// The engine is compiled in and enabled.
    pub fn engine_enabled(&self) -> bool {
        cfg!(feature = "engine") && self.torrent
    }

    /// HLS / probe / sidecars are available (engine builds with `HUWA_TRANSCODE=1`).
    pub fn media_enabled(&self) -> bool {
        self.engine_enabled() && self.transcode
    }

    pub fn hls_dir(&self) -> PathBuf {
        self.cache_dir.join("hls")
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
        assert_eq!(c.sessions_per_ip, 5);
        assert_eq!(c.max_sessions, 50);
        assert_eq!((c.transcodes_max, c.transcodes_per_session), (1, 1));
        assert_eq!(c.hwaccel, HwAccel::Auto);
        assert_eq!(c.metrics, MetricsAccess::Loopback);
        assert!(!c.stremio_compat && !c.indexable && !c.trust_proxy && !c.require_identity);
        assert!(c.p2p_gateway && c.relay);
    }

    #[test]
    fn env_values() {
        let c = cfg(&[
            ("HUWA_PORT", "9000"),
            ("HUWA_PUBLIC_URL", "https://huwa.example.org/"),
            ("HUWA_CACHE_MAX_GB", "1.5"),
            ("HUWA_STREAMS_PER_SESSION", "3"),
            ("HUWA_ALLOW_PRIVATE_UPSTREAMS", "true"),
            ("HUWA_TRUST_PROXY", "1"),
            ("HUWA_SESSIONS_PER_IP", "9"),
            ("HUWA_HWACCEL", "vaapi"),
            ("HUWA_STREMIO_COMPAT", "yes"),
            ("HUWA_METRICS", "1"),
            ("HUWA_PROXY_SESSIONS", "12"),
            ("HUWA_PROXY_READAHEAD_MB", "16"),
            ("HUWA_WEB_DIR", "/srv/web"),
        ])
        .unwrap();
        assert_eq!(c.port, 9000);
        assert_eq!(c.public_url.as_deref(), Some("https://huwa.example.org"));
        assert_eq!(c.allowed_origins, vec!["https://huwa.example.org".to_string(), HUWA_WEB_ORIGIN.to_string()]);
        assert_eq!(c.cache_max_bytes, (1.5 * GIB as f64) as u64);
        assert_eq!(c.streams_per_session, 3);
        assert!(c.allow_private_upstreams && c.trust_proxy && c.stremio_compat);
        assert_eq!(c.sessions_per_ip, 9);
        assert_eq!(c.hwaccel, HwAccel::Vaapi);
        assert_eq!(c.metrics, MetricsAccess::Public);
        assert_eq!(c.proxy_sessions, 12);
        assert_eq!(c.proxy_readahead_bytes, 16 * MIB);
        assert_eq!(c.web_dir.as_deref(), Some(std::path::Path::new("/srv/web")));
        assert_eq!(c.media_base("tok"), "https://huwa.example.org/s/tok");
    }

    #[test]
    fn invalid_values() {
        let c = cfg(&[("HUWA_ALLOWED_ORIGINS", "https://a.example/path, http://localhost:8081 ,*")]).unwrap();
        assert_eq!(c.allowed_origins, vec!["https://a.example", "http://localhost:8081", "*"]);
        assert!(cfg(&[("HUWA_PORT", "x")]).is_err());
        assert!(cfg(&[("HUWA_ALLOW_PRIVATE_UPSTREAMS", "maybe")]).is_err());
        assert!(cfg(&[("HUWA_PUBLIC_URL", "ftp://x")]).is_err());
        assert!(cfg(&[("HUWA_HWACCEL", "gpu")]).is_err());
        assert!(cfg(&[("HUWA_TLS_CERT", "/c.pem")]).is_err());
        assert!(cfg(&[("HUWA_METRICS", "sometimes")]).is_err());
    }
}
