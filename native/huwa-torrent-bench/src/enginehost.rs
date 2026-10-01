//! Child-process control of the engine host (see `engine-host/`): JSON lines over stdin/stdout,
//! CPU / RSS sampling while it runs (proc_pidinfo) and final rusage (wait4) when it exits.
//! The host runs under `sandbox-exec` with outbound network limited to localhost, so the engine's
//! DHT bootstrap cannot reach the internet and every peer comes from the simulated swarm.

use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

const SANDBOX: &str = r#"(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))"#;

struct Io {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct EngineHost {
    pub pid: i32,
    io: Arc<Mutex<Io>>,
    child: Mutex<Option<Child>>,
    pub version: String,
    pub port: u16,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcUsage {
    pub user_s: f64,
    pub sys_s: f64,
    pub max_rss_bytes: u64,
}

impl EngineHost {
    pub async fn spawn(host_bin: &Path, config: &Value, sandbox: bool, stderr_log: &Path) -> Result<Self> {
        let log = std::fs::File::create(stderr_log)?;
        let mut cmd = if sandbox {
            let mut c = Command::new("/usr/bin/sandbox-exec");
            c.arg("-p").arg(SANDBOX).arg(host_bin);
            c
        } else {
            Command::new(host_bin)
        };
        cmd.arg(config.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .env("HUWA_LOG", std::env::var("HUWA_LOG").unwrap_or_else(|_| "warn".into()));
        let mut child = cmd.spawn().with_context(|| format!("spawning {host_bin:?}"))?;
        let pid = child.id() as i32;
        let stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let first = tokio::task::spawn_blocking(move || -> Result<(String, BufReader<ChildStdout>)> {
            let mut line = String::new();
            stdout.read_line(&mut line)?;
            Ok((line, stdout))
        })
        .await??;
        let (line, stdout) = first;
        let v: Value = serde_json::from_str(line.trim()).with_context(|| format!("host init line {line:?}"))?;
        let port = v
            .pointer("/init/ok/port")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("engine init failed: {line}"))? as u16;
        let version = v.get("version").and_then(Value::as_str).unwrap_or("?").to_string();
        Ok(Self { pid, io: Arc::new(Mutex::new(Io { stdin, stdout })), child: Mutex::new(Some(child)), version, port })
    }

    pub async fn call(&self, method: &str, args: Value) -> Result<Value> {
        let io = self.io.clone();
        let req = serde_json::json!({ "m": method, "a": args }).to_string();
        let line = tokio::task::spawn_blocking(move || -> Result<String> {
            let mut io = io.lock().unwrap_or_else(|e| e.into_inner());
            writeln!(io.stdin, "{req}")?;
            io.stdin.flush()?;
            let mut line = String::new();
            if io.stdout.read_line(&mut line)? == 0 {
                bail!("engine host closed stdout");
            }
            Ok(line)
        })
        .await??;
        let v: Value = serde_json::from_str(line.trim())?;
        if let Some(e) = v.get("error") {
            bail!("{method}: {e}");
        }
        Ok(v.get("ok").cloned().unwrap_or(Value::Null))
    }

    /// Resident size and cumulative CPU seconds right now.
    pub fn sample(&self) -> Option<(u64, f64)> {
        task_info(self.pid)
    }

    /// Asks the engine to shut down, waits (killing after `grace`), returns the rusage.
    pub async fn exit(&self, grace: Duration) -> Result<ProcUsage> {
        let io = self.io.clone();
        let _ = tokio::time::timeout(
            grace,
            tokio::task::spawn_blocking(move || {
                let mut io = io.lock().unwrap_or_else(|e| e.into_inner());
                let _ = writeln!(io.stdin, "{{\"m\":\"exit\"}}");
                let _ = io.stdin.flush();
                let mut line = String::new();
                let _ = io.stdout.read_line(&mut line);
            }),
        )
        .await;
        let child = self.child.lock().unwrap().take();
        let pid = self.pid;
        let usage = tokio::task::spawn_blocking(move || -> Result<ProcUsage> {
            let mut child = child.context("already exited")?;
            // Give it `grace` to exit by itself, then SIGKILL.
            let start = std::time::Instant::now();
            loop {
                let mut status = 0;
                let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
                // SAFETY: plain syscall on our own child.
                let r = unsafe { libc::wait4(pid, &mut status, libc::WNOHANG, &mut ru) };
                if r == pid {
                    std::mem::forget(child); // reaped by wait4 already
                    return Ok(ProcUsage {
                        user_s: ru.ru_utime.tv_sec as f64 + ru.ru_utime.tv_usec as f64 / 1e6,
                        sys_s: ru.ru_stime.tv_sec as f64 + ru.ru_stime.tv_usec as f64 / 1e6,
                        // macOS: bytes.
                        max_rss_bytes: ru.ru_maxrss as u64,
                    });
                }
                if r < 0 {
                    bail!("wait4 failed: {}", std::io::Error::last_os_error());
                }
                if start.elapsed() > Duration::from_secs(10) {
                    let _ = child.kill();
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
        .await??;
        Ok(usage)
    }
}

impl Drop for EngineHost {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[allow(deprecated)]
fn timebase() -> f64 {
    let mut tb = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: plain call filling a struct.
    unsafe { libc::mach_timebase_info(&mut tb) };
    if tb.denom == 0 {
        1.0
    } else {
        tb.numer as f64 / tb.denom as f64
    }
}

fn task_info(pid: i32) -> Option<(u64, f64)> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
    // SAFETY: buffer of the right size for PROC_PIDTASKINFO.
    let r = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if r != size {
        return None;
    }
    let ns = (info.pti_total_user + info.pti_total_system) as f64 * timebase();
    Some((info.pti_resident_size, ns / 1e9))
}
