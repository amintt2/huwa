//! Per-browser sessions (D11, spike level).
//!
//! Token: `v1.<sid>.<exp>.<mac>` — `sid` 16 random bytes (hex), `exp` Unix seconds, `mac` =
//! HMAC-SHA256(server key, `huwa/session/v1|<sid>|<exp>`) (hex). The token is a capability: it
//! goes in the `Authorization: Bearer` header of API calls and in media URL paths (`/s/<token>/…`,
//! players cannot send headers). Verified in constant time; the key lives in `<data>/token.key`
//! (or is random per process). The spike issues tokens without proof of a browser key: D11's
//! Ed25519 signature check comes later, the token format stays.
//!
//! Session state is in memory: torrents held (deduplicated by info hash across sessions, with a
//! reference count), stream slots (quota), HTTP proxy sessions and probes it opened. A valid token
//! unknown to this process (restart with a persisted key) gets a fresh, empty state.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use parking_lot::{Mutex, RwLock};
use ring::{hmac, rand::SecureRandom};

use crate::error::ApiError;

/// A stream slot with no open response and no request for this long is free again.
pub const SLOT_IDLE: Duration = Duration::from_secs(120);

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

#[derive(Debug)]
pub struct Session {
    pub id: String,
    pub expires_at: u64,
    pub last_seen: AtomicU64,
    /// Info hashes this session started (`startStream` / `prewarm`).
    pub torrents: Mutex<HashSet<String>>,
    /// Stream slots by info hash.
    slots: Mutex<HashMap<String, Slot>>,
    /// HTTP proxy session id → references taken by this session (`httpOpen`).
    pub http: Mutex<HashMap<u64, usize>>,
    pub probes: Mutex<HashSet<u64>>,
}

impl Session {
    fn new(id: String, expires_at: u64) -> Self {
        Self {
            id,
            expires_at,
            last_seen: AtomicU64::new(now_secs()),
            torrents: Default::default(),
            slots: Default::default(),
            http: Default::default(),
            probes: Default::default(),
        }
    }

    pub fn holds(&self, hex: &str) -> bool {
        self.torrents.lock().contains(hex)
    }

    pub fn owns_http(&self, id: u64) -> bool {
        self.http.lock().contains_key(&id)
    }

    /// Takes (or refreshes) the stream slot of `hex`. `limit` 0 = unlimited.
    pub fn claim_slot(&self, hex: &str, limit: usize) -> Result<(), ApiError> {
        let now = Instant::now();
        let mut slots = self.slots.lock();
        if let Some(s) = slots.get_mut(hex) {
            s.last = now;
            return Ok(());
        }
        slots.retain(|_, s| s.live(now));
        if limit > 0 && slots.len() >= limit {
            return Err(ApiError::quota(limit));
        }
        slots.insert(hex.to_string(), Slot { last: now, open: 0 });
        Ok(())
    }

    pub fn free_slot(&self, hex: &str) {
        self.slots.lock().remove(hex);
    }

    /// Live slots (open responses or recent activity).
    pub fn live_slots(&self) -> usize {
        let now = Instant::now();
        self.slots.lock().values().filter(|s| s.live(now)).count()
    }

    /// An open media response on `hex`'s slot (released by dropping the guard).
    pub fn open_stream(self: &Arc<Self>, hex: &str) -> StreamGuard {
        if let Some(s) = self.slots.lock().get_mut(hex) {
            s.open += 1;
            s.last = Instant::now();
        }
        StreamGuard { session: self.clone(), hex: hex.to_string() }
    }
}

/// Keeps a slot busy while a response body is being sent.
pub struct StreamGuard {
    session: Arc<Session>,
    hex: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(s) = self.session.slots.lock().get_mut(&self.hex) {
            s.open = s.open.saturating_sub(1);
            s.last = Instant::now();
        }
    }
}

pub struct Sessions {
    key: hmac::Key,
    ttl: Duration,
    map: RwLock<HashMap<String, Arc<Session>>>,
    /// Info hash → number of sessions holding it (D11 dedup with refcount).
    holders: Mutex<HashMap<String, usize>>,
}

const MAC_LABEL: &str = "huwa/session/v1";

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    ring::rand::SystemRandom::new().fill(&mut b).expect("system random");
    b
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

impl Sessions {
    pub fn new(key: [u8; 32], ttl: Duration) -> Self {
        Self { key: hmac::Key::new(hmac::HMAC_SHA256, &key), ttl, map: Default::default(), holders: Default::default() }
    }

    pub fn with_random_key(ttl: Duration) -> Self {
        Self::new(random_bytes::<32>(), ttl)
    }

    fn mac(&self, sid: &str, exp: u64) -> hmac::Tag {
        hmac::sign(&self.key, format!("{MAC_LABEL}|{sid}|{exp}").as_bytes())
    }

    /// A new session and its token.
    pub fn create(&self) -> (String, Arc<Session>) {
        let sid = hex::encode(random_bytes::<16>());
        let exp = now_secs() + self.ttl.as_secs();
        let token = format!("v1.{sid}.{exp}.{}", hex::encode(self.mac(&sid, exp).as_ref()));
        let s = Arc::new(Session::new(sid.clone(), exp));
        self.map.write().insert(sid, s.clone());
        (token, s)
    }

    /// Checks a token (format, MAC in constant time, expiry) and returns its session.
    pub fn verify(&self, token: &str) -> Result<Arc<Session>, ApiError> {
        let bad = || ApiError::unauthorized("invalid session token");
        let mut parts = token.split('.');
        let (Some("v1"), Some(sid), Some(exp), Some(mac), None) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
            return Err(bad());
        };
        if sid.len() != 32 || !sid.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            return Err(bad());
        }
        let exp: u64 = exp.parse().map_err(|_| bad())?;
        let mac = hex::decode(mac).map_err(|_| bad())?;
        hmac::verify(&self.key, format!("{MAC_LABEL}|{sid}|{exp}").as_bytes(), &mac).map_err(|_| bad())?;
        if exp <= now_secs() {
            self.drop_session(sid);
            return Err(ApiError::new(axum::http::StatusCode::UNAUTHORIZED, "session_expired", "session expired"));
        }
        if let Some(s) = self.map.read().get(sid) {
            s.last_seen.store(now_secs(), Ordering::Relaxed);
            return Ok(s.clone());
        }
        let s = self.map.write().entry(sid.to_string()).or_insert_with(|| Arc::new(Session::new(sid.to_string(), exp))).clone();
        Ok(s)
    }

    pub fn count(&self) -> usize {
        self.map.read().len()
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
        let held: Vec<String> = s.torrents.lock().iter().cloned().collect();
        held.into_iter().filter(|h| self.unhold(&s, h) == Some(0)).collect()
    }

    /// Expired sessions (janitor). Returns the info hashes nobody holds any more.
    pub fn sweep(&self) -> Vec<String> {
        let now = now_secs();
        let expired: Vec<String> = self.map.read().values().filter(|s| s.expires_at <= now).map(|s| s.id.clone()).collect();
        expired.iter().flat_map(|sid| self.drop_session(sid)).collect()
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
        a.claim_slot("y", 2).unwrap();
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
