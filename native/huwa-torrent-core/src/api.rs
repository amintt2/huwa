//! JSON dispatch shared by the C ABI and the JNI layer: one `call(method, args)` entry point keeps
//! the Swift / Kotlin glue minimal (and identical on both platforms).
//!
//! Methods (args → result):
//! - `startStream` `{infoHash, fileIdx?, sources?, name?}` → `{id, url, infoHash}`
//! - `status` `{id}` → `TorrentStatus`
//! - `list` `{}` → `TorrentStatus[]`
//! - `stats` `{}` → `EngineStats`
//! - `pause` / `resume` / `remove` `{id}` → `true`
//! - `clearCache` `{}` → `{freedBytes}`
//! - `enforceQuota` `{}` → `{freedBytes}`
//! - `setConfig` `{cacheLimitBytes?, downloadBps?, uploadBps?, seeding?}` → `Config`

use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::engine::{ConfigPatch, Engine, StartStreamRequest};

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
