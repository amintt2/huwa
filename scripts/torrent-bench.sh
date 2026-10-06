#!/usr/bin/env bash
# Swarm simulator + streaming benchmark for native/huwa-torrent-core.
#
# Everything is local: synthetic media (ffmpeg test pattern), librqbit seeders with upload on,
# userspace shaping proxies (bandwidth / shared uplink / latency / jitter / stalls / churn),
# a loopback HTTP tracker, and a "player" that drives the engine's loopback HTTP Range server.
# The engine under test runs in its own process (engine host, built against ANY engine path or
# git ref), sandboxed so it cannot reach the internet (DHT bootstrap is blocked).
#
# Usage:
#   scripts/torrent-bench.sh media                                  # generate media + .torrent files (once)
#   scripts/torrent-bench.sh build   --engine <dir|git-ref> --label <label>
#   scripts/torrent-bench.sh run     --engine <dir|git-ref> --label <label> [--reps 3] [--jobs 2] [--only <regex>] [--quick]
#   scripts/torrent-bench.sh compare <labelA> <labelB>               # Markdown diff (before → after)
#   scripts/torrent-bench.sh list                                   # scenario matrix
#   scripts/torrent-bench.sh clean-media                            # delete generated media (~5 GB)
#
# Examples:
#   scripts/torrent-bench.sh run --engine huwa-v1 --label baseline
#   scripts/torrent-bench.sh run --engine ../huwa-tperf/native/huwa-torrent-core --label tperf
#   scripts/torrent-bench.sh compare baseline tperf
#
# --engine accepts a directory containing the engine's Cargo.toml (a worktree, a checkout…) or a
# git ref of this repository (exported with `git archive` into the bench root first).
#
# Outputs (never in the repo): ${TBENCH_ROOT:-/private/tmp/claude-501/tbench}/
#   media/                 media files, .torrent, profiles (media.json)
#   build/<label>/         engine host crate + target dir + engine.json (what was built)
#   results/<label>/       runs/*.json (one per run), results.json, summary.md
#   compare/<a>-vs-<b>.md  comparison
#
# Rust: needs a stable toolchain >= 1.89; ffmpeg/ffprobe for `media`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$ROOT/native/huwa-torrent-bench"
TB="${TBENCH_ROOT:-/private/tmp/claude-501/tbench}"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH"

mkdir -p "$TB"

die() { echo "error: $*" >&2; exit 1; }

build_tbench() {
  CARGO_TARGET_DIR="$TB/build/tbench-target" cargo build --release --quiet --manifest-path "$BENCH/Cargo.toml"
  TBENCH="$TB/build/tbench-target/release/tbench"
}

# resolve_engine <dir|ref> <label> → sets ENGINE_DIR (absolute)
resolve_engine() {
  local spec="$1" label="$2"
  if [ -f "$spec/Cargo.toml" ]; then
    ENGINE_DIR="$(cd "$spec" && pwd)"
    return
  fi
  git -C "$ROOT" rev-parse --verify --quiet "$spec^{commit}" >/dev/null || die "--engine $spec is neither an engine directory nor a git ref"
  local dest="$TB/src/$label"
  rm -rf "$dest" && mkdir -p "$dest"
  git -C "$ROOT" archive "$spec" native/huwa-torrent-core native/vendor | tar -x -C "$dest"
  ENGINE_DIR="$dest/native/huwa-torrent-core"
  echo "$(git -C "$ROOT" rev-parse "$spec")" > "$dest/REF"
}

build_host() {
  local label="$1"
  local dir="$TB/build/$label"
  mkdir -p "$dir/host/src"
  local patch=""
  if [ -d "$ENGINE_DIR/../vendor/librqbit-dualstack-sockets" ]; then
    local vendor
    vendor="$(cd "$ENGINE_DIR/../vendor/librqbit-dualstack-sockets" && pwd)"
    patch="[patch.crates-io]
librqbit-dualstack-sockets = { path = \"$vendor\" }"
  fi
  ENGINE_DIR="$ENGINE_DIR" PATCH="$patch" perl -pe 's/\@ENGINE_DIR\@/$ENV{ENGINE_DIR}/g; s/\@PATCH\@/$ENV{PATCH}/g' \
    "$BENCH/engine-host/Cargo.toml.in" > "$dir/host/Cargo.toml"
  cp "$BENCH/engine-host/src/main.rs" "$dir/host/src/main.rs"
  echo "building engine host for '$label' against $ENGINE_DIR (fat LTO, a few minutes)…" >&2
  CARGO_TARGET_DIR="$dir/target" cargo build --release --quiet --manifest-path "$dir/host/Cargo.toml"
  HOST_BIN="$dir/target/release/tbench-engine-host"
  local rev dirty
  rev="$(git -C "$ENGINE_DIR" rev-parse HEAD 2>/dev/null || cat "$ENGINE_DIR/../../REF" 2>/dev/null || echo unknown)"
  if git -C "$ENGINE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    dirty="$(git -C "$ENGINE_DIR" status --porcelain -- . | wc -l | tr -d ' ')"
  else
    dirty=0
  fi
  local srchash
  srchash="$(cd "$ENGINE_DIR" && find src Cargo.toml -type f | sort | xargs cat | shasum | cut -c1-12)"
  printf '{"label":"%s","engineDir":"%s","gitRev":"%s","dirtyFiles":%s,"srcHash":"%s","builtAt":"%s"}\n' \
    "$label" "$ENGINE_DIR" "$rev" "${dirty:-0}" "$srchash" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/engine.json"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  media)
    command -v ffmpeg >/dev/null || die "ffmpeg not found (brew install ffmpeg)"
    build_tbench
    "$TBENCH" gen-media --root "$TB" "$@"
    ;;
  clean-media)
    rm -rf "$TB/media"
    ;;
  list)
    build_tbench
    "$TBENCH" list "$@"
    ;;
  build|run)
    ENGINE_SPEC="" LABEL="" REST=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --engine) ENGINE_SPEC="$2"; shift 2 ;;
        --label) LABEL="$2"; shift 2 ;;
        *) REST+=("$1"); shift ;;
      esac
    done
    [ -n "$ENGINE_SPEC" ] || die "--engine <dir|git-ref> is required"
    [ -n "$LABEL" ] || die "--label <label> is required"
    resolve_engine "$ENGINE_SPEC" "$LABEL"
    build_host "$LABEL"
    if [ "$cmd" = run ]; then
      build_tbench
      [ -f "$TB/media/media.json" ] || "$TBENCH" gen-media --root "$TB"
      "$TBENCH" run --root "$TB" --label "$LABEL" --host "$HOST_BIN" --engine-info "$TB/build/$LABEL/engine.json" ${REST[@]+"${REST[@]}"}
    fi
    ;;
  compare)
    [ $# -ge 2 ] || die "usage: compare <labelA> <labelB>"
    build_tbench
    "$TBENCH" compare --root "$TB" "$1" "$2"
    ;;
  *)
    sed -n '2,32p' "$0"
    exit 1
    ;;
esac
