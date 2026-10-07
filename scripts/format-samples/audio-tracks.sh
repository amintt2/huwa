#!/usr/bin/env bash
# Header fixtures for the audio / subtitle track parsers (src/components/player/engines/tracks.ts):
# small synthetic files (ffmpeg testsrc2 + sine tones only), of which only the first bytes are
# kept in src/components/player/engines/__tests__/fixtures/tracks/ (and the moov of an MP4 whose
# index sits at the end).
#
# Usage: scripts/format-samples/audio-tracks.sh [work-dir]   (default: $TMPDIR/huwa-track-samples)
# Needs: ffmpeg (libx264, aac), mkvmerge, python3.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/huwa-track-samples}"
DEST="$ROOT/src/components/player/engines/__tests__/fixtures/tracks"
mkdir -p "$OUT" "$DEST"
cd "$OUT"

FF=(ffmpeg -hide_banner -loglevel error -y)
V=(-f lavfi -i "testsrc2=size=160x90:rate=24:duration=2")
A1=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2")
A2=(-f lavfi -i "sine=frequency=660:sample_rate=48000:duration=2")
A3=(-f lavfi -i "sine=frequency=880:sample_rate=48000:duration=2")
ENC=(-c:v libx264 -preset ultrafast -c:a aac -b:a 64k)

cat > forced.ass <<'ASS'
[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.10,0:00:01.90,Default,,0,0,0,,Panneau
ASS
cp forced.ass full.ass

# MULTI with a French dub: Japanese (default) + French "VF", forced French signs + full French subs.
"${FF[@]}" "${V[@]}" "${A1[@]}" "${A2[@]}" -i forced.ass -i full.ass -map 0 -map 1 -map 2 -map 3 -map 4 "${ENC[@]}" -c:s ass \
  -metadata:s:a:0 language=jpn -metadata:s:a:0 title=Japonais -metadata:s:a:1 language=fre -metadata:s:a:1 title=VF \
  -metadata:s:s:0 language=fre -metadata:s:s:0 title="Forcés" -metadata:s:s:1 language=fre -metadata:s:s:1 title="Complets" \
  -disposition:a:0 default -disposition:a:1 0 -disposition:s:0 forced -disposition:s:1 0 multi-fr.mkv

# "MULTI" without French: Japanese + English.
"${FF[@]}" "${V[@]}" "${A1[@]}" "${A2[@]}" -map 0 -map 1 -map 2 "${ENC[@]}" \
  -metadata:s:a:0 language=jpn -metadata:s:a:1 language=eng -metadata:s:a:1 title="English" multi-nofr.mkv

# Untagged release name, French audio tag only (no title).
"${FF[@]}" "${V[@]}" "${A1[@]}" -map 0 -map 1 "${ENC[@]}" -metadata:s:a:0 language=fre untagged-fr.mkv

# Language left undetermined, title only ("Français").
"${FF[@]}" "${V[@]}" "${A1[@]}" "${A2[@]}" -map 0 -map 1 -map 2 "${ENC[@]}" \
  -metadata:s:a:0 language=und -metadata:s:a:0 title="Japonais" -metadata:s:a:1 language=und -metadata:s:a:1 title="Français" title-only.mkv

# Fansub layout: Tracks, then 3 MiB of font attachments, then the clusters (mkvmerge order).
python3 -c "import os,sys; sys.stdout.buffer.write(os.urandom(3*1024*1024))" > big-font.ttf
mkvmerge -q -o attachments.mkv --attachment-mime-type application/x-truetype-font --attach-file big-font.ttf \
  --language 1:jpn --language 2:fre --track-name 2:VF multi-fr.mkv

# MP4, faststart: Japanese + French (handler name "VF").
"${FF[@]}" "${V[@]}" "${A1[@]}" "${A2[@]}" -map 0 -map 1 -map 2 "${ENC[@]}" \
  -metadata:s:a:0 language=jpn -metadata:s:a:0 handler_name=Japonais -metadata:s:a:1 language=fre -metadata:s:a:1 handler_name=VF \
  -movflags +faststart multi-fr.mp4
# MP4, moov at the end: Japanese + English only.
"${FF[@]}" "${V[@]}" "${A1[@]}" "${A3[@]}" -map 0 -map 1 -map 2 "${ENC[@]}" \
  -metadata:s:a:0 language=jpn -metadata:s:a:1 language=eng nofr-moov-end.mp4

head -c 16384 multi-fr.mkv > "$DEST/multi-fr.mkv.head"
head -c 16384 multi-nofr.mkv > "$DEST/multi-nofr.mkv.head"
head -c 16384 untagged-fr.mkv > "$DEST/untagged-fr.mkv.head"
head -c 16384 title-only.mkv > "$DEST/title-only.mkv.head"
head -c 16384 attachments.mkv > "$DEST/attachments.mkv.head"
head -c 16384 multi-fr.mp4 > "$DEST/multi-fr.mp4.head"
head -c 4096 nofr-moov-end.mp4 > "$DEST/nofr-moov-end.mp4.head"
# The moov box of the second MP4 (last top-level box).
python3 - "$OUT/nofr-moov-end.mp4" "$DEST/nofr-moov-end.mp4.moov" <<'PY'
import struct, sys
data = open(sys.argv[1], 'rb').read()
at = 0
while at + 8 <= len(data):
    size, kind = struct.unpack('>I4s', data[at:at + 8])
    if size == 1:
        size = struct.unpack('>Q', data[at + 8:at + 16])[0]
    if kind == b'moov':
        open(sys.argv[2], 'wb').write(data[at:at + size])
        print('moov at', at, 'size', size)
        break
    at += size
PY
ls -la "$DEST"
