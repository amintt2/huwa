//! Huwa torrent core.
//!
//! One librqbit session (Apache-2.0, pinned to 9.0.1) plus a loopback HTTP server that serves
//! `/{infoHash}/{fileIdx}` with `Range` / `206` for the video player, and `/stats.json`.
//!
//! Layers:
//! - `priorities`: window policy (startup ~4 MiB, seek, container metadata) adapted from
//!   stream-server's `priorities.rs` (MIT).
//! - `range`: HTTP Range header parsing.
//! - `engine`: session, torrent registry, cache quota, persistence of our own metadata.
//! - `probe`: parallel swarm probes (metadata + answering peers, no piece downloaded).
//! - `server`: axum router bound to 127.0.0.1:<random port>.
//! - `api`: JSON dispatch used by both FFI flavours.
//! - `ffi`: C ABI (iOS / static library). `jni_android`: JNI exports (Android).
//!
//! NOTE: written against the real librqbit 9.0.1 sources but NOT compiled on the authoring machine
//! (no Rust toolchain available there). See README.md for the exact build commands.

pub mod api;
pub mod cache;
pub mod engine;
pub mod ffi;
pub mod priorities;
pub mod probe;
pub mod range;
pub mod server;

#[cfg(target_os = "android")]
pub mod jni_android;

/// Reported to JS as `nativeVersion`.
pub const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+librqbit-9.0.1");
