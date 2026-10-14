//! Upstream address policy for server deployments (feature `server`).
//!
//! On a phone the read-ahead proxy only refuses loopback upstreams (the app's own servers). On a
//! server reachable by other people, the same proxy would be an SSRF primitive: a URL pointing at
//! the LAN, the Docker network, the cloud metadata service (169.254.169.254) or the server's own
//! loopback ports. This module decides which IP addresses an upstream may have, and enforces it
//! where it cannot be bypassed:
//!
//! - **in the DNS resolver** of the reqwest client (`PolicyResolver`): every connection, the first
//!   request as well as each redirect hop and each later range request, resolves its host here and
//!   only connects to addresses that pass. A host that answered with a public address at open and
//!   with a private one afterwards (DNS rebinding) is refused at connect time;
//! - **for IP literals** (`http://10.0.0.1/`, `http://[::ffff:127.0.0.1]/`), which reqwest never
//!   resolves: `UpstreamPolicy::check_url` before every request, and in the redirect policy
//!   (`redirect_policy`) for every `Location`;
//! - the client never uses an HTTP proxy from the environment (`no_proxy`): through a proxy the
//!   resolver would only see the proxy's name.
//!
//! Denied (unless stated otherwise): loopback (127/8, ::1), unspecified (0/8, ::), RFC 1918 private
//! (10/8, 172.16/12, 192.168/16), shared address space / CGNAT (100.64/10), link-local (169.254/16
//! — the metadata service — and fe80::/10), unique local (fc00::/7), site-local (fec0::/10),
//! IETF protocol assignments (192.0.0/24), benchmarking (198.18/15), multicast, reserved (240/4),
//! broadcast; IPv6 forms embedding an IPv4 address (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible
//! `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are judged by that IPv4 address.
//!
//! `allow_private` (env `HUWA_ALLOW_PRIVATE_UPSTREAMS=1`, for a self-hoster whose media server
//! lives on the LAN) lets RFC 1918, CGNAT and unique-local addresses through. Loopback, link-local
//! (metadata) and the rest stay denied whatever the setting; `allow_loopback` exists for tests.

use std::{
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
};

/// What an address is, for the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClass {
    Public,
    /// RFC 1918, CGNAT (100.64/10), unique local (fc00::/7): allowed with `allow_private`.
    Private,
    Loopback,
    /// 169.254/16 (cloud metadata), fe80::/10.
    LinkLocal,
    /// Unspecified, multicast, broadcast, reserved, documentation-free special ranges.
    Special,
}

fn classify_v4(ip: Ipv4Addr) -> IpClass {
    let [a, b, c, _] = ip.octets();
    if ip.is_loopback() {
        return IpClass::Loopback;
    }
    if ip.is_link_local() {
        return IpClass::LinkLocal;
    }
    if ip.is_private() || (a == 100 && (64..128).contains(&b)) {
        return IpClass::Private;
    }
    let special = a == 0 // "this network", incl. 0.0.0.0
        || ip.is_multicast() // 224/4
        || a >= 240 // reserved 240/4 and broadcast
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b & 0xfe) == 18); // benchmarking 198.18/15
    if special {
        IpClass::Special
    } else {
        IpClass::Public
    }
}

/// The IPv4 address an IPv6 address stands for, when it embeds one.
pub fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    let o = ip.octets();
    let tail = Ipv4Addr::new(o[12], o[13], o[14], o[15]);
    // IPv4-mapped ::ffff:a.b.c.d
    if s[..5] == [0; 5] && s[5] == 0xffff {
        return Some(tail);
    }
    // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks); not :: nor ::1.
    if s[..6] == [0; 6] && (s[6] != 0 || s[7] > 1) {
        return Some(tail);
    }
    // NAT64 well-known prefix 64:ff9b::/96
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return Some(tail);
    }
    // 6to4 2002:AABB:CCDD::/48
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(o[2], o[3], o[4], o[5]));
    }
    None
}

fn classify_v6(ip: Ipv6Addr) -> IpClass {
    if let Some(v4) = embedded_v4(ip) {
        return classify_v4(v4);
    }
    let s0 = ip.segments()[0];
    if ip.is_loopback() {
        return IpClass::Loopback;
    }
    if ip.is_unspecified() || ip.is_multicast() {
        return IpClass::Special;
    }
    if (s0 & 0xffc0) == 0xfe80 {
        return IpClass::LinkLocal;
    }
    if (s0 & 0xffc0) == 0xfec0 {
        // Deprecated site-local: never public.
        return IpClass::Special;
    }
    if (s0 & 0xfe00) == 0xfc00 {
        return IpClass::Private;
    }
    IpClass::Public
}

pub fn classify(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

/// Refusal of an upstream (address or URL). Carried inside reqwest / anyhow errors so callers can
/// tell it from a network failure (`is_blocked`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamBlocked(pub String);

impl fmt::Display for UpstreamBlocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "upstream not allowed: {}", self.0)
    }
}

impl std::error::Error for UpstreamBlocked {}

/// True when `err` (or one of its sources) is an `UpstreamBlocked`.
pub fn is_blocked(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if e.is::<UpstreamBlocked>() {
            return true;
        }
        cur = e.source();
    }
    false
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UpstreamPolicy {
    /// RFC 1918, CGNAT, unique-local upstreams (`HUWA_ALLOW_PRIVATE_UPSTREAMS`).
    pub allow_private: bool,
    /// Loopback upstreams: tests and the offline bench only.
    pub allow_loopback: bool,
}

impl UpstreamPolicy {
    pub fn allows(&self, ip: IpAddr) -> bool {
        match classify(ip) {
            IpClass::Public => true,
            IpClass::Private => self.allow_private,
            IpClass::Loopback => self.allow_loopback,
            IpClass::LinkLocal | IpClass::Special => false,
        }
    }

    /// What can be decided from the URL alone: scheme, IP literal, `localhost` names. A domain
    /// passes here; its addresses are judged by `PolicyResolver` at connect time.
    pub fn check_url(&self, url: &url::Url) -> Result<(), UpstreamBlocked> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(UpstreamBlocked(format!("scheme {}", url.scheme())));
        }
        if !url.username().is_empty() || url.password().is_some() {
            // Credentials in the URL are never forwarded upstream by the proxy anyway.
            return Err(UpstreamBlocked("credentials in url".into()));
        }
        match url.host() {
            None => Err(UpstreamBlocked("no host".into())),
            Some(url::Host::Ipv4(ip)) => self.check_ip(IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => self.check_ip(IpAddr::V6(ip)),
            Some(url::Host::Domain(d)) => {
                let d = d.trim_end_matches('.').to_ascii_lowercase();
                if !self.allow_loopback && (d == "localhost" || d.ends_with(".localhost")) {
                    return Err(UpstreamBlocked("localhost".into()));
                }
                Ok(())
            }
        }
    }

    pub fn check_ip(&self, ip: IpAddr) -> Result<(), UpstreamBlocked> {
        if self.allows(ip) {
            Ok(())
        } else {
            Err(UpstreamBlocked(format!("{:?} address", classify(ip)).to_lowercase()))
        }
    }

    /// Keeps the addresses that pass; refuses when none does.
    pub fn filter(&self, addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, UpstreamBlocked> {
        let total = addrs.len();
        let ok: Vec<SocketAddr> = addrs.into_iter().filter(|a| self.allows(a.ip())).collect();
        if ok.is_empty() {
            return Err(UpstreamBlocked(if total == 0 { "no address".into() } else { "resolves to a non-public address".into() }));
        }
        Ok(ok)
    }
}

/// Name resolution behind the policy (blocking; run on the blocking pool). Injectable for tests
/// (a resolver that changes its answer between calls simulates DNS rebinding).
pub trait Lookup: Send + Sync + 'static {
    fn lookup(&self, host: &str) -> std::io::Result<Vec<SocketAddr>>;
}

/// The system resolver (`getaddrinfo`).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup(&self, host: &str) -> std::io::Result<Vec<SocketAddr>> {
        use std::net::ToSocketAddrs;
        Ok((host, 0u16).to_socket_addrs()?.collect())
    }
}

/// Policy + resolver, shared by the client, the redirect policy and the open-time check.
#[derive(Clone)]
pub struct UpstreamGuard {
    pub policy: UpstreamPolicy,
    pub lookup: Arc<dyn Lookup>,
}

impl fmt::Debug for UpstreamGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UpstreamGuard").field("policy", &self.policy).finish_non_exhaustive()
    }
}

impl UpstreamGuard {
    pub fn new(policy: UpstreamPolicy) -> Self {
        Self { policy, lookup: Arc::new(SystemLookup) }
    }

    pub fn with_lookup(policy: UpstreamPolicy, lookup: Arc<dyn Lookup>) -> Self {
        Self { policy, lookup }
    }

    /// Early refusal at open (a clear error for the caller instead of a failing stream): URL
    /// checks, then one resolution of the host. Not the guarantee — `PolicyResolver` is, at every
    /// connection. A name that does not resolve now passes (the fetch reports it).
    pub fn precheck(&self, url: &url::Url) -> Result<(), UpstreamBlocked> {
        self.policy.check_url(url)?;
        if let Some(url::Host::Domain(d)) = url.host() {
            if let Ok(addrs) = self.lookup.lookup(d) {
                if !addrs.is_empty() {
                    self.policy.filter(addrs)?;
                }
            }
        }
        Ok(())
    }

    pub fn resolver(&self) -> PolicyResolver {
        PolicyResolver { guard: self.clone() }
    }

    /// Redirects re-checked hop by hop: scheme and IP literals here, domains by the resolver when
    /// the hop connects. At most `max` hops.
    pub fn redirect_policy(&self, max: usize) -> reqwest::redirect::Policy {
        let policy = self.policy;
        reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= max {
                return attempt.error("too many redirects");
            }
            match policy.check_url(attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(e) => attempt.error(e),
            }
        })
    }

    /// A reqwest client builder with the policy wired in (resolver, redirects, no env proxy).
    pub fn apply(&self, builder: reqwest::ClientBuilder, max_redirects: usize) -> reqwest::ClientBuilder {
        builder.no_proxy().dns_resolver(Arc::new(self.resolver())).redirect(self.redirect_policy(max_redirects))
    }
}

/// reqwest DNS resolver enforcing the policy on every connection.
pub struct PolicyResolver {
    guard: UpstreamGuard,
}

impl reqwest::dns::Resolve for PolicyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let guard = self.guard.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let lookup = guard.lookup.clone();
            let h = host.clone();
            let addrs = tokio::task::spawn_blocking(move || lookup.lookup(&h))
                .await
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error + Send + Sync>)??;
            let ok = guard.policy.filter(addrs).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
            Ok(Box::new(ok.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn classification() {
        for (s, want) in [
            ("8.8.8.8", IpClass::Public),
            ("1.1.1.1", IpClass::Public),
            ("100.63.255.255", IpClass::Public),
            ("100.128.0.1", IpClass::Public),
            ("172.32.0.1", IpClass::Public),
            ("127.0.0.1", IpClass::Loopback),
            ("127.255.0.9", IpClass::Loopback),
            ("10.0.0.1", IpClass::Private),
            ("172.16.5.4", IpClass::Private),
            ("172.31.255.255", IpClass::Private),
            ("192.168.1.1", IpClass::Private),
            ("100.64.0.1", IpClass::Private),
            ("100.127.255.254", IpClass::Private),
            ("169.254.169.254", IpClass::LinkLocal),
            ("169.254.0.1", IpClass::LinkLocal),
            ("0.0.0.0", IpClass::Special),
            ("0.1.2.3", IpClass::Special),
            ("224.0.0.1", IpClass::Special),
            ("255.255.255.255", IpClass::Special),
            ("240.0.0.1", IpClass::Special),
            ("192.0.0.170", IpClass::Special),
            ("198.18.0.1", IpClass::Special),
            ("2606:4700::1111", IpClass::Public),
            ("::1", IpClass::Loopback),
            ("::", IpClass::Special),
            ("fe80::1", IpClass::LinkLocal),
            ("febf::1", IpClass::LinkLocal),
            ("fc00::1", IpClass::Private),
            ("fd12:3456::1", IpClass::Private),
            ("fec0::1", IpClass::Special),
            ("ff02::1", IpClass::Special),
            // IPv4 embedded in IPv6: judged by the IPv4 address.
            ("::ffff:127.0.0.1", IpClass::Loopback),
            ("::ffff:10.0.0.1", IpClass::Private),
            ("::ffff:169.254.169.254", IpClass::LinkLocal),
            ("::ffff:8.8.8.8", IpClass::Public),
            ("::10.0.0.1", IpClass::Private),
            ("::127.0.0.1", IpClass::Loopback),
            ("64:ff9b::a9fe:a9fe", IpClass::LinkLocal),
            ("64:ff9b::808:808", IpClass::Public),
            ("2002:0a00:0001::1", IpClass::Private),
            ("2002:7f00:0001::1", IpClass::Loopback),
        ] {
            assert_eq!(classify(ip(s)), want, "{s}");
        }
    }

    #[test]
    fn default_policy_denies_everything_internal() {
        let p = UpstreamPolicy::default();
        for s in ["127.0.0.1", "10.0.0.1", "172.20.0.2", "192.168.0.10", "100.100.100.100", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1", "0.0.0.0"] {
            assert!(!p.allows(ip(s)), "{s}");
        }
        assert!(p.allows(ip("93.184.216.34")) && p.allows(ip("2a00:1450:4007::64")));
    }

    #[test]
    fn allow_private_keeps_loopback_and_metadata_denied() {
        let p = UpstreamPolicy { allow_private: true, allow_loopback: false };
        for s in ["10.0.0.1", "192.168.1.20", "100.64.1.1", "fd00::1", "::ffff:10.1.2.3"] {
            assert!(p.allows(ip(s)), "{s}");
        }
        for s in ["127.0.0.1", "::1", "169.254.169.254", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0", "224.0.0.251"] {
            assert!(!p.allows(ip(s)), "{s}");
        }
    }

    #[test]
    fn url_checks() {
        let p = UpstreamPolicy::default();
        let u = |s: &str| url::Url::parse(s).unwrap();
        for bad in [
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:8080/x",
            "http://[::1]/",
            "http://[::ffff:7f00:1]/",
            "http://[fe80::1]/",
            "http://0x7f000001/",
            "http://2130706433/",
            "http://0177.0.0.1/",
            "http://localhost/",
            "http://LOCALHOST./",
            "http://a.b.localhost/",
            "ftp://example.com/",
            "file:///etc/passwd",
            "http://user:pw@example.com/",
        ] {
            assert!(p.check_url(&u(bad)).is_err(), "{bad}");
        }
        for ok in ["https://example.com/a.mkv", "http://93.184.216.34/", "https://[2606:4700::1111]/"] {
            assert!(p.check_url(&u(ok)).is_ok(), "{ok}");
        }
    }

    #[test]
    fn filter_keeps_public_addresses_and_refuses_all_private() {
        let p = UpstreamPolicy::default();
        let a = |s: &str| SocketAddr::new(ip(s), 0);
        assert_eq!(p.filter(vec![a("10.0.0.1"), a("93.184.216.34")]).unwrap(), vec![a("93.184.216.34")]);
        assert!(p.filter(vec![a("10.0.0.1"), a("127.0.0.1")]).is_err());
        assert!(p.filter(vec![]).is_err());
    }

    /// Answers `first` once, then `then` (a rebinding DNS server).
    struct Rebinding {
        calls: AtomicUsize,
        first: IpAddr,
        then: IpAddr,
    }

    impl Lookup for Rebinding {
        fn lookup(&self, _host: &str) -> std::io::Result<Vec<SocketAddr>> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![SocketAddr::new(if n == 0 { self.first } else { self.then }, 0)])
        }
    }

    /// One-request HTTP server on 127.0.0.1; counts connections.
    fn local_server() -> (u16, Arc<AtomicUsize>) {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for s in l.incoming() {
                let Ok(mut s) = s else { return };
                h.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            }
        });
        (port, hits)
    }

    fn client(guard: &UpstreamGuard) -> reqwest::Client {
        guard.apply(reqwest::Client::builder(), 10).build().unwrap()
    }

    #[test]
    fn rebinding_is_refused_at_connect_time() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let (port, hits) = local_server();
        // Public at the open-time check, loopback when the request connects.
        let lookup = Arc::new(Rebinding { calls: AtomicUsize::new(0), first: ip("93.184.216.34"), then: ip("127.0.0.1") });
        let guard = UpstreamGuard::with_lookup(UpstreamPolicy::default(), lookup.clone());
        let url = url::Url::parse(&format!("http://rebind.test:{port}/x.mkv")).unwrap();
        assert!(guard.precheck(&url).is_ok(), "first answer is public");
        let err = rt.block_on(client(&guard).get(url.clone()).send()).unwrap_err();
        assert!(is_blocked(&err), "refused by the resolver: {err:?}");
        assert_eq!(hits.load(Ordering::SeqCst), 0, "never connected");
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 2);

        // Control: the same resolver with loopback allowed reaches the server.
        let open = UpstreamGuard::with_lookup(UpstreamPolicy { allow_private: false, allow_loopback: true }, lookup);
        let resp = rt.block_on(client(&open).get(url).send()).unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn precheck_refuses_a_name_resolving_to_private_addresses() {
        let lookup = Arc::new(Rebinding { calls: AtomicUsize::new(0), first: ip("10.0.0.1"), then: ip("10.0.0.1") });
        let guard = UpstreamGuard::with_lookup(UpstreamPolicy::default(), lookup);
        assert!(guard.precheck(&url::Url::parse("http://intranet.test/").unwrap()).is_err());
    }

    #[test]
    fn redirects_to_internal_addresses_are_refused() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        // A "public" upstream (loopback allowed for this hop only by the fake resolver mapping).
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for s in l.incoming() {
                let Ok(mut s) = s else { return };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
        struct Fixed;
        impl Lookup for Fixed {
            fn lookup(&self, _h: &str) -> std::io::Result<Vec<SocketAddr>> {
                Ok(vec![SocketAddr::from(([127, 0, 0, 1], 0))])
            }
        }
        // Loopback allowed so the first hop connects; the redirect to the metadata IP must not.
        let guard = UpstreamGuard::with_lookup(UpstreamPolicy { allow_private: true, allow_loopback: true }, Arc::new(Fixed));
        let err = rt.block_on(client(&guard).get(format!("http://cdn.test:{port}/a")).send()).unwrap_err();
        assert!(err.is_redirect() && is_blocked(&err), "{err:?}");
    }
}
