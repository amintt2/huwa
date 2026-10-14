//! Client address of a request (per-IP session limits, `/metrics` access).
//!
//! Without `HUWA_TRUST_PROXY` the TCP peer is the client. With it, the server is assumed to sit
//! behind one reverse proxy (Traefik, Caddy, nginx) that appends the address it saw to
//! `X-Forwarded-For` (or sets `X-Real-IP`): the right-most valid entry is used, so a client
//! cannot pick its address by sending its own header.

use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

/// The address of the client that sent the request.
pub fn client_ip(trust_proxy: bool, headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
    if trust_proxy {
        let forwarded = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .filter_map(|s| parse_ip(s.trim()))
            .last();
        if let Some(ip) = forwarded {
            return Some(ip);
        }
        if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()).and_then(|s| parse_ip(s.trim())) {
            return Some(ip);
        }
    }
    peer.map(|p| canonical(p.ip()))
}

/// `1.2.3.4`, `1.2.3.4:5678`, `::1`, `[::1]:443`.
fn parse_ip(s: &str) -> Option<IpAddr> {
    if let Ok(ip) = s.parse::<IpAddr>() {
        return Some(canonical(ip));
    }
    if let Ok(sa) = s.parse::<SocketAddr>() {
        return Some(canonical(sa.ip()));
    }
    None
}

/// IPv4-mapped IPv6 addresses as IPv4.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// The TCP peer is on this machine (and no reverse proxy relayed the request).
pub fn is_local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool {
    let relayed = headers.contains_key("x-forwarded-for") || headers.contains_key("x-real-ip") || headers.contains_key("forwarded");
    !relayed && peer.is_some_and(|p| canonical(p.ip()).is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn forwarded_addresses() {
        let peer: SocketAddr = "10.0.0.2:5000".parse().unwrap();
        let mut h = HeaderMap::new();
        assert_eq!(client_ip(true, &h, Some(peer)), Some("10.0.0.2".parse().unwrap()));
        h.insert("x-forwarded-for", HeaderValue::from_static("6.6.6.6, 203.0.113.5"));
        assert_eq!(client_ip(false, &h, Some(peer)), Some("10.0.0.2".parse().unwrap()), "not trusted");
        assert_eq!(client_ip(true, &h, Some(peer)), Some("203.0.113.5".parse().unwrap()), "right-most");
        h.insert("x-forwarded-for", HeaderValue::from_static("junk"));
        h.insert("x-real-ip", HeaderValue::from_static("[2001:db8::1]:443"));
        assert_eq!(client_ip(true, &h, Some(peer)), Some("2001:db8::1".parse().unwrap()));
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:1".parse().unwrap();
        assert!(is_local_request(&HeaderMap::new(), Some(mapped)));
        assert!(!is_local_request(&h, Some(mapped)));
        assert!(!is_local_request(&HeaderMap::new(), Some(peer)));
    }
}
