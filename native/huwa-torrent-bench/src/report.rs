//! Aggregation (median / p90 over repetitions), Markdown summary, before/after comparison.

use std::{collections::BTreeMap, fmt::Write as _, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{runner::RunResult, scenarios};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub median: Option<f64>,
    pub p90: Option<f64>,
    pub n: usize,
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = p * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
}

pub fn stat(values: impl IntoIterator<Item = Option<f64>>) -> Stat {
    let mut v: Vec<f64> = values.into_iter().flatten().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return Stat::default();
    }
    Stat { median: Some(pct(&v, 0.5)), p90: Some(pct(&v, 0.9)), n: v.len() }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummary {
    pub scenario: String,
    pub description: String,
    pub media: String,
    pub runs: usize,
    pub failed_runs: usize,
    pub metrics: BTreeMap<String, Stat>,
    pub seek_timeouts: usize,
    pub seeks_total: usize,
    /// Runs whose very first HTTP request failed (fatal for AVPlayer, retried by ExoPlayer).
    pub first_request_failed: usize,
    pub errors: Vec<String>,
}

/// Metric keys, unit, "lower is better", description (used by the summary and the comparison).
pub const METRICS: &[(&str, &str, bool, &str)] = &[
    ("metadata_s", "s", true, "startStream → metadata"),
    ("first_byte_s", "s", true, "startStream → first body byte (probe)"),
    ("playable_s", "s", true, "startStream → 5 s buffered at the data start"),
    ("http_errors", "", true, "failed HTTP requests the player had to retry (5xx / resets)"),
    ("stalls", "", true, "stalls in the watch window"),
    ("stall_time_s", "s", true, "total stall time in the watch window"),
    ("longest_stall_s", "s", true, "longest stall in the watch window"),
    ("seek_ttfb_s", "s", true, "seek → first byte (all seeks)"),
    ("seek_ready_s", "s", true, "seek → 5 s buffered (all seeks)"),
    ("seek50_ready_s", "s", true, "seek to 50 % → 5 s buffered (timeout counted as 45 s)"),
    ("seek95_ready_s", "s", true, "seek to 95 % → 5 s buffered (timeout counted as 45 s)"),
    ("seek_stall_time_s", "s", true, "stall time after seeks (sum per run)"),
    ("avg_mbps", "Mbit/s", false, "average wire throughput"),
    ("peak_mbps", "Mbit/s", false, "peak 1 s wire throughput"),
    ("wire_overhead", "x", true, "wire bytes / verified bytes"),
    ("fetched_per_needed", "x", false, "verified bytes / bytes the player read"),
    ("peers_max", "", false, "max live peers"),
    ("peers_mean", "", false, "mean live peers"),
    ("cpu_s", "s", true, "engine CPU time (user+sys)"),
    ("rss_mb", "MB", true, "engine peak RSS"),
];

fn run_metrics(r: &RunResult) -> BTreeMap<&'static str, Vec<Option<f64>>> {
    let mut m: BTreeMap<&'static str, Vec<Option<f64>>> = BTreeMap::new();
    let p = &r.player;
    let playable = p.playable_s.is_some();
    m.entry("metadata_s").or_default().push(r.metadata_s);
    m.entry("first_byte_s").or_default().push(p.probe_ttfb_s);
    m.entry("playable_s").or_default().push(p.playable_s);
    m.entry("http_errors").or_default().push(Some(p.http_errors as f64));
    m.entry("stalls").or_default().push(playable.then_some(p.stalls as f64));
    m.entry("stall_time_s").or_default().push(playable.then_some(p.stall_time_s));
    m.entry("longest_stall_s").or_default().push(playable.then_some(p.longest_stall_s));
    for s in &p.seeks {
        m.entry("seek_ttfb_s").or_default().push(s.ttfb_s);
        m.entry("seek_ready_s").or_default().push(s.ready_s);
        let censored = Some(s.ready_s.unwrap_or(45.0));
        if (s.target_frac - 0.5).abs() < 1e-6 {
            m.entry("seek50_ready_s").or_default().push(censored);
        } else if (s.target_frac - 0.95).abs() < 1e-6 {
            m.entry("seek95_ready_s").or_default().push(censored);
        }
    }
    m.entry("seek_stall_time_s")
        .or_default()
        .push((!p.seeks.is_empty()).then(|| p.seeks.iter().map(|s| s.stall_time_after_s).sum()));
    m.entry("avg_mbps").or_default().push(Some(r.avg_down_bps / 1e6));
    m.entry("peak_mbps").or_default().push(Some(r.peak_down_bps / 1e6));
    m.entry("wire_overhead")
        .or_default()
        .push((r.engine_progress_bytes > 0).then(|| r.wire_down_bytes as f64 / r.engine_progress_bytes as f64));
    m.entry("fetched_per_needed")
        .or_default()
        .push((p.unique_bytes > 0).then(|| r.engine_progress_bytes as f64 / p.unique_bytes as f64));
    m.entry("peers_max").or_default().push(Some(r.peers_live_max as f64));
    m.entry("peers_mean").or_default().push(Some(r.peers_live_mean));
    m.entry("cpu_s").or_default().push((r.cpu_s > 0.0).then_some(r.cpu_s));
    m.entry("rss_mb").or_default().push((r.max_rss_bytes > 0).then(|| r.max_rss_bytes as f64 / 1e6));
    m
}

pub fn summarize(runs: &[RunResult]) -> Vec<ScenarioSummary> {
    let descs: BTreeMap<&str, &str> = scenarios::all().iter().map(|s| (s.name, s.description)).collect();
    let order: Vec<&str> = scenarios::all().iter().map(|s| s.name).collect();
    let mut by: BTreeMap<String, Vec<&RunResult>> = BTreeMap::new();
    for r in runs {
        by.entry(r.scenario.clone()).or_default().push(r);
    }
    let mut out = Vec::new();
    let mut names: Vec<String> = by.keys().cloned().collect();
    names.sort_by_key(|n| order.iter().position(|o| o == n).unwrap_or(usize::MAX));
    for name in names {
        let rs = &by[&name];
        let mut acc: BTreeMap<&'static str, Vec<Option<f64>>> = BTreeMap::new();
        for r in rs {
            for (k, v) in run_metrics(r) {
                acc.entry(k).or_default().extend(v);
            }
        }
        let seeks_total = rs.iter().map(|r| r.player.seeks.len()).sum();
        let seek_timeouts = rs.iter().flat_map(|r| &r.player.seeks).filter(|s| s.ready_s.is_none()).count();
        // Same error text across repetitions is reported once, with its count.
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for r in rs {
            let mut msgs: Vec<String> = Vec::new();
            if let Some(e) = &r.error {
                msgs.push(e.clone());
            }
            if let Some(f) = &r.player.first_error {
                msgs.push(format!("first HTTP error {f}"));
            }
            for m in msgs {
                let norm: String = m
                    .split_whitespace()
                    .map(|w| if w.starts_with("t=") && w.ends_with("s") { "t=…" } else { w })
                    .collect::<Vec<_>>()
                    .join(" ");
                *counts.entry(norm).or_default() += 1;
            }
        }
        let mut errors: Vec<String> = counts.into_iter().map(|(m, c)| format!("{c}/{} runs: {m}", rs.len())).collect();
        errors.truncate(6);
        out.push(ScenarioSummary {
            scenario: name.clone(),
            description: descs.get(name.as_str()).unwrap_or(&"").to_string(),
            media: rs[0].media.clone(),
            runs: rs.len(),
            failed_runs: rs.iter().filter(|r| r.player.playable_s.is_none()).count(),
            metrics: acc.into_iter().map(|(k, v)| (k.to_string(), stat(v))).collect(),
            seek_timeouts,
            seeks_total,
            first_request_failed: rs.iter().filter(|r| r.player.first_request_failed).count(),
            errors,
        });
    }
    out
}

fn f(v: Option<f64>) -> String {
    match v {
        None => "—".into(),
        Some(x) if x.abs() >= 100.0 => format!("{x:.0}"),
        Some(x) if x.abs() >= 10.0 => format!("{x:.1}"),
        Some(x) => format!("{x:.2}"),
    }
}

fn mp(s: Option<&Stat>) -> String {
    match s {
        Some(s) if s.n > 0 => format!("{} / {}", f(s.median), f(s.p90)),
        _ => "—".into(),
    }
}

pub fn markdown(label: &str, engine_info: &str, sums: &[ScenarioSummary], runs: &[RunResult]) -> String {
    let mut md = String::new();
    let _ = writeln!(md, "# Torrent streaming bench — `{label}`\n");
    let _ = writeln!(md, "Engine: `{}`  ", engine_info.trim());
    if let Some(r) = runs.first() {
        let _ = writeln!(md, "Engine version string: `{}`  ", r.engine_version);
    }
    let reps = sums.iter().map(|s| s.runs).max().unwrap_or(0);
    let _ = writeln!(
        md,
        "Runs: {} ({} scenarios, up to {reps} repetitions). Cells are **median / p90** over repetitions (seek cells: over every seek of every repetition).\n",
        runs.len(),
        sums.len()
    );
    let _ = writeln!(md, "## Startup\n");
    let _ = writeln!(md, "| scenario | media | ok | 1st request failed | metadata s | first byte s | playable s | HTTP errors |");
    let _ = writeln!(md, "|---|---|---|---|---|---|---|---|");
    for s in sums {
        let _ = writeln!(
            md,
            "| {} | {} | {}/{} | {}/{} | {} | {} | {} | {} |",
            s.scenario,
            s.media,
            s.runs - s.failed_runs,
            s.runs,
            s.first_request_failed,
            s.runs,
            mp(s.metrics.get("metadata_s")),
            mp(s.metrics.get("first_byte_s")),
            mp(s.metrics.get("playable_s")),
            mp(s.metrics.get("http_errors")),
        );
    }
    let _ = writeln!(md, "\n## Playback (watch window) and seeks\n");
    let _ = writeln!(md, "| scenario | stalls | stall time s | longest stall s | seek first byte s | seek ready s | seek→50 % ready s | seek→95 % ready s | seek timeouts | stall after seeks s |");
    let _ = writeln!(md, "|---|---|---|---|---|---|---|---|---|---|");
    for s in sums {
        let _ = writeln!(
            md,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {}/{} | {} |",
            s.scenario,
            mp(s.metrics.get("stalls")),
            mp(s.metrics.get("stall_time_s")),
            mp(s.metrics.get("longest_stall_s")),
            mp(s.metrics.get("seek_ttfb_s")),
            mp(s.metrics.get("seek_ready_s")),
            mp(s.metrics.get("seek50_ready_s")),
            mp(s.metrics.get("seek95_ready_s")),
            s.seek_timeouts,
            s.seeks_total,
            mp(s.metrics.get("seek_stall_time_s")),
        );
    }
    let _ = writeln!(md, "\n## Network and resources\n");
    let _ = writeln!(md, "| scenario | avg Mbit/s | peak Mbit/s | wire/verified | verified/needed | peers max | peers mean | CPU s | RSS MB |");
    let _ = writeln!(md, "|---|---|---|---|---|---|---|---|---|");
    for s in sums {
        let _ = writeln!(
            md,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            s.scenario,
            mp(s.metrics.get("avg_mbps")),
            mp(s.metrics.get("peak_mbps")),
            mp(s.metrics.get("wire_overhead")),
            mp(s.metrics.get("fetched_per_needed")),
            mp(s.metrics.get("peers_max")),
            mp(s.metrics.get("peers_mean")),
            mp(s.metrics.get("cpu_s")),
            mp(s.metrics.get("rss_mb")),
        );
    }
    let errs: Vec<_> = sums.iter().filter(|s| !s.errors.is_empty()).collect();
    if !errs.is_empty() {
        let _ = writeln!(md, "\n## Errors seen by the player (first per run)\n");
        for s in errs {
            for e in &s.errors {
                let e: String = e.chars().take(300).collect();
                let _ = writeln!(md, "- `{}` {}", s.scenario, e.replace('|', "/"));
            }
        }
    }
    let _ = writeln!(md, "\n## Scenarios\n");
    for s in scenarios::all() {
        if sums.iter().any(|x| x.scenario == s.name) {
            let _ = writeln!(md, "- `{}` ({}, {}{}): {}", s.name, s.media, s.client.name, if s.expect_stalls { ", stalls expected" } else { "" }, s.description);
        }
    }
    let _ = writeln!(md, "\n## Metric definitions\n");
    for (k, unit, lower, d) in METRICS {
        let _ = writeln!(md, "- `{k}` ({}{}): {d}", if unit.is_empty() { "count" } else { unit }, if *lower { ", lower is better" } else { "" });
    }
    md
}

pub fn load_runs(dir: &Path) -> Result<Vec<RunResult>> {
    let mut runs = Vec::new();
    let rd = std::fs::read_dir(dir.join("runs")).with_context(|| format!("{:?}/runs", dir))?;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("json") {
            let b = std::fs::read(&p)?;
            match serde_json::from_slice::<RunResult>(&b) {
                Ok(r) => runs.push(r),
                Err(err) => eprintln!("skipping {p:?}: {err}"),
            }
        }
    }
    runs.sort_by(|a, b| (a.scenario.clone(), a.rep).cmp(&(b.scenario.clone(), b.rep)));
    Ok(runs)
}

pub fn write_summary(dir: &Path, label: &str, engine_info: &str) -> Result<String> {
    let runs = load_runs(dir)?;
    let sums = summarize(&runs);
    std::fs::write(dir.join("summary.json"), serde_json::to_vec_pretty(&sums)?)?;
    let md = markdown(label, engine_info, &sums, &runs);
    std::fs::write(dir.join("summary.md"), &md)?;
    Ok(md)
}

/// Before/after comparison on the medians.
pub fn compare(a_dir: &Path, b_dir: &Path, a: &str, b: &str) -> Result<String> {
    let sa = summarize(&load_runs(a_dir)?);
    let sb = summarize(&load_runs(b_dir)?);
    let info = |d: &Path| std::fs::read_to_string(d.join("engine.json")).unwrap_or_default();
    let mut md = String::new();
    let _ = writeln!(md, "# Torrent bench comparison: `{a}` → `{b}`\n");
    let _ = writeln!(md, "- `{a}`: `{}`", info(a_dir).trim());
    let _ = writeln!(md, "- `{b}`: `{}`\n", info(b_dir).trim());
    let _ = writeln!(
        md,
        "Medians over repetitions (p90 in parentheses). Δ% is relative to `{a}`; a verdict is given when the change exceeds 10 % and the absolute change is meaningful.\n"
    );

    let key: &[&str] = &["metadata_s", "first_byte_s", "playable_s", "stalls", "stall_time_s", "seek50_ready_s", "seek95_ready_s", "avg_mbps", "wire_overhead", "cpu_s", "rss_mb"];
    let (mut better, mut worse) = (0, 0);
    let mut lines = Vec::new();
    for x in &sa {
        let Some(y) = sb.iter().find(|y| y.scenario == x.scenario) else { continue };
        let _ = writeln!(md, "### {} — {}\n", x.scenario, x.description);
        let _ = writeln!(md, "| metric | {a} | {b} | Δ | Δ% | verdict |");
        let _ = writeln!(md, "|---|---|---|---|---|---|");
        let _ = writeln!(md, "| playable runs | {}/{} | {}/{} | | | {} |", x.runs - x.failed_runs, x.runs, y.runs - y.failed_runs, y.runs,
            match (x.failed_runs, y.failed_runs) { (p, q) if q < p => "better", (p, q) if q > p => "worse", _ => "" });
        let _ = writeln!(md, "| 1st request failed | {}/{} | {}/{} | | | {} |", x.first_request_failed, x.runs, y.first_request_failed, y.runs,
            match (x.first_request_failed, y.first_request_failed) { (p, q) if q < p => "better", (p, q) if q > p => "worse", _ => "" });
        let _ = writeln!(md, "| seek timeouts | {}/{} | {}/{} | | | {} |", x.seek_timeouts, x.seeks_total, y.seek_timeouts, y.seeks_total,
            match (x.seek_timeouts, y.seek_timeouts) { (p, q) if q < p => "better", (p, q) if q > p => "worse", _ => "" });
        for (k, unit, lower, _) in METRICS {
            let (Some(sx), Some(sy)) = (x.metrics.get(*k), y.metrics.get(*k)) else { continue };
            let (Some(mx), Some(my)) = (sx.median, sy.median) else {
                let _ = writeln!(md, "| {k} | {} | {} | | | |", mp(Some(sx)), mp(Some(sy)));
                continue;
            };
            let d = my - mx;
            let dp = if mx.abs() > 1e-9 { Some(d / mx * 100.0) } else { None };
            // Absolute floors so noise on tiny values does not produce verdicts.
            let floor = match *unit { "s" => 0.3, "" => 0.5, "x" => 0.03, "Mbit/s" => 0.3, "MB" => 5.0, _ => 0.0 };
            let significant = d.abs() >= floor && dp.map(|p| p.abs() >= 10.0).unwrap_or(d.abs() >= floor);
            let verdict = if !significant {
                ""
            } else if (d < 0.0) == *lower {
                better += key.contains(k) as usize;
                "better"
            } else {
                worse += key.contains(k) as usize;
                "worse"
            };
            if !verdict.is_empty() && key.contains(k) {
                lines.push(format!("- `{}` {k}: {} → {} ({verdict})", x.scenario, f(Some(mx)), f(Some(my))));
            }
            let _ = writeln!(
                md,
                "| {k}{} | {} ({}) | {} ({}) | {}{} | {} | {verdict} |",
                if unit.is_empty() { String::new() } else { format!(" ({unit})") },
                f(Some(mx)),
                f(sx.p90),
                f(Some(my)),
                f(sy.p90),
                if d >= 0.0 { "+" } else { "" },
                f(Some(d)),
                dp.map(|p| format!("{p:+.0} %")).unwrap_or_default(),
            );
        }
        let _ = writeln!(md);
    }
    let mut head = String::new();
    let _ = writeln!(head, "## Overview\n\nKey metrics ({}) changed significantly: {better} better, {worse} worse.\n", key.join(", "));
    for l in &lines {
        let _ = writeln!(head, "{l}");
    }
    let _ = writeln!(head);
    // Insert the overview after the intro paragraph.
    let pos = md.find("### ").unwrap_or(md.len());
    md.insert_str(pos, &head);
    Ok(md)
}
