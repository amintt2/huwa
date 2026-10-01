//! Engine host: runs one huwa-torrent-core engine in its own process and exposes the app's C ABI
//! (`huwa_torrent_init` / `huwa_torrent_call` / `huwa_torrent_shutdown`) over stdin/stdout JSON
//! lines. The harness only relies on this ABI (the same one Swift/Kotlin use), so every engine
//! version that keeps it can be benchmarked unchanged.
//!
//! argv[1] = config JSON (engine::Config). First stdout line: `{"init":<envelope>,"version":"…"}`.
//! Then each stdin line `{"m":"<method>","a":{…}}` gets one stdout line with the envelope.
//! `{"m":"exit"}` shuts the engine down and exits.

use std::{
    ffi::{CStr, CString},
    io::{BufRead, Write},
};

use huwa_torrent_core::ffi;

fn take(p: *mut std::ffi::c_char) -> String {
    // SAFETY: pointers returned by the engine's C ABI, freed exactly once here.
    unsafe {
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        ffi::huwa_torrent_string_free(p);
        s
    }
}

fn main() {
    let filter = std::env::var("HUWA_LOG").unwrap_or_else(|_| "warn".into());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();

    let cfg = std::env::args().nth(1).expect("usage: tbench-engine-host <config-json>");
    let cfg = CString::new(cfg).expect("config");
    // SAFETY: valid NUL-terminated strings.
    let init = take(unsafe { ffi::huwa_torrent_init(cfg.as_ptr()) });
    let version = unsafe { CStr::from_ptr(ffi::huwa_torrent_version()) }.to_string_lossy().into_owned();
    let stdout = std::io::stdout();
    {
        let mut out = stdout.lock();
        let _ = writeln!(out, "{{\"init\":{init},\"version\":{}}}", serde_json::Value::String(version));
        let _ = out.flush();
    }

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(stdout.lock(), "{}", serde_json::json!({ "error": format!("bad request: {e}") }));
                continue;
            }
        };
        let method = v.get("m").and_then(|m| m.as_str()).unwrap_or("");
        let reply = if method == "exit" {
            ffi::huwa_torrent_shutdown();
            "{\"ok\":true}".to_string()
        } else {
            let args = v.get("a").map(|a| a.to_string()).unwrap_or_else(|| "{}".into());
            let m = CString::new(method).unwrap_or_default();
            let a = CString::new(args).unwrap_or_default();
            // SAFETY: valid NUL-terminated strings.
            take(unsafe { ffi::huwa_torrent_call(m.as_ptr(), a.as_ptr()) })
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
        if method == "exit" {
            break;
        }
    }
}
