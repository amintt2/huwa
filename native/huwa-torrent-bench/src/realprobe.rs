//! `probe-real`: real swarms, metadata + handshakes ONLY, through the engine's own probe
//! (`probeStart` / `probeStatus` / `probeCancel`, see huwa-torrent-core `probe.rs`).
//!
//! Hard constraint: this never calls `startStream`, so no piece of these real torrents is
//! requested, nothing is written to disk and nothing is seeded (the engine host runs with
//! `seeding` off and no listener). The engine data folder is checked to be empty at the end.
//!
//! Input: `<root>/real/candidates.json` (scripts/torrent-real-sample.mjs select).
//! Output: `<root>/real/probes.json`, one record per probed torrent with the status timeline.

use std::{path::Path, time::Duration};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::Instant;

use crate::enginehost::EngineHost;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub t: f64,
    pub state: String,
    pub peers: u64,
    pub connected: u64,
    pub meta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRecord {
    pub tier: String,
    pub anilist: u64,
    pub title: String,
    pub info_hash: String,
    pub announced_seeders: Option<u64>,
    pub final_state: String,
    pub meta_ms: Option<u64>,
    /// First time (ms) with metadata + file + ≥ 3 answering peers (the app's "healthy").
    pub healthy_ms: Option<u64>,
    pub max_peers: u64,
    pub max_connected: u64,
    pub file_size: Option<u64>,
    pub file_count: Option<u64>,
    pub error: Option<String>,
    pub timeline: Vec<Point>,
}

const DEADLINE_MS: u64 = 30_000;
const APP_MIN_PEERS: u64 = 3;

pub async fn run(root: &Path, host_bin: &Path) -> Result<()> {
    let dir = root.join("real");
    let cands: Vec<Value> = serde_json::from_slice(&std::fs::read(dir.join("candidates.json")).context("real/candidates.json")?)?;
    let data_dir = dir.join("engine-data");
    let _ = std::fs::remove_dir_all(&data_dir);
    let config = json!({ "dataDir": data_dir, "cacheLimitBytes": 1u64 << 30, "seeding": false });
    // No sandbox: the probe needs the internet (DHT, trackers, real peers).
    let host = EngineHost::spawn(host_bin, &config, false, &dir.join("probe-engine.log")).await?;
    eprintln!("engine {} on port {}", host.version, host.port);

    let out_path = dir.join("probes.json");
    let mut records: Vec<ProbeRecord> = std::fs::read(&out_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();

    for c in &cands {
        let tier = c["tier"].as_str().unwrap_or("?").to_string();
        let anilist = c["anilist"].as_u64().unwrap_or(0);
        let title = c["title"].as_str().unwrap_or("?").to_string();
        let top = c["top"].as_array().cloned().unwrap_or_default();
        let todo: Vec<&Value> = top
            .iter()
            .filter(|t| !records.iter().any(|r| r.anilist == anilist && Some(r.info_hash.as_str()) == t["infoHash"].as_str()))
            .collect();
        if todo.is_empty() {
            continue;
        }
        // The app races the top torrents of an episode in parallel: same here, one episode at a time.
        let mut started = Vec::new();
        for t in &todo {
            let mut req = json!({
                "infoHash": t["infoHash"],
                "sources": t["sources"],
                "episode": t["episode"],
                "timeoutMs": DEADLINE_MS,
                "minPeers": 40,
            });
            if let Some(i) = t["fileIdx"].as_u64() {
                req["fileIdx"] = json!(i);
            }
            if let Some(f) = t["filename"].as_str() {
                req["filename"] = json!(f);
            }
            match host.call("probeStart", req).await {
                Ok(st) => started.push((t, st["id"].as_u64(), Instant::now(), Vec::<Point>::new(), None::<Value>)),
                Err(e) => started.push((t, None, Instant::now(), Vec::new(), Some(json!({ "error": e.to_string() })))),
            }
        }
        let t0 = Instant::now();
        loop {
            let mut all_final = true;
            for (_, id, at, tl, last) in started.iter_mut() {
                let Some(id) = *id else { continue };
                if last.as_ref().is_some_and(|l| is_final(l)) {
                    continue;
                }
                if let Ok(st) = host.call("probeStatus", json!({ "id": id })).await {
                    tl.push(Point {
                        t: at.elapsed().as_secs_f64(),
                        state: st["state"].as_str().unwrap_or("?").into(),
                        peers: st["peers"].as_u64().unwrap_or(0),
                        connected: st["connected"].as_u64().unwrap_or(0),
                        meta: st["metaMs"].as_u64().is_some(),
                    });
                    if !is_final(&st) {
                        all_final = false;
                    }
                    *last = Some(st);
                } else {
                    all_final = false;
                }
            }
            if all_final || t0.elapsed() > Duration::from_millis(DEADLINE_MS + 15_000) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let ids: Vec<u64> = started.iter().filter_map(|s| s.1).collect();
        let _ = host.call("probeCancel", json!({ "ids": ids })).await;

        for (t, _, _, tl, last) in started {
            let last = last.unwrap_or(Value::Null);
            let meta_ms = last["metaMs"].as_u64();
            let has_file = last["fileIdx"].as_u64().is_some();
            // The probe reports meta_ms only once known; the first timeline point where the app's
            // rule holds gives "healthy".
            let healthy_ms = if has_file {
                tl.iter().find(|p| p.meta && p.connected >= APP_MIN_PEERS).map(|p| (p.t * 1000.0) as u64)
            } else {
                None
            };
            let rec = ProbeRecord {
                tier: tier.clone(),
                anilist,
                title: title.clone(),
                info_hash: t["infoHash"].as_str().unwrap_or("").into(),
                announced_seeders: t["seeders"].as_u64(),
                final_state: last["state"].as_str().unwrap_or("error").into(),
                meta_ms,
                healthy_ms,
                max_peers: tl.iter().map(|p| p.peers).max().unwrap_or(0),
                max_connected: tl.iter().map(|p| p.connected).max().unwrap_or(0),
                file_size: last["fileSize"].as_u64(),
                file_count: last["fileCount"].as_u64(),
                error: last["error"].as_str().map(str::to_string),
                timeline: tl,
            };
            eprintln!(
                "{:<8} {:<34} {} 👤{:>4} → meta {:>6} answering {:>2} seen {:>3} healthy {:>6} {}",
                rec.tier,
                rec.title.chars().take(34).collect::<String>(),
                &rec.info_hash[..8.min(rec.info_hash.len())],
                rec.announced_seeders.map(|s| s.to_string()).unwrap_or("?".into()),
                rec.meta_ms.map(|m| format!("{:.1}s", m as f64 / 1000.0)).unwrap_or("✗".into()),
                rec.max_connected,
                rec.max_peers,
                rec.healthy_ms.map(|m| format!("{:.1}s", m as f64 / 1000.0)).unwrap_or("—".into()),
                rec.final_state,
            );
            records.push(rec);
        }
        std::fs::write(&out_path, serde_json::to_vec_pretty(&records)?)?;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    let _ = host.exit(Duration::from_secs(10)).await;
    // Proof that nothing was downloaded: no file at all under the torrents folder.
    let files = count_files(&data_dir.join("torrents"));
    eprintln!("engine data folder after probing: {files} file(s) under torrents/ (must be 0)");
    std::fs::write(dir.join("probe-disk-check.txt"), format!("files under engine-data/torrents after probing: {files}\n"))?;
    let _ = std::fs::remove_dir_all(&data_dir);
    Ok(())
}

fn is_final(st: &Value) -> bool {
    matches!(st["state"].as_str(), Some("healthy" | "weak" | "noFile" | "failed" | "cancelled"))
}

fn count_files(p: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| if e.path().is_dir() { count_files(&e.path()) } else { 1 })
        .sum()
}
