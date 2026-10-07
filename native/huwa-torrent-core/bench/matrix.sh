#!/usr/bin/env bash
# The full measurement campaign of bench/README.md, for one build of the bench:
#   bench/matrix.sh <start_bench binary> <tag> [cells...]
# cells: start (MKV/MP4/extra files, dead peers), storm, cache, prewarm, stalls (default: all).
# Results: target/bench-results/<tag>-<cell>.{log,jsonl}. Runs one bench at a time (the timings
# are wall-clock: do not run anything heavy meanwhile).
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${1:?usage: bench/matrix.sh <binary> <tag> [cells...]}"
TAG="${2:?tag}"
shift 2
CELLS="${*:-start storm cache prewarm stalls big http hang floor}"
OUT=target/bench-results
mkdir -p "$OUT"
REPEAT="${REPEAT:-5}"

run() { # name, args...
  local name="$1"
  shift
  echo "== $TAG $name: $*"
  # shellcheck disable=SC2086 # BENCH_ARGS: extra flags for every run (e.g. --fixtures / --work).
  "$BIN" "$@" ${BENCH_ARGS:-} --out "$OUT/$TAG-$name.jsonl" >"$OUT/$TAG-$name.log" 2>&1 || echo "   (exit $?)"
  grep '^|' "$OUT/$TAG-$name.log" | tail -n +3 || true
}

for cell in $CELLS; do
  case "$cell" in
  start)
    run mkv --profiles popular,mid,obscure --files h264.mkv --scenarios start,resume,seek --repeat "$REPEAT" --timeout 60s
    run mp4 --profiles popular,mid,obscure --files moov-end.mp4 --scenarios start,resume,seek --repeat "$REPEAT" --timeout 60s
    run extra --profiles popular,obscure --files faststart.mp4,x265.mkv --scenarios start --repeat "$REPEAT" --timeout 60s
    run dead --profiles popular-dead,mid-dead,obscure-dead --files h264.mkv --scenarios start --repeat "$REPEAT" --timeout 60s
    ;;
  storm)
    run storm --scenarios storm --switches 20 --switch-every 2s --timeout 30s
    ;;
  cache)
    for cap in 5G 10G; do
      for fill in 0 2G 50% 95% 100%; do
        run "cache-$cap-$fill" --cache-cap "$cap" --prefill "$fill" --profiles popular,obscure --files h264.mkv --scenarios start --repeat 3 --play-secs 60 --timeout 60s
      done
      # (Empty cache: the `start` cell's resume / seek rows.)
      for fill in 100%; do
        run "cache-$cap-$fill-seek" --cache-cap "$cap" --prefill "$fill" --profiles popular,obscure --files h264.mkv --scenarios resume,seek --repeat 3 --timeout 60s
      done
    done
    run cache-storm-95 --cache-cap 5G --prefill 95% --scenarios storm --switches 20 --switch-every 2s --timeout 30s
    ;;
  prewarm)
    run prewarm --profiles popular,mid,obscure --files h264.mkv,moov-end.mp4 --scenarios start --repeat "$REPEAT" --prewarm-ms 8000 --timeout 60s
    ;;
  big)
    run big8 --profiles popular,mid,obscure --files h264.mkv --scenarios start,resume --piece-kib 8192 --repeat "$REPEAT" --timeout 60s
    run big16 --profiles popular,mid,obscure --files h264.mkv --scenarios start,resume --piece-kib 16384 --repeat "$REPEAT" --timeout 60s
    ;;
  http)
    run http --profiles http-100ms-50M,http-300ms-10M,http-800ms-2M --files h264.mkv,moov-end.mp4 --scenarios start,resume,seek --repeat "$REPEAT" --timeout 60s
    ;;
  http-proxy)
    run http-proxy --profiles http-100ms-50M,http-300ms-10M,http-800ms-2M --files h264.mkv,moov-end.mp4 --scenarios start,resume,seek --repeat "$REPEAT" --timeout 60s --http-proxy
    ;;
  hang)
    run hang --files h264.mkv,moov-end.mp4 --scenarios hang-tail --hang-once --timeout 70s
    ;;
  floor)
    run floor --profiles popular,mid,obscure --files h264.mkv,moov-end.mp4 --scenarios floor-start,floor-resume --repeat "$REPEAT" --timeout 60s
    run floor-verified --profiles popular,mid,obscure --files h264.mkv,moov-end.mp4 --scenarios floor-start,floor-resume --repeat 3 --timeout 60s --verified
    ;;
  stalls)
    run stalls --profiles popular,mid --files h264.mkv --scenarios start --repeat 3 --play-secs 300 --timeout 60s
    ;;
  *) echo "unknown cell $cell" ;;
  esac
done
