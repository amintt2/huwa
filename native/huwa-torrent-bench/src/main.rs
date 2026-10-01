//! `tbench`: swarm simulator + streaming benchmark for huwa-torrent-core.
//! Normally driven by `scripts/torrent-bench.sh` (which builds the engine host for a given engine).
//!
//! Subcommands:
//!   gen-media --root <dir> [--only <id>]
//!   list
//!   run --root <dir> --label <l> --host <engine-host-bin> [--engine-info <json>] [--reps 3]
//!       [--only a,b] [--jobs 1] [--quick] [--no-sandbox] [--resume]
//!   summarize --root <dir> --label <l>
//!   compare --root <dir> <labelA> <labelB>

mod enginehost;
mod media;
mod player;
mod report;
mod runner;
mod scenarios;
mod seeders;
mod shaper;
mod tracker;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{bail, Context, Result};

struct Args {
    positional: Vec<String>,
    flags: HashMap<String, String>,
}

fn parse_args() -> Args {
    let mut positional = Vec::new();
    let mut flags = HashMap::new();
    let mut it = std::env::args().skip(1).peekable();
    while let Some(a) = it.next() {
        if let Some(k) = a.strip_prefix("--") {
            let boolean = matches!(k, "quick" | "no-sandbox" | "resume");
            let v = if boolean { "1".to_string() } else { it.next().unwrap_or_default() };
            flags.insert(k.to_string(), v);
        } else {
            positional.push(a);
        }
    }
    Args { positional, flags }
}

impl Args {
    fn get(&self, k: &str) -> Option<&str> {
        self.flags.get(k).map(String::as_str)
    }
    fn root(&self) -> PathBuf {
        PathBuf::from(self.get("root").unwrap_or("/private/tmp/claude-501/tbench"))
    }
}

fn main() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(std::env::var("TBENCH_LOG").unwrap_or_else(|_| "error".into())))
        .with_writer(std::io::stderr)
        .try_init();
    let args = parse_args();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(6).enable_all().build()?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    match cmd.as_str() {
        "gen-media" => {
            rt.block_on(media::generate(&args.root(), args.get("only")))?;
        }
        "list" => {
            for s in scenarios::all() {
                println!("{:<22} {:<22} {:>3} peers  {:<5} {}", s.name, s.media, s.peers.len(), s.client.name, s.description);
            }
        }
        "run" => rt.block_on(run(&args))?,
        "summarize" => {
            let label = args.get("label").context("--label")?;
            let dir = args.root().join("results").join(label);
            let info = std::fs::read_to_string(dir.join("engine.json")).unwrap_or_default();
            print!("{}", report::write_summary(&dir, label, &info)?);
        }
        "compare" => {
            let (a, b) = match (args.positional.get(1), args.positional.get(2)) {
                (Some(a), Some(b)) => (a.clone(), b.clone()),
                _ => bail!("compare <labelA> <labelB>"),
            };
            let root = args.root();
            let md = report::compare(&root.join("results").join(&a), &root.join("results").join(&b), &a, &b)?;
            let out = root.join("compare");
            std::fs::create_dir_all(&out)?;
            let path = out.join(format!("{a}-vs-{b}.md"));
            std::fs::write(&path, &md)?;
            print!("{md}");
            eprintln!("written to {path:?}");
        }
        _ => {
            eprintln!("usage: tbench gen-media|list|run|summarize|compare … (see scripts/torrent-bench.sh)");
            std::process::exit(2);
        }
    }
    // librqbit sessions may keep background tasks: do not wait for them.
    rt.shutdown_background();
    Ok(())
}

async fn run(args: &Args) -> Result<()> {
    let root = args.root();
    let label = args.get("label").context("--label")?.to_string();
    let host = PathBuf::from(args.get("host").context("--host <engine host binary>")?);
    let reps: usize = args.get("reps").unwrap_or("3").parse()?;
    let jobs: usize = args.get("jobs").unwrap_or("1").parse()?;
    let quick = args.get("quick").is_some();
    let sandbox = args.get("no-sandbox").is_none();
    let resume = args.get("resume").is_some();
    let only: Option<Vec<String>> = args.get("only").map(|s| s.split(',').map(str::to_string).collect());

    let medias = media::load(&root)?;
    let out = root.join("results").join(&label);
    std::fs::create_dir_all(out.join("runs"))?;
    let engine_info = match args.get("engine-info") {
        Some(p) => std::fs::read_to_string(p).unwrap_or_default(),
        None => format!("{{\"host\":\"{}\"}}", host.display()),
    };
    std::fs::write(out.join("engine.json"), &engine_info)?;

    let scs: Vec<_> = scenarios::all()
        .into_iter()
        .filter(|s| only.as_ref().is_none_or(|o| o.iter().any(|x| s.name.contains(x.as_str()))))
        .collect();
    if scs.is_empty() {
        bail!("no scenario matches");
    }
    // Group by media so each seeder pool is built once.
    let mut groups: Vec<(String, Vec<scenarios::Scenario>)> = Vec::new();
    for s in scs {
        match groups.iter_mut().find(|(m, _)| m == s.media) {
            Some((_, v)) => v.push(s),
            None => groups.push((s.media.to_string(), vec![s])),
        }
    }
    let total: usize = groups.iter().map(|(_, v)| v.len() * reps).sum();
    let mut done = 0usize;
    let started = std::time::Instant::now();
    for (media_id, scs) in groups {
        let media = medias.iter().find(|m| m.id == media_id).with_context(|| format!("media {media_id} not generated"))?.clone();
        let max_peers = scs.iter().map(|s| s.peers.len()).max().unwrap_or(1);
        eprintln!("== media {media_id}: starting {max_peers} seeders…");
        let pool = Arc::new(seeders::SeederPool::start(&media, max_peers).await?);
        // Repetitions interleaved (rep 0 of everything, then rep 1…) so slow drifts spread evenly.
        let mut work = Vec::new();
        for rep in 0..reps {
            for s in &scs {
                work.push((s.clone(), rep));
            }
        }
        let sem = Arc::new(tokio::sync::Semaphore::new(jobs.max(1)));
        let mut set = tokio::task::JoinSet::new();
        for (sc, rep) in work {
            let file = out.join("runs").join(format!("{}-r{rep}.json", sc.name));
            if resume && file.exists() {
                done += 1;
                continue;
            }
            let permit = sem.clone().acquire_owned().await?;
            let pool = pool.clone();
            let media = media.clone();
            let host = host.clone();
            let label = label.clone();
            let root = root.clone();
            set.spawn(async move {
                let _permit = permit;
                let ctx = runner::RunCtx {
                    label: &label,
                    host_bin: &host,
                    sandbox,
                    run_dir: root.join("runs").join(&label).join(format!("{}-r{rep}", sc.name)),
                    quick,
                };
                let res = runner::run_once(&ctx, &sc, rep, &media, &pool).await;
                (sc, rep, file, res)
            });
            // Drain finished runs as we go (keeps progress output timely).
            while let Some(j) = set.try_join_next() {
                done += 1;
                report_one(j?, done, total, started);
            }
        }
        while let Some(j) = set.join_next().await {
            done += 1;
            report_one(j?, done, total, started);
        }
        if let Ok(pool) = Arc::try_unwrap(pool) {
            pool.stop().await;
        }
    }
    let md = report::write_summary(&out, &label, &engine_info)?;
    println!("{md}");
    eprintln!("results: {out:?}");
    Ok(())
}

fn report_one(
    (sc, rep, file, res): (scenarios::Scenario, usize, PathBuf, Result<runner::RunResult>),
    done: usize,
    total: usize,
    started: std::time::Instant,
) {
    let el = started.elapsed().as_secs();
    match res {
        Ok(r) => {
            let _ = write_json(&file, &r);
            eprintln!(
                "[{done}/{total} {el}s] {:<18} r{rep}: meta {} ttfb {} playable {} stalls {} ({:.1}s) seeks {} wire {:.0} MB {}",
                sc.name,
                fmt(r.metadata_s),
                fmt(r.player.probe_ttfb_s),
                fmt(r.player.playable_s),
                r.player.stalls,
                r.player.stall_time_s,
                r.player.seeks.iter().map(|s| fmt(s.ready_s)).collect::<Vec<_>>().join(","),
                r.wire_down_bytes as f64 / 1e6,
                r.error.as_deref().map(|e| format!("ERR {}", e.chars().take(160).collect::<String>())).unwrap_or_default(),
            );
        }
        Err(e) => {
            eprintln!("[{done}/{total} {el}s] {:<18} r{rep}: HARNESS ERROR {e:#}", sc.name);
            let r = runner::RunResult { scenario: sc.name.into(), rep, media: sc.media.into(), error: Some(format!("harness: {e:#}")), ..Default::default() };
            let _ = write_json(&file, &r);
        }
    }
}

fn fmt(v: Option<f64>) -> String {
    v.map(|x| format!("{x:.1}")).unwrap_or_else(|| "—".into())
}

fn write_json(path: &Path, v: &impl serde::Serialize) -> Result<()> {
    std::fs::write(path, serde_json::to_vec_pretty(v)?)?;
    Ok(())
}
