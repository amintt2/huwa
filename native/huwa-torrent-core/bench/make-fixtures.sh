#!/usr/bin/env bash
# Synthetic test videos for the start benchmark (bench/README.md). Test patterns only (testsrc2 +
# sine tones): no real content. Output: $HUWA_BENCH_FIXTURES (default: target/bench-fixtures).
#
#   h264.mkv        24 min 1080p24 H.264 6 Mbit/s CBR + AAC stereo, keyframe every 10 s, Cues and
#                   Tags at the end (ffmpeg's Matroska muxer lays the file out like mkvmerge:
#                   SeekHead first, Cues + per-track DURATION Tags after the last cluster).
#   x265.mkv        24 min 1080p24 HEVC Main10 2.5 Mbit/s + AAC, same layout.
#   moov-end.mp4    h264.mkv remuxed to MP4 with the moov at the end (ffmpeg's default).
#   faststart.mp4   same, moov first.
#   attach.mkv      h264.mkv + 6 MiB of (random) font attachments before the first cluster.
#
# Takes a few minutes (x265 is the slow one). Existing files are kept.
# HUWA_BENCH_DURATION=<seconds> makes shorter files (smoke tests).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${HUWA_BENCH_FIXTURES:-target/bench-fixtures}"
DUR="${HUWA_BENCH_DURATION:-1440}"
mkdir -p "$OUT"
command -v ffmpeg >/dev/null || { echo "ffmpeg missing (brew install ffmpeg)"; exit 1; }

src=(-f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=$DUR"
     -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$DUR"
     -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=$DUR")
audio=(-filter_complex "[1:a][2:a]join=inputs=2:channel_layout=stereo[a]" -map 0:v -map "[a]" -c:a aac -b:a 192k)

# ffmpeg writes the Tags first; mkvmerge (what fansub/encode groups use) puts Cues + statistics
# Tags after the last cluster, which makes mpv read the end of the file before frame 1.
mkv_final() {
  if command -v mkvmerge >/dev/null; then
    mkvmerge -q -o "$2" "$1" && rm -f "$1"
  else
    echo "mkvmerge missing (brew install mkvtoolnix): $2 keeps ffmpeg's layout (Tags first)"
    mv "$1" "$2"
  fi
}

if [ ! -s "$OUT/h264.mkv" ]; then
  ffmpeg -hide_banner -loglevel error -y "${src[@]}" "${audio[@]}" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 240 -keyint_min 24 \
    -b:v 6M -maxrate 6M -minrate 6M -bufsize 6M -x264-params nal-hrd=cbr:force-cfr=1 \
    "$OUT/h264.tmp.mkv"
  mkv_final "$OUT/h264.tmp.mkv" "$OUT/h264.mkv"
fi
if [ ! -s "$OUT/moov-end.mp4" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/h264.mkv" -map 0 -c copy "$OUT/moov-end.tmp.mp4"
  mv "$OUT/moov-end.tmp.mp4" "$OUT/moov-end.mp4"
fi
if [ ! -s "$OUT/faststart.mp4" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/h264.mkv" -map 0 -c copy -movflags +faststart "$OUT/faststart.tmp.mp4"
  mv "$OUT/faststart.tmp.mp4" "$OUT/faststart.mp4"
fi
if [ ! -s "$OUT/x265.mkv" ]; then
  ffmpeg -hide_banner -loglevel error -y "${src[@]}" "${audio[@]}" \
    -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -g 240 \
    -b:v 2500k -maxrate 2500k -bufsize 5000k -x265-params log-level=error \
    "$OUT/x265.tmp.mkv"
  mkv_final "$OUT/x265.tmp.mkv" "$OUT/x265.mkv"
fi
# Fansub-style MKV: the same video with font attachments before the first cluster (mpv reads them
# at open for libass). Synthetic random "fonts" (6 MiB in all), no real font files.
if [ ! -s "$OUT/attach.mkv" ] && command -v mkvmerge >/dev/null; then
  head -c 3145728 /dev/urandom >"$OUT/BenchSansA.ttf"
  head -c 3145728 /dev/urandom >"$OUT/BenchSansB.ttf"
  mkvmerge -q -o "$OUT/attach.mkv" \
    --attachment-mime-type font/ttf --attach-file "$OUT/BenchSansA.ttf" \
    --attachment-mime-type font/ttf --attach-file "$OUT/BenchSansB.ttf" \
    "$OUT/h264.mkv"
  rm -f "$OUT/BenchSansA.ttf" "$OUT/BenchSansB.ttf"
fi
ls -l "$OUT"
