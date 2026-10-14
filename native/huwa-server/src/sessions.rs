//! Per-browser sessions (D11).
//!
//! **Session token:** `v1.<sid>.<exp>.<mac>` — `sid` 16 random bytes (hex), `exp` Unix seconds,
//! `mac` = HMAC-SHA256(server key, `huwa/session/v1|<sid>|<exp>`) (hex). The token is a capability:
//! it goes in the `Authorization: Bearer` header of API calls. Verified in constant time; the key
//! lives in `<data>/token.key` (or is random per process).
//!
//! **Stream token:** `m1.<sid>.<scope>.<exp>.<mac>` with `mac` = HMAC-SHA256(key,
//! `huwa/stream/v1|<sid>|<scope>|<exp>`). Media URLs carry it in their path (`/s/<token>/…`:
//! players cannot send headers). It is bound to one stream (`scope`: `t-<infoHash>`, `h-<proxy
//! id>`, `m-<media id>`) and short-lived (`HUWA_STREAM_TOKEN_HOURS`), so a URL leaked through a
//! log or a `Referer` gives neither the session's API nor its other streams. Session tokens are
//! still accepted in media paths (phase 0 clients).
//!
//! **Creation limits:** `HUWA_MAX_SESSIONS` active sessions server-wide, `HUWA_SESSIONS_PER_IP`
//! per client address (IPv6 grouped by /64). Active = used in the last 24 h. An optional Ed25519
//! proof (the browser key signs `huwa/session/v1|<ts>|<publicKey hex>`) binds the session to that
//! key: the same key gets the same session back, without counting against its address again.
//!
//! **State** is in memory: torrents held (deduplicated by info hash across sessions, with a
//! reference count), stream slots (quota), HTTP proxy sessions and probes it opened. A valid token
//! unknown to this process (restart with a persisted key) gets a fresh, empty state.

use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use parking_lot::{Mutex, RwLock};
use ring::{hmac, rand::SecureRandom};
use serde_json::json;

use crate::error::ApiError;

/// A stream slot with no open response and no request for this long is free again.
pub const SLOT_IDLE: Duration = Duration::from_secs(120);
/// A session used within this window counts against the creation limits.
pub const ACTIVE_WINDOW: Duration = Duration::from_secs(24 * 3600);
/// Accepted clock skew of an Ed25519 proof.
pub const PROOF_SKEW_SECS: u64 = 300;

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug)]
struct Slot {
    last: Instant,
    open: usize,
}

impl Slot {
    fn live(&self, now: Instant) -> bool {
        self.open > 0 || now.duration_since(self.last) < SLOT_IDLE
    }
}

/// Client address used by the per-IP limit: IPv4 as is, IPv6 by its /64.
pub fn ip_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let mut seg = v6.segments();
            seg[4..].iter_mut().for_each(|s| *s = 0);
            IpAddr::V6(seg.into())
        }
        v4 => v4,
    }
}

#[derive(Debug)]
pub struct Session {
    pub id: String,
    pub expires_at: AtomicU64,
    pub last_seen: AtomicU64,
    /// Address that created the session (per-IP limit); `None` for restored / internal sessions.
    pub created_by: Option<IpAddr>,
    /// Ed25519 key that proved it (D11), lower-case hex.
    pub public_key: Mutex<Option<String>>,
    /// Info hashes this session started (`startStream` / `prewarm`).
    pub torrents: Mutex<HashSet<String>>,
    /// Stream slots by key (an info hash, or `http:<id>` for a proxy stream).
    slots: Mutex<HashMap<String, Slot>>,
    /// HTTP proxy session id → references taken by this session (`httpOpen`).
    pub http: Mutex<HashMap<u64, usize>>,
    pub probes: Mutex<HashSet<u64>>,
    /// Media sessions (ffprobe / HLS) it opened.
    pub media: Mutex<HashSet<String>>,
}

impl Session {
    pub fn new(id: String, expires_at: u64, created_by: Option<IpAddr>) -> Self {
        Self {
            id,
            expires_at: AtomicU64::new(expires_at),
            last_seen: AtomicU64::new(now_secs()),
            created_by,
            public_key: Mutex::new(None),
            torrents: Default::default(),
            slots: Default::default(),
            http: Default::default(),
            probes: Default::default(),
            media: Default::default(),
        }
    }

    pub fn expires_at(&self) -> u64 {
        self.expires_at.load(Ordering::Relaxed)
    }

    fn active(&self, now: u64) -> bool {
        now.saturating_sub(self.last_seen.load(Ordering::Relaxed)) < ACTIVE_WINDOW.as_secs() && self.expires_at() > now
    }

    pub fn holds(&self, hex: &str) -> bool {
        self.torrents.lock().contains(hex)
    }

    pub fn owns_http(&self, id: u64) -> bool {
        self.http.lock().contains_key(&id)
    }

    pub fn owns_media(&self, id: &str) -> bool {
        self.media.lock().contains(id)
    }

    /// Takes (or refreshes) the stream slot `key`. `limit` 0 = unlimited.
    pub fn claim_slot(&self, key: &str, limit: usize) -> Result<(), ApiError> {
        let now = Instant::now();
        let mut slots = self.slots.lock();
        if let Some(s) = slots.get_mut(key) {
            s.last = now;
            return Ok(());
        }
        slots.retain(|_, s| s.live(now));
        if limit > 0 && slots.len() >= limit {
            return Err(ApiError::quota(limit));
        }
        slots.insert(key.to_string(), Slot { last: now, open: 0 });
        Ok(())
    }

    pub fn free_slot(&self, key: &str) {
        self.slots.lock().remove(key);
    }

    /// Live slots (open responses or recent activity).
    pub fn live_slots(&self) -> usize {
        let now = Instant::now();
        self.slots.lock().values().filter(|s| s.live(now)).count()
    }

    /// An open media response on `key`'s slot (released by dropping the guard).
    pub fn open_stream(self: &Arc<Self>, key: &str) -> StreamGuard {
        if let Some(s) = self.slots.lock().get_mut(key) {
            s.open += 1;
            s.last = Instant::now();
        }
        StreamGuard { session: self.clone(), key: key.to_string() }
    }
}

/// Keeps a slot busy while a response body is being sent.
pub struct StreamGuard {
    session: Arc<Session>,
    key: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(s) = self.session.slots.lock().get_mut(&self.key) {
            s.open = s.open.saturating_sub(1);
            s.last = Instant::now();
        }
    }
}

/// Body of `POST /api/v1/session` (all optional unless `HUWA_REQUIRE_IDENTITY`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    /// Ed25519 public key, 32 bytes: hex or base64url.
    pub public_key: Option<String>,
    /// Unix seconds (milliseconds are accepted too).
    pub ts: Option<u64>,
    /// Signature of `huwa/session/v1|<ts>|<publicKey hex>`, 64 bytes: hex or base64url.
    pub sig: Option<String>,
}

/// Hex, or base64 / base64url with or without padding.
pub fn decode_bytes(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let s = s.trim();
    if s.len() % 2 == 0 && s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return hex::decode(s).ok();
    }
    let t = s.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(t)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(t))
        .ok()
}

/// Checks the D11 proof. Returns the key as lower-case hex.
pub fn verify_proof(req: &SessionRequest, now: u64) -> Result<Option<String>, ApiError> {
    let bad = |m: &str| ApiError::new(StatusCode::BAD_REQUEST, "invalid_proof", m.to_string());
    let (Some(pk), Some(ts), Some(sig)) = (req.public_key.as_deref(), req.ts, req.sig.as_deref()) else {
        if req.public_key.is_some() || req.sig.is_some() {
            return Err(bad("publicKey, ts and sig go together"));
        }
        return Ok(None);
    };
    let pk = decode_bytes(pk).filter(|b| b.len() == 32).ok_or_else(|| bad("publicKey must be 32 bytes (hex or base64url)"))?;
    let sig = decode_bytes(sig).filter(|b| b.len() == 64).ok_or_else(|| bad("sig must be 64 bytes (hex or base64url)"))?;
    let secs = if ts > 100_000_000_000 { ts / 1000 } else { ts };
    if secs.abs_diff(now) > PROOF_SKEW_SECS {
        return Err(bad("ts is too far from the server clock"));
    }
    let pk_hex = hex::encode(&pk);
    let msg = format!("huwa/session/v1|{ts}|{pk_hex}");
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &pk)
        .verify(msg.as_bytes(), &sig)
        .map_err(|_| bad("bad signature"))?;
    Ok(Some(pk_hex))
}

pub struct Sessions {
    key: hmac::Key,
    ttl: Duration,
    stream_ttl: Duration,
    map: RwLock<HashMap<String, Arc<Session>>>,
    /// Info hash → number of sessions holding it (D11 dedup with refcount).
    holders: Mutex<HashMap<String, usize>>,
    /// Ed25519 key → session id.
    by_key: Mutex<HashMap<String, String>>,
    pub max_sessions: usize,
    pub per_ip: usize,
}

const MAC_LABEL: &str = "huwa/session/v1";
const STREAM_LABEL: &str = "huwa/stream/v1";

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    ring::rand::SystemRandom::new().fill(&mut b).expect("system random");
    b
}

pub fn random_hex<const N: usize>() -> String {
    hex::encode(random_bytes::<N>())
}

/// Loads `<dir>/token.key` (32 bytes), creating it if missing. `None` when the directory is not
/// usable (the key is then random per process: tokens die with a restart).
pub fn load_or_create_key(dir: &std::path::Path) -> Option<[u8; 32]> {
    let path = dir.join("token.key");
    if let Ok(b) = std::fs::read(&path) {
        if b.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            return Some(k);
        }
        tracing::warn!("{} has the wrong size, ignored", path.display());
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    let k = random_bytes::<32>();
    let tmp = dir.join("token.key.tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).ok()?;
        f.write_all(&k).ok()?;
        f.sync_all().ok()?;
    }
    std::fs::rename(&tmp, &path).ok()?;
    Some(k)
}

fn valid_sid(sid: &str) -> bool {
    sid.len() == 32 && sid.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// A stream token scope: `t-<40 hex>`, `h-<digits>`, `m-<hex>`.
fn valid_scope(scope: &str) -> bool {
    let Some((kind, rest)) = scope.split_once('-') else { return false };
    !rest.is_empty()
        && rest.len() <= 64
        && match kind {
            "t" | "m" => rest.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "h" => rest.bytes().all(|c| c.is_ascii_digit()),
            _ => false,
        }
}

impl Sessions {
    pub fn new(key: [u8; 32], ttl: Duration) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, &key),
            ttl,
            stream_ttl: Duration::from_secs(6 * 3600),
            map: Default::default(),
            holders: Default::default(),
            by_key: Default::default(),
            max_sessions: 0,
            per_ip: 0,
        }
    }

    pub fn with_random_key(ttl: Duration) -> Self {
        Self::new(random_bytes::<32>(), ttl)
    }

    pub fn with_limits(mut self, max_sessions: usize, per_ip: usize, stream_ttl: Duration) -> Self {
        self.max_sessions = max_sessions;
        self.per_ip = per_ip;
        self.stream_ttl = stream_ttl;
        self
    }

    fn mac(&self, sid: &str, exp: u64) -> hmac::Tag {
        hmac::sign(&self.key, format!("{MAC_LABEL}|{sid}|{exp}").as_bytes())
    }

    fn token_for(&self, sid: &str, exp: u64) -> String {
        format!("v1.{sid}.{exp}.{}", hex::encode(self.mac(sid, exp).as_ref()))
    }

    /// A new session and its token (no limits; tests and internal use).
    pub fn create(&self) -> (String, Arc<Session>) {
        self.create_for(None, None).expect("no limits")
    }

    /// A new session for a client address (limits apply), optionally bound to a proven key.
    pub fn create_for(&self, ip: Option<IpAddr>, public_key: Option<String>) -> Result<(String, Arc<Session>), ApiError> {
        let now = now_secs();
        let exp = now + self.ttl.as_secs();
        // The same browser key gets its live session back (a new token for it).
        if let Some(pk) = &public_key {
            let sid = self.by_key.lock().get(pk).cloned();
            if let Some(s) = sid.and_then(|sid| self.map.read().get(&sid).cloned()) {
                if s.active(now) {
                    s.expires_at.fetch_max(exp, Ordering::Relaxed);
                    s.last_seen.store(now, Ordering::Relaxed);
                    return Ok((self.token_for(&s.id, exp), s));
                }
            }
        }
        let ip = ip.map(ip_key);
        {
            let map = self.map.read();
            if self.max_sessions > 0 || (self.per_ip > 0 && ip.is_some()) {
                let (mut active, mut from_ip) = (0usize, 0usize);
                for s in map.values().filter(|s| s.active(now)) {
                    active += 1;
                    if ip.is_some() && s.created_by == ip {
                        from_ip += 1;
                    }
                }
                if self.max_sessions > 0 && active >= self.max_sessions {
                    return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "server_full", "this server has no room for another session")
                        .with("limit", json!(self.max_sessions)));
                }
                if self.per_ip > 0 && ip.is_some() && from_ip >= self.per_ip {
                    return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too_many_sessions", format!("too many sessions from this address ({} max)", self.per_ip))
                        .with("limit", json!(self.per_ip)));
                }
            }
        }
        let sid = random_hex::<16>();
        let s = Arc::new(Session::new(sid.clone(), exp, ip));
        if let Some(pk) = public_key {
            *s.public_key.lock() = Some(pk.clone());
            self.by_key.lock().insert(pk, sid.clone());
        }
        self.map.write().insert(sid.clone(), s.clone());
        Ok((self.token_for(&sid, exp), s))
    }

    fn session_for(&self, sid: &str, exp: u64) -> Arc<Session> {
        if let Some(s) = self.map.read().get(sid) {
            s.last_seen.store(now_secs(), Ordering::Relaxed);
            return s.clone();
        }
        self.map.write().entry(sid.to_string()).or_insert_with(|| Arc::new(Session::new(sid.to_string(), exp, None))).clone()
    }

    /// Checks a session token (format, MAC in constant time, expiry) and returns its session.
    pub fn verify(&self, token: &str) -> Result<Arc<Session>, ApiError> {
        let bad = || ApiError::unauthorized("invalid session token");
        let mut parts = token.split('.');
        let (Some("v1"), Some(sid), Some(exp), Some(mac), None) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
            return Err(bad());
        };
        if !valid_sid(sid) {
            return Err(bad());
        }
        let exp: u64 = exp.parse().map_err(|_| bad())?;
        let mac = hex::decode(mac).map_err(|_| bad())?;
        hmac::verify(&self.key, format!("{MAC_LABEL}|{sid}|{exp}").as_bytes(), &mac).map_err(|_| bad())?;
        if exp <= now_secs() {
            // Another, newer token of the same session (re-issued for its key) may still be live.
            if self.map.read().get(sid).is_none_or(|s| s.expires_at() <= now_secs()) {
                self.drop_session(sid);
            }
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "session_expired", "session expired"));
        }
        Ok(self.session_for(sid, exp))
    }

    /// A short-lived media token of `session` for one stream (`scope`).
    pub fn stream_token(&self, session: &Session, scope: &str) -> String {
        let exp = (now_secs() + self.stream_ttl.as_secs()).min(session.expires_at().max(now_secs() + 60));
        let mac = hmac::sign(&self.key, format!("{STREAM_LABEL}|{}|{scope}|{exp}", session.id).as_bytes());
        format!("m1.{}.{scope}.{exp}.{}", session.id, hex::encode(mac.as_ref()))
    }

    /// Checks a token in a media path: a stream token whose scope is `scope`, or a session token.
    pub fn verify_media(&self, token: &str, scope: &str) -> Result<Arc<Session>, ApiError> {
        if token.starts_with("v1.") {
            return self.verify(token);
        }
        let bad = || ApiError::unauthorized("invalid media token");
        let mut parts = token.split('.');
        let (Some("m1"), Some(sid), Some(tscope), Some(exp), Some(mac), None) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(bad());
        };
        if !valid_sid(sid) || !valid_scope(tscope) {
            return Err(bad());
        }
        let exp: u64 = exp.parse().map_err(|_| bad())?;
        let mac = hex::decode(mac).map_err(|_| bad())?;
        hmac::verify(&self.key, format!("{STREAM_LABEL}|{sid}|{tscope}|{exp}").as_bytes(), &mac).map_err(|_| bad())?;
        if exp <= now_secs() {
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "token_expired", "media token expired: ask the API for a new URL"));
        }
        if tscope != scope {
            // A valid token for another stream of the session: as if the stream did not exist.
            return Err(ApiError::not_found("no such stream"));
        }
        Ok(self.session_for(sid, exp))
    }

    /// The session `sid` if this process knows it.
    pub fn get(&self, sid: &str) -> Option<Arc<Session>> {
        self.map.read().get(sid).cloned()
    }

    /// An internal session (Stremio-compat bucket): never expires, not limited per IP.
    pub fn internal(&self, sid: &str) -> Arc<Session> {
        self.map.write().entry(sid.to_string()).or_insert_with(|| Arc::new(Session::new(sid.to_string(), u64::MAX / 2, None))).clone()
    }

    pub fn count(&self) -> usize {
        self.map.read().len()
    }

    pub fn active_count(&self) -> usize {
        let now = now_secs();
        self.map.read().values().filter(|s| s.active(now)).count()
    }

    /// `session` now holds `hex` (no-op if it already does). Returns the holder count.
    pub fn hold(&self, session: &Session, hex: &str) -> usize {
        let mut holders = self.holders.lock();
        if session.torrents.lock().insert(hex.to_string()) {
            *holders.entry(hex.to_string()).or_default() += 1;
        }
        holders.get(hex).copied().unwrap_or(0)
    }

    /// `session` lets go of `hex`. Returns the holders left (`None`: it did not hold it).
    pub fn unhold(&self, session: &Session, hex: &str) -> Option<usize> {
        let mut holders = self.holders.lock();
        if !session.torrents.lock().remove(hex) {
            return None;
        }
        session.free_slot(hex);
        let left = match holders.get_mut(hex) {
            Some(n) => {
                *n = n.saturating_sub(1);
                *n
            }
            None => 0,
        };
        if left == 0 {
            holders.remove(hex);
        }
        Some(left)
    }

    pub fn holders_of(&self, hex: &str) -> usize {
        self.holders.lock().get(hex).copied().unwrap_or(0)
    }

    /// Forgets a session; returns the info hashes nobody holds any more.
    pub fn drop_session(&self, sid: &str) -> Vec<String> {
        let Some(s) = self.map.write().remove(sid) else { return Vec::new() };
        if let Some(pk) = s.public_key.lock().take() {
            let mut by_key = self.by_key.lock();
            if by_key.get(&pk).map(String::as_str) == Some(sid) {
                by_key.remove(&pk);
            }
        }
        let held: Vec<String> = s.torrents.lock().iter().cloned().collect();
        held.into_iter().filter(|h| self.unhold(&s, h) == Some(0)).collect()
    }

    /// Expired sessions (janitor). Returns `(dropped session ids, info hashes nobody holds)`.
    pub fn sweep(&self) -> (Vec<String>, Vec<String>) {
        let now = now_secs();
        let expired: Vec<String> = self.map.read().values().filter(|s| s.expires_at() <= now).map(|s| s.id.clone()).collect();
        let freed = expired.iter().flat_map(|sid| self.drop_session(sid)).collect();
        (expired, freed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_verify_and_reject_tampering() {
        let s = Sessions::with_random_key(Duration::from_secs(3600));
        let (tok, sess) = s.create();
        assert!(Arc::ptr_eq(&s.verify(&tok).unwrap(), &sess));
        let mut parts: Vec<String> = tok.split('.').map(String::from).collect();
        // Longer expiry, same MAC.
        parts[2] = (parts[2].parse::<u64>().unwrap() + 1).to_string();
        assert_eq!(s.verify(&parts.join(".")).unwrap_err().code, "unauthorized");
        // Another key.
        let other = Sessions::with_random_key(Duration::from_secs(3600));
        assert!(other.verify(&tok).is_err());
        for junk in ["", "v1", "v1.a.b.c", "v2.x.1.y", &format!("{tok}.x")] {
            assert!(s.verify(junk).is_err(), "{junk}");
        }
    }

    #[test]
    fn stream_tokens_are_scoped() {
        let s = Sessions::with_random_key(Duration::from_secs(3600));
        let (tok, sess) = s.create();
        let h = "ab".repeat(20);
        let st = s.stream_token(&sess, &format!("t-{h}"));
        assert!(st.starts_with("m1."));
        assert!(Arc::ptr_eq(&s.verify_media(&st, &format!("t-{h}")).unwrap(), &sess));
        assert_eq!(s.verify_media(&st, "h-3").unwrap_err().code, "not_found");
        // A stream token is not a session token.
        assert_eq!(s.verify(&st).unwrap_err().code, "unauthorized");
        // Session tokens still work in media paths.
        assert!(s.verify_media(&tok, "h-3").is_ok());
        // Tampered scope.
        let forged = st.replace(&format!("t-{h}"), "h-3");
        assert_eq!(s.verify_media(&forged, "h-3").unwrap_err().code, "unauthorized");
        assert!(s.verify_media("m1.x.t-ab.1.00", "t-ab").is_err());
    }

    #[test]
    fn valid_token_unknown_to_the_process_gets_a_fresh_state() {
        let key = [7u8; 32];
        let a = Sessions::new(key, Duration::from_secs(3600));
        let (tok, _) = a.create();
        let b = Sessions::new(key, Duration::from_secs(3600));
        let s = b.verify(&tok).unwrap();
        assert!(s.torrents.lock().is_empty());
        assert!(Arc::ptr_eq(&s, &b.verify(&tok).unwrap()));
    }

    #[test]
    fn expired_tokens_are_refused() {
        let s = Sessions::with_random_key(Duration::from_secs(0));
        let (tok, _) = s.create();
        assert_eq!(s.verify(&tok).unwrap_err().code, "session_expired");
        assert_eq!(s.count(), 0);
    }

    #[test]
    fn per_ip_and_global_limits() {
        let s = Sessions::with_random_key(Duration::from_secs(3600)).with_limits(4, 2, Duration::from_secs(60));
        let a: IpAddr = "203.0.113.7".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let b2: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
        s.create_for(Some(a), None).unwrap();
        s.create_for(Some(a), None).unwrap();
        assert_eq!(s.create_for(Some(a), None).unwrap_err().code, "too_many_sessions");
        s.create_for(Some(b), None).unwrap();
        // Same /64.
        s.create_for(Some(b2), None).unwrap();
        assert_eq!(s.create_for(Some("198.51.100.1".parse().unwrap()), None).unwrap_err().code, "server_full");
    }

    #[test]
    fn proof_binds_the_session_to_the_key() {
        use ring::signature::KeyPair;
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let pk_hex = hex::encode(kp.public_key().as_ref());
        let now = now_secs();
        let sig = kp.sign(format!("huwa/session/v1|{now}|{pk_hex}").as_bytes());
        use base64::Engine;
        let req = SessionRequest {
            public_key: Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(kp.public_key().as_ref())),
            ts: Some(now),
            sig: Some(hex::encode(sig.as_ref())),
        };
        assert_eq!(verify_proof(&req, now).unwrap(), Some(pk_hex.clone()));
        // Stale, forged, partial.
        assert!(verify_proof(&req, now + 3600).is_err());
        let mut forged = SessionRequest { public_key: req.public_key.clone(), ts: Some(now + 1), sig: req.sig.clone() };
        assert_eq!(verify_proof(&forged, now).unwrap_err().code, "invalid_proof");
        forged.ts = None;
        assert!(verify_proof(&forged, now).is_err());
        assert_eq!(verify_proof(&SessionRequest::default(), now).unwrap(), None);

        // Same key → same session, without counting against the address again.
        let s = Sessions::with_random_key(Duration::from_secs(3600)).with_limits(0, 1, Duration::from_secs(60));
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        let (_, a) = s.create_for(Some(ip), Some(pk_hex.clone())).unwrap();
        let (t2, b) = s.create_for(Some(ip), Some(pk_hex)).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert!(Arc::ptr_eq(&s.verify(&t2).unwrap(), &a));
        assert_eq!(s.create_for(Some(ip), None).unwrap_err().code, "too_many_sessions");
    }

    #[test]
    fn refcounted_holding() {
        let s = Sessions::with_random_key(Duration::from_secs(3600));
        let (_, a) = s.create();
        let (_, b) = s.create();
        assert_eq!(s.hold(&a, "h"), 1);
        assert_eq!(s.hold(&a, "h"), 1, "idempotent");
        assert_eq!(s.hold(&b, "h"), 2);
        assert_eq!(s.unhold(&a, "h"), Some(1));
        assert_eq!(s.unhold(&a, "h"), None);
        assert_eq!(s.drop_session(&b.id), vec!["h".to_string()]);
        assert_eq!(s.holders_of("h"), 0);
    }

    #[test]
    fn slots_limit_and_free() {
        let s = Sessions::with_random_key(Duration::from_secs(3600));
        let (_, a) = s.create();
        a.claim_slot("x", 2).unwrap();
        a.claim_slot("http:4", 2).unwrap();
        a.claim_slot("x", 2).unwrap();
        assert_eq!(a.claim_slot("z", 2).unwrap_err().code, "quota_exceeded");
        a.free_slot("x");
        a.claim_slot("z", 2).unwrap();
        // Unlimited.
        for i in 0..10 {
            a.claim_slot(&i.to_string(), 0).unwrap();
        }
        let g = a.open_stream("z");
        assert_eq!(a.slots.lock().get("z").unwrap().open, 1);
        drop(g);
        assert_eq!(a.slots.lock().get("z").unwrap().open, 0);
    }
}
