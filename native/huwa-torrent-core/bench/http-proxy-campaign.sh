#!/usr/bin/env bash
# HTTP read-ahead proxy campaign (bench/README.md, "HTTP through the read-ahead proxy"): the same
# bench binary, mpv straight on the link ("direct", the app without the proxy) vs through the
# shipped proxy (src/http_proxy.rs, the path the app takes). One bench at a time (wall clock).
#   bench/http-proxy-campaign.sh [binary]      → target/bench-results/http-{direct,proxy,…}.{log,jsonl}
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${1:-target/release/examples/start_bench}"
OUT=target/bench-results
mkdir -p "$OUT"
REPEAT="${REPEAT:-5}"
PROFILES=http-100ms-2M,http-100ms-10M,http-100ms-50M,http-300ms-2M,http-300ms-10M,http-300ms-50M,http-800ms-2M,http-800ms-10M,http-800ms-50M

run() { # name, args...
  local name="$1"
  shift
  echo "== $name: $*"
  "$BIN" "$@" --out "$OUT/$name.jsonl" >"$OUT/$name.log" 2>&1 || echo "   (exit $?)"
  grep '^|' "$OUT/$name.log" | tail -n +3 || true
}

rm -f "$OUT"/http-direct*.jsonl "$OUT"/http-proxy*.jsonl
run http-direct --profiles "$PROFILES" --files h264.mkv,moov-end.mp4 --scenarios start,resume,seek --repeat "$REPEAT" --timeout 60s
run http-proxy --profiles "$PROFILES" --files h264.mkv,moov-end.mp4 --scenarios start,resume,seek --repeat "$REPEAT" --timeout 60s --http-proxy
# An addon without behaviorHints.videoSize: the resume target leaves with the first answer.
run http-proxy-nosize --profiles "$PROFILES" --files h264.mkv,moov-end.mp4 --scenarios resume --repeat "$REPEAT" --timeout 60s --http-proxy --no-size
# A server ignoring Range (the proxy hands mpv the original link).
run http-direct-norange --profiles http-300ms-10M-norange,http-800ms-2M-norange --files h264.mkv --scenarios start --repeat "$REPEAT" --timeout 60s
run http-proxy-norange --profiles http-300ms-10M-norange,http-800ms-2M-norange --files h264.mkv --scenarios start --repeat "$REPEAT" --timeout 60s --http-proxy
# The last 2 MiB hang once (a debrid server's first try), 100 ms / 10 MB/s otherwise.
for i in $(seq "$REPEAT"); do
  "$BIN" --files h264.mkv,moov-end.mp4 --scenarios hang-tail --hang-once --timeout 60s 2>&1 | grep '^hang-tail' >>"$OUT/http-direct-hang.log" || true
  "$BIN" --files h264.mkv,moov-end.mp4 --scenarios hang-tail --hang-once --timeout 60s --http-proxy 2>&1 | grep '^hang-tail' >>"$OUT/http-proxy-hang.log" || true
done
echo done
