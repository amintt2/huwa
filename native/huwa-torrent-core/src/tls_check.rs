//! `tlsCheck` `{url}` → `{url, status, bytes, ms}`: one HTTPS GET through a default
//! `reqwest::Client`, i.e. the same TLS stack (rustls + rustls-platform-verifier) as librqbit's
//! tracker announces (librqbit `Session::new` builds a default client too) and the HTTP proxy.
//!
//! Diagnostics only, never called by the app: on Android it is reached from the CI self-test
//! receiver (`HuwaTorrentTlsCheckReceiver`, disabled and not exported), to prove on an emulator that
//! the verifier was initialised (`nativeInitTls`) and checks certificates. A certificate refusal
//! comes back as an error, not a panic.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(15);
/// The body is read up to this many bytes (the check only needs the handshake and a response).
const MAX_BODY: usize = 64 * 1024;

pub fn check(args: &Value) -> Result<Value> {
    let url = args.get("url").and_then(Value::as_str).ok_or_else(|| anyhow!("missing `url`"))?;
    let parsed = url::Url::parse(url).with_context(|| format!("invalid url {url:?}"))?;
    if parsed.scheme() != "https" {
        bail!("https only: {url:?}");
    }
    // Own small runtime: works without the torrent engine or the proxy. A panic in the TLS stack
    // either unwinds into the FFI's catch_unwind (request future, this thread) or is caught by
    // tokio (connection task) and reported as a failed request.
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().context("tokio runtime")?;
    rt.block_on(async {
        let started = Instant::now();
        let client = reqwest::Client::builder().timeout(TIMEOUT).build().context("http client")?;
        let mut res = client.get(parsed).send().await.map_err(|e| anyhow!("{}", chain(&e)))?;
        let status = res.status().as_u16();
        let mut bytes = 0usize;
        while bytes < MAX_BODY {
            match res.chunk().await.map_err(|e| anyhow!("{}", chain(&e)))? {
                Some(c) => bytes += c.len(),
                None => break,
            }
        }
        Ok(json!({ "url": url, "status": status, "bytes": bytes, "ms": started.elapsed().as_millis() as u64 }))
    })
}

/// reqwest's top-level message is generic ("error sending request"): keep the causes (the TLS one
/// names the certificate problem).
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn rejects_bad_arguments() {
        assert!(check(&json!({})).unwrap_err().to_string().contains("missing `url`"));
        assert!(check(&json!({ "url": "not a url" })).unwrap_err().to_string().contains("invalid url"));
        assert!(check(&json!({ "url": "http://127.0.0.1:9/" })).unwrap_err().to_string().contains("https only"));
    }

    /// A server that is not TLS: the handshake fails and comes back as an error (no panic).
    #[test]
    fn handshake_failure_is_an_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
            }
        });
        let err = check(&json!({ "url": format!("https://127.0.0.1:{port}/") })).unwrap_err();
        assert!(err.to_string().contains("error sending request"), "{err:#}");
        server.join().unwrap();
    }
}
