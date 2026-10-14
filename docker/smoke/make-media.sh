#!/usr/bin/env bash
# Synthetic test media for the smoke test (no copyrighted content): ffmpeg test patterns.
#   h264_aac.mkv   H.264 8-bit + AAC stereo + an ASS subtitle track (remux)
#   hi10p_ac3.mkv  H.264 High 10 + AC3 5.1, 300 s (transcode; long enough to keep ffmpeg busy)
#   hevc_ac3.mkv   HEVC + AC3 5.1 (transcode for an H.264-only browser)
# Usage: make-media.sh OUT_DIR [FFMPEG]
set -euo pipefail
out=${1:?out dir}
ff=${2:-ffmpeg}
mkdir -p "$out"
cat > "$out/track.ass" <<'EOF'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Bonjour {\i1}Huwa{\i0}
Dialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,Deuxième ligne\Nsuite
Dialogue: 0,0:00:50.00,0:00:55.00,Default,,0,0,0,,Fin
EOF
src=(-f lavfi -i testsrc=size=640x360:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000)
"$ff" -hide_banner -loglevel error -y "${src[@]}" -i "$out/track.ass" -t 60 -map 0 -map 1 -map 2 \
  -c:v libx264 -preset ultrafast -g 48 -pix_fmt yuv420p -c:a aac -ac 2 -c:s ass "$out/h264_aac.mkv"
"$ff" -hide_banner -loglevel error -y "${src[@]}" -t 300 -map 0 -map 1 \
  -c:v libx264 -preset ultrafast -g 48 -pix_fmt yuv420p10le -profile:v high10 -c:a ac3 -ac 6 "$out/hi10p_ac3.mkv"
"$ff" -hide_banner -loglevel error -y "${src[@]}" -t 30 -map 0 -map 1 \
  -c:v libx265 -preset ultrafast -x265-params log-level=error -g 48 -pix_fmt yuv420p -c:a ac3 -ac 6 "$out/hevc_ac3.mkv"
ls -la "$out"
