//! Public tracker augmentation.
//!
//! Many addon magnets carry 0–2 trackers (sometimes dead ones). librqbit then relies on the DHT
//! alone, whose first `get_peers` answers take several seconds on a cold routing table. Adding a
//! handful of large, long-lived open trackers gives a second, independent peer source that
//! usually answers within one round trip (UDP tracker protocol, BEP 15).
//!
//! Policy:
//! - only UDP (BEP 15) and HTTPS announce URLs: no plain HTTP (announces in clear text over the
//!   carrier network), no `wss://` (WebTorrent, librqbit cannot use it);
//! - only when the magnet has fewer than `AUGMENT_BELOW` usable trackers: a magnet that already
//!   lists many trackers does not need more announces (data, battery);
//! - never more than `MAX_ADDED`; duplicates (same URL ignoring case and a trailing `/announce`)
//!   are skipped;
//! - the app can replace the built-in list with `Config.defaultTrackers` (those are then added by
//!   librqbit to every torrent and this list is not used).
//!
//! Private torrents are not affected: librqbit only keeps their first tracker.

/// Open trackers with a long track record (ngosang/trackerslist "best" over several years).
pub const PUBLIC_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://tracker.qu.ax:6969/announce",
];

/// Below this many usable trackers in the magnet, public ones are added.
pub const AUGMENT_BELOW: usize = 5;
/// Public trackers added at most.
pub const MAX_ADDED: usize = 6;

fn is_usable(url: &str) -> bool {
    url.starts_with("udp://") || url.starts_with("https://")
}

fn key(url: &str) -> String {
    let u = url.trim().to_ascii_lowercase();
    let u = u.trim_end_matches('/');
    u.strip_suffix("/announce").unwrap_or(u).to_string()
}

/// `trackers` (from the magnet / addon sources) plus public trackers when it has few usable ones.
/// Order is preserved: the torrent's own trackers first.
pub fn augment(mut trackers: Vec<String>) -> Vec<String> {
    let usable = trackers.iter().filter(|t| is_usable(t)).count();
    if usable >= AUGMENT_BELOW {
        return trackers;
    }
    let mut seen: Vec<String> = trackers.iter().map(|t| key(t)).collect();
    let mut added = 0;
    for t in PUBLIC_TRACKERS {
        if added >= MAX_ADDED || usable + added >= AUGMENT_BELOW.max(MAX_ADDED) {
            break;
        }
        let k = key(t);
        if seen.contains(&k) {
            continue;
        }
        seen.push(k);
        trackers.push((*t).to_string());
        added += 1;
    }
    trackers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_list_is_udp_or_https_only() {
        assert!(PUBLIC_TRACKERS.iter().all(|t| is_usable(t)));
        assert!(PUBLIC_TRACKERS.iter().all(|t| url::Url::parse(t).is_ok()));
    }

    #[test]
    fn empty_magnet_gets_public_trackers() {
        let out = augment(vec![]);
        assert_eq!(out.len(), MAX_ADDED);
        assert_eq!(out[0], PUBLIC_TRACKERS[0]);
    }

    #[test]
    fn own_trackers_stay_first_and_are_not_duplicated() {
        let own = vec!["udp://Tracker.Opentrackr.org:1337".to_string(), "http://legacy.example/announce".to_string()];
        let out = augment(own.clone());
        assert_eq!(&out[..2], &own[..]);
        // opentrackr already present (other spelling): not added again.
        assert_eq!(out.iter().filter(|t| key(t) == key(PUBLIC_TRACKERS[0])).count(), 1);
        // 1 usable own tracker + 5 added = 6 (MAX_ADDED caps the additions).
        assert_eq!(out.len(), 2 + 5);
    }

    #[test]
    fn well_tracked_magnet_is_left_alone() {
        let own: Vec<String> = (0..AUGMENT_BELOW).map(|i| format!("udp://t{i}.example:80/announce")).collect();
        assert_eq!(augment(own.clone()), own);
    }

    #[test]
    fn plain_http_trackers_do_not_count_as_usable() {
        let own: Vec<String> = (0..AUGMENT_BELOW).map(|i| format!("http://t{i}.example/announce")).collect();
        assert!(augment(own).len() > AUGMENT_BELOW);
    }
}
