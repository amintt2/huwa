//! C ABI (see `include/huwa_torrent.h`). Used directly by Swift on iOS and by the JNI shim on
//! Android. All strings are UTF-8, NUL-terminated. Strings returned as `char*` must be released
//! with `huwa_torrent_string_free`. Every function catches panics: nothing unwinds into the
//! foreign caller.

use std::{
    ffi::{c_char, CStr, CString},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};

use anyhow::{anyhow, Result};
use parking_lot::RwLock;
use serde_json::Value;

use crate::{
    api,
    engine::{Config, Engine},
    server,
};

static ENGINE: RwLock<Option<Arc<Engine>>> = RwLock::new(None);
static VERSION_C: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "+librqbit-9.0.1\0").as_bytes();

/// # Safety
/// `ptr` must be NULL or point to a valid NUL-terminated string.
unsafe fn cstr(ptr: *const c_char) -> Result<&'static str> {
    if ptr.is_null() {
        return Err(anyhow!("null pointer"));
    }
    // SAFETY: caller guarantees a valid NUL-terminated string for the duration of the call.
    let s = unsafe { CStr::from_ptr(ptr) };
    s.to_str().map_err(|e| anyhow!("invalid utf-8: {e}"))
}

fn to_c(s: String) -> *mut c_char {
    // Interior NULs cannot appear in serde_json output; fall back to an error envelope otherwise.
    CString::new(s)
        .unwrap_or_else(|_| CString::new(r#"{"error":"interior NUL"}"#).expect("static"))
        .into_raw()
}

fn guarded(f: impl FnOnce() -> Result<Value>) -> *mut c_char {
    let res = catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|p| {
        let msg = p
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| p.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        Err(anyhow!("panic: {msg}"))
    });
    to_c(api::envelope(res))
}

pub fn engine() -> Result<Arc<Engine>> {
    ENGINE.read().clone().ok_or_else(|| anyhow!("engine not initialised"))
}

/// Shared by FFI and JNI. Idempotent: returns the existing engine's port when already running.
pub fn init_from_json(config_json: &str) -> Result<Value> {
    if let Some(e) = ENGINE.read().as_ref() {
        return Ok(serde_json::json!({ "port": e.port(), "version": crate::VERSION, "alreadyRunning": true }));
    }
    let config: Config = serde_json::from_str(config_json)?;
    let engine = Engine::new(config)?;
    let port = engine.runtime.block_on(server::start(engine.clone()))?;
    *ENGINE.write() = Some(engine);
    Ok(serde_json::json!({ "port": port, "version": crate::VERSION, "alreadyRunning": false }))
}

pub fn call_json(method: &str, args_json: &str) -> Result<Value> {
    let engine = engine()?;
    let args: Value = if args_json.trim().is_empty() { Value::Object(Default::default()) } else { serde_json::from_str(args_json)? };
    api::dispatch(&engine, method, args)
}

pub fn shutdown_engine() {
    let taken = ENGINE.write().take();
    if let Some(e) = taken {
        let _ = catch_unwind(AssertUnwindSafe(|| e.shutdown()));
    }
}

/// Static version string, never freed.
#[no_mangle]
pub extern "C" fn huwa_torrent_version() -> *const c_char {
    VERSION_C.as_ptr() as *const c_char
}

/// Starts the engine. `config_json`: see `engine::Config` (camelCase keys, `dataDir` required).
/// Returns `{"ok":{"port":N,"version":"…"}}` or `{"error":"…"}`.
///
/// # Safety
/// `config_json` must be NULL or a valid NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn huwa_torrent_init(config_json: *const c_char) -> *mut c_char {
    guarded(|| {
        // SAFETY: forwarded contract.
        let cfg = unsafe { cstr(config_json)? };
        init_from_json(cfg)
    })
}

/// Generic dispatcher, see `api::dispatch`. Blocking: call from a background thread.
///
/// # Safety
/// Both pointers must be NULL or valid NUL-terminated UTF-8 strings.
#[no_mangle]
pub unsafe extern "C" fn huwa_torrent_call(method: *const c_char, args_json: *const c_char) -> *mut c_char {
    guarded(|| {
        // SAFETY: forwarded contract.
        let method = unsafe { cstr(method)? };
        let args = if args_json.is_null() { "" } else { unsafe { cstr(args_json)? } };
        call_json(method, args)
    })
}

/// Releases a string returned by `huwa_torrent_init` / `huwa_torrent_call`.
///
/// # Safety
/// `s` must be NULL or a pointer previously returned by this library and not yet freed.
#[no_mangle]
pub unsafe extern "C" fn huwa_torrent_string_free(s: *mut c_char) {
    if !s.is_null() {
        // SAFETY: pointer came from `CString::into_raw` in `to_c`.
        drop(unsafe { CString::from_raw(s) });
    }
}

/// Stops the session (pauses torrents, persists state). Safe to call twice.
#[no_mangle]
pub extern "C" fn huwa_torrent_shutdown() {
    shutdown_engine();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_nul_terminated() {
        let s = unsafe { CStr::from_ptr(huwa_torrent_version()) };
        assert!(s.to_str().unwrap().contains("librqbit-9.0.1"));
    }

    #[test]
    fn call_without_engine_is_an_error_envelope() {
        let m = CString::new("list").unwrap();
        let out = unsafe { huwa_torrent_call(m.as_ptr(), std::ptr::null()) };
        let s = unsafe { CStr::from_ptr(out) }.to_str().unwrap().to_string();
        unsafe { huwa_torrent_string_free(out) };
        assert!(s.contains("\"error\""), "{s}");
    }

    #[test]
    fn null_method_is_rejected() {
        let out = unsafe { huwa_torrent_call(std::ptr::null(), std::ptr::null()) };
        let s = unsafe { CStr::from_ptr(out) }.to_str().unwrap().to_string();
        unsafe { huwa_torrent_string_free(out) };
        assert!(s.contains("null pointer"));
    }
}
