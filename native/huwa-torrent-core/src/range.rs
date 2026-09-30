//! HTTP `Range` header parsing (RFC 9110 §14.1.2), byte ranges only.
//!
//! Policy:
//! - no header / unparseable header / `start > end` → `Full` (the header is ignored, 200).
//! - `start >= len`, suffix of 0 bytes, or empty resource → `Unsatisfiable` (416).
//! - several ranges (`bytes=0-1,5-9`) → only the first is served (no multipart bodies).
//! - `end` past the resource is clamped to `len - 1`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    /// Serve the whole resource with 200.
    Full,
    /// Serve `[start, end)` with 206. `end` is exclusive and `<= len`.
    Partial { start: u64, end: u64 },
    /// Answer 416 with `Content-Range: bytes */len`.
    Unsatisfiable,
}

impl RangeSpec {
    pub fn len(&self, total: u64) -> u64 {
        match self {
            RangeSpec::Full => total,
            RangeSpec::Partial { start, end } => end - start,
            RangeSpec::Unsatisfiable => 0,
        }
    }
}

pub fn parse_range(header: Option<&str>, len: u64) -> RangeSpec {
    let Some(header) = header else {
        return RangeSpec::Full;
    };
    let header = header.trim();
    let Some(spec) = header.strip_prefix("bytes=") else {
        return RangeSpec::Full;
    };
    // First range only.
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((start, end)) = first.split_once('-') else {
        return RangeSpec::Full;
    };
    let (start, end) = (start.trim(), end.trim());

    if len == 0 {
        return RangeSpec::Unsatisfiable;
    }

    if start.is_empty() {
        // Suffix range: last N bytes.
        let Ok(suffix) = end.parse::<u64>() else {
            return RangeSpec::Full;
        };
        if suffix == 0 {
            return RangeSpec::Unsatisfiable;
        }
        let start = len.saturating_sub(suffix);
        return RangeSpec::Partial { start, end: len };
    }

    let Ok(start_n) = start.parse::<u64>() else {
        return RangeSpec::Full;
    };
    if start_n >= len {
        return RangeSpec::Unsatisfiable;
    }
    let end_excl = if end.is_empty() {
        len
    } else {
        let Ok(end_n) = end.parse::<u64>() else {
            return RangeSpec::Full;
        };
        if end_n < start_n {
            return RangeSpec::Full;
        }
        end_n.saturating_add(1).min(len)
    };
    RangeSpec::Partial { start: start_n, end: end_excl }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_header_is_full() {
        assert_eq!(parse_range(None, 100), RangeSpec::Full);
    }

    #[test]
    fn closed_range() {
        assert_eq!(parse_range(Some("bytes=0-9"), 100), RangeSpec::Partial { start: 0, end: 10 });
        assert_eq!(parse_range(Some("bytes=10-10"), 100), RangeSpec::Partial { start: 10, end: 11 });
    }

    #[test]
    fn open_ended_range() {
        assert_eq!(parse_range(Some("bytes=50-"), 100), RangeSpec::Partial { start: 50, end: 100 });
    }

    #[test]
    fn end_is_clamped_to_len() {
        assert_eq!(parse_range(Some("bytes=90-500"), 100), RangeSpec::Partial { start: 90, end: 100 });
    }

    #[test]
    fn suffix_range() {
        assert_eq!(parse_range(Some("bytes=-10"), 100), RangeSpec::Partial { start: 90, end: 100 });
        // Suffix larger than the resource → whole resource as 206.
        assert_eq!(parse_range(Some("bytes=-1000"), 100), RangeSpec::Partial { start: 0, end: 100 });
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn start_past_end_is_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=100-"), 100), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=200-300"), 100), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn empty_resource_is_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn garbage_is_ignored() {
        assert_eq!(parse_range(Some("items=0-9"), 100), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=abc"), 100), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=9-3"), 100), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=x-3"), 100), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=-"), 100), RangeSpec::Full);
    }

    #[test]
    fn multi_range_serves_first() {
        assert_eq!(parse_range(Some("bytes=0-1, 5-9"), 100), RangeSpec::Partial { start: 0, end: 2 });
    }

    #[test]
    fn whitespace_tolerant() {
        assert_eq!(parse_range(Some("  bytes= 5 - 7 "), 100), RangeSpec::Partial { start: 5, end: 8 });
    }

    #[test]
    fn len_helper() {
        assert_eq!(RangeSpec::Full.len(42), 42);
        assert_eq!(RangeSpec::Partial { start: 10, end: 20 }.len(42), 10);
        assert_eq!(RangeSpec::Unsatisfiable.len(42), 0);
    }
}
