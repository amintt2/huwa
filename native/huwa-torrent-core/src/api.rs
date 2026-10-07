//! JSON dispatch shared by the C ABI and the JNI layer: one `call(method, args)` entry point keeps
//! the Swift / Kotlin glue minimal (and identical on both platforms).
//!
//! Methods (args → result):
//! - `startStream` `{infoHash, fileIdx?, sources?, name?, metered?}` → `{id, url, infoHash}`
//!   (`metered`: cellular, only a ~60–90 s window is downloaded, see `streaming.rs`)
//!   (`url` ends with the file's extension once the metadata is known: `/{hash}/{idx}.mkv`)
//! - `status` `{id}` → `TorrentStatus` (`start`: timeline of the latest start, see `timeline.rs`)
//! - `list` `{}` → `TorrentStatus[]`
//! - `stats` `{}` → `EngineStats`
//! - `pause` / `resume` / `remove` `{id}` → `true`
//! - `clearCache` `{}` → `{freedBytes}`
//! - `enforceQuota` `{}` → `{freedBytes}`
//! - `setConfig` `{cacheLimitBytes?, downloadBps?, uploadBps?, seeding?}` → `Config`
//! - `probeStart` `{infoHash, sources?, name?, fileIdx?, filename?, episode?, timeoutMs?, minPeers?}`
//!   → `ProbeStatus` (returns at once; the probe runs in the background, see `probe.rs`)
//! - `probeStatus` `{id}` → `ProbeStatus`; `{ids}` → `ProbeStatus[]` (unknown ids left out)
//! - `probeCancel` `{id}` | `{ids}` → `true`
//! - `httpOpen` / `httpPrefetch` / `httpRelease` / `httpStatus`: the HTTP read-ahead proxy, see
//!   `http_proxy.rs` (dispatched by `ffi::call_json` before this, without the torrent engine)

use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::{
    engine::{ConfigPatch, Engine, StartStreamRequest},
    probe::{self, ProbeRequest},
};

fn id_of(args: &Value) -> Result<String> {
    args.get("id")
        .or_else(|| args.get("infoHash"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .ok_or_else(|| anyhow!("missing `id`"))
}

pub fn dispatch(engine: &Arc<Engine>, method: &str, args: Value) -> Result<Value> {
    match method {
        "startStream" => {
            let req: StartStreamRequest = serde_json::from_value(args)?;
            Ok(serde_json::to_value(engine.start_stream(req)?)?)
        }
        "prewarm" => {
            let req: StartStreamRequest = serde_json::from_value(args)?;
            Ok(serde_json::to_value(engine.prewarm(req)?)?)
        }
        "status" => Ok(serde_json::to_value(engine.status(&id_of(&args)?)?)?),
        "list" => Ok(serde_json::to_value(engine.list())?),
        "stats" => Ok(serde_json::to_value(engine.stats())?),
        "pause" => {
            let id = id_of(&args)?;
            engine.runtime.block_on(engine.pause(&id))?;
            Ok(Value::Bool(true))
        }
        "resume" => {
            let id = id_of(&args)?;
            engine.runtime.block_on(engine.resume(&id))?;
            Ok(Value::Bool(true))
        }
        // The player left this torrent (screen closed, other episode): playback ended, torrent
        // paused, no longer the focus. Cheap and idempotent; `startStream` brings it back.
        "release" => {
            let id = id_of(&args)?;
            let at = args.get("at").and_then(Value::as_u64);
            Ok(Value::Bool(engine.release(&id, at)?))
        }
        "remove" => {
            let id = id_of(&args)?;
            engine.runtime.block_on(engine.remove(&id))?;
            Ok(Value::Bool(true))
        }
        "clearCache" => {
            let freed = engine.runtime.block_on(engine.clear_cache())?;
            Ok(json!({ "freedBytes": freed }))
        }
        "enforceQuota" => {
            let freed = engine.runtime.block_on(engine.enforce_quota())?;
            Ok(json!({ "freedBytes": freed }))
        }
        "setConfig" => {
            let patch: ConfigPatch = serde_json::from_value(args)?;
            Ok(serde_json::to_value(engine.update_config(patch))?)
        }
        "probeStart" => {
            let req: ProbeRequest = serde_json::from_value(args)?;
            Ok(serde_json::to_value(probe::start(engine, req)?)?)
        }
        "probeStatus" => {
            if let Some(id) = args.get("id").and_then(Value::as_u64) {
                let p = engine.probes.get(id).ok_or_else(|| anyhow!("unknown probe {id}"))?;
                return Ok(serde_json::to_value(p.status())?);
            }
            let list: Vec<_> = probe::ids_of(&args)?.into_iter().filter_map(|id| engine.probes.get(id)).map(|p| p.status()).collect();
            Ok(serde_json::to_value(list)?)
        }
        "probeCancel" => {
            for id in probe::ids_of(&args)? {
                engine.probes.cancel(id);
            }
            Ok(Value::Bool(true))
        }
        other => Err(anyhow!("unknown method {other:?}")),
    }
}

/// Envelope returned to the native side: `{"ok": <value>}` or `{"error": "<message>"}`.
pub fn envelope(result: Result<Value>) -> String {
    let v = match result {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": format!("{e:#}") }),
    };
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_shapes() {
        assert_eq!(envelope(Ok(json!(1))), r#"{"ok":1}"#);
        assert_eq!(envelope(Err(anyhow!("boom"))), r#"{"error":"boom"}"#);
    }

    #[test]
    fn id_extraction() {
        assert_eq!(id_of(&json!({ "id": " ABC " })).unwrap(), "abc");
        assert_eq!(id_of(&json!({ "infoHash": "DEF" })).unwrap(), "def");
        assert!(id_of(&json!({})).is_err());
    }
}
