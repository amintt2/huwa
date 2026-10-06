#!/usr/bin/env bash
# Synthetic media samples for Huwa's format matrix (see README.md). Only generated content:
# ffmpeg test patterns (testsrc2) and tones (sine), subtitles written here, and an OFL font
# (Comic Neue, from node_modules/@expo-google-fonts) attached to the styled-ASS samples.
#
# Usage: scripts/format-samples/generate.sh [out-dir]   (default: $TMPDIR/huwa-format-samples, outside
# the repo: `.ts` samples would trip tsc)
# Needs: ffmpeg (libx264 with 10-bit, libx265, libsvtav1, libvpx, libopus, libmp3lame), mkvmerge,
# mkvextract, python3, iconv, zip, gzip.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/huwa-format-samples}"
mkdir -p "$OUT/subs" "$OUT/hls" "$OUT/dash"
cd "$OUT"

FONT="$ROOT/node_modules/@expo-google-fonts/comic-neue/400Regular/ComicNeue_400Regular.ttf"
[[ -f "$FONT" ]] || { echo "error: $FONT missing (npm install)" >&2; exit 1; }

export SVT_LOG=1  # SVT-AV1: errors only
D=2         # seconds
S=320x180   # small: fast to generate and to decode
FF=(ffmpeg -hide_banner -loglevel error -y)
V=(-f lavfi -i "testsrc2=size=$S:rate=24:duration=$D")
A=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$D")
# Stereo / 5.1 tones (DTS, TrueHD and AC-3 are mostly multichannel in the wild).
A51=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$D,pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0")

# ---------- subtitles ----------
cat > subs/styled.ass <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Comic Neue,22,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
Style: Sign,Comic Neue,16,&H00FF00FF,&H000000FF,&H00FFFFFF,&H00000000,1,0,0,0,100,100,0,0,1,1,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.10,0:00:01.90,Default,,0,0,0,,{\fad(150,150)}Huwa — sous-titres stylés
Dialogue: 1,0:00:00.10,0:00:01.90,Sign,,0,0,0,,{\pos(20,20)\frz8\blur1}Panneau typé
Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\an8\k20}Ka{\k20}ra{\k20}o{\k20}ke
ASS

cat > subs/plain.srt <<'SRT'
1
00:00:00,100 --> 00:00:01,900
Huwa: <i>sous-titres</i> SRT — déjà vu, à côté

SRT
printf 'WEBVTT\n\n00:00:00.100 --> 00:00:01.900\nHuwa: WebVTT <b>gras</b>\n' > subs/plain.vtt
iconv -f UTF-8 -t WINDOWS-1252 subs/plain.srt > subs/cp1252.srt
printf '1\n00:00:00,100 --> 00:00:01,900\n日本語の字幕です。テスト\n' | iconv -f UTF-8 -t SHIFT_JIS > subs/shift-jis.srt
iconv -f UTF-8 -t UTF-16 subs/styled.ass > subs/utf16.ass   # with BOM
gzip -c subs/plain.srt > subs/plain.srt.gz
(cd subs && rm -f plain-srt.zip && zip -q plain-srt.zip plain.srt)
# MicroDVD (frame-based, 24 fps) and MPL2 (deciseconds): old `.sub` / `.txt` text formats.
printf '{1}{1}23.976\n{3}{30}Huwa: MicroDVD\n{31}{45}{y:i}italique|deux lignes\n{46}{47}.\n' > subs/microdvd.sub
printf '[1][9]Huwa: MPL2\n[10][19]/italique|deux lignes\n[20][21].\n' > subs/mpl2.txt
python3 "$HERE/make-pgs.py" subs/boxes.sup 320 180

# ---------- video × audio × subtitles ----------
X264_10=(-c:v libx264 -preset veryfast -pix_fmt yuv420p10le -profile:v high10)
X264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p)
X265_10=(-c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -x265-params log-level=error)
AV1=(-c:v libsvtav1 -preset 12 -pix_fmt yuv420p10le)

# Anime fansub classic: Hi10P + AAC + styled ASS + the font as an MKV attachment.
"${FF[@]}" "${V[@]}" "${A[@]}" -i subs/styled.ass "${X264_10[@]}" -c:a aac -c:s ass \
  -attach "$FONT" -metadata:s:t mimetype=font/ttf -metadata:s:t filename=ComicNeue-Regular.ttf \
  -metadata:s:a language=jpn -metadata:s:s language=fre hi10p-aac-ass-font.mkv
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264_10[@]}" -c:a aac -movflags +faststart hi10p-aac.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a aac -movflags +faststart h264-aac.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" -i subs/plain.srt "${X264[@]}" -c:a aac -c:s mov_text -movflags +faststart h264-aac-movtext.mp4
# Same file with the moov at the END (no faststart): the sniffer must fetch it.
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a aac h264-aac-moov-end.mp4

"${FF[@]}" "${V[@]}" "${A[@]}" -i subs/plain.srt "${X265_10[@]}" -c:a libopus -c:s srt hevc10-opus-srt.mkv
"${FF[@]}" "${V[@]}" "${A[@]}" "${X265_10[@]}" -tag:v hvc1 -c:a aac -movflags +faststart hevc10-hvc1.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${X265_10[@]}" -tag:v hev1 -c:a aac -movflags +faststart hevc10-hev1.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${AV1[@]}" -c:a libopus av1-opus.mkv
"${FF[@]}" "${V[@]}" "${A[@]}" "${AV1[@]}" -c:a aac -movflags +faststart av1-aac.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus vp9-opus.webm
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v libvpx -deadline realtime -cpu-used 8 -c:a libopus -f ogg vp8-opus.ogv 2>/dev/null \
  || "${FF[@]}" "${V[@]}" "${A[@]}" -c:v libvpx -deadline realtime -c:a libopus vp8-opus.webm

# Audio codecs AVPlayer does / does not decode, in MP4 (the "plays without sound" trap) and MKV.
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a dca -strict -2 -movflags +faststart h264-dts.mp4
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a truehd -strict -2 -movflags +faststart h264-truehd.mp4
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a ac3 -movflags +faststart h264-ac3.mp4
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a eac3 -movflags +faststart h264-eac3.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a libopus -movflags +faststart h264-opus.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a flac -strict -2 -movflags +faststart h264-flac.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a libmp3lame -movflags +faststart h264-mp3.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a alac -movflags +faststart h264-alac.m4v
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a dca -strict -2 h264-dts.mkv
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a truehd -strict -2 h264-truehd.mkv
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a flac h264-flac.mkv
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a vorbis -strict -2 -ac 2 h264-vorbis.mkv
# Dual audio (JPN AAC + ENG AC-3) and two subtitle tracks (FRE ASS, ENG SRT): the release shape.
"${FF[@]}" "${V[@]}" "${A[@]}" "${A51[@]}" -i subs/styled.ass -i subs/plain.srt -map 0 -map 1 -map 2 -map 3 -map 4 \
  "${X264_10[@]}" -c:a:0 aac -c:a:1 ac3 -c:s:0 ass -c:s:1 srt \
  -metadata:s:a:0 language=jpn -metadata:s:a:1 language=eng -metadata:s:s:0 language=fre -metadata:s:s:1 language=eng \
  -disposition:s:1 forced hi10p-dual-audio-2subs.mkv

# Bitmap subtitles: VobSub (DVD) in MKV and as .idx/.sub, PGS (Blu-ray) in MKV and as .sup.
# (FFmpeg encodes bitmap subtitles only from bitmaps: the PGS captions are re-encoded as VobSub.)
"${FF[@]}" "${V[@]}" -i subs/boxes.sup -map 0 -map 1 "${X264[@]}" -c:s dvdsub h264-vobsub.mkv
mkvextract h264-vobsub.mkv tracks 1:subs/vobsub.idx >/dev/null
"${FF[@]}" "${V[@]}" "${X264[@]}" h264-nosub.mkv
mkvmerge -q -o h264-pgs.mkv h264-nosub.mkv subs/boxes.sup

# Legacy containers.
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v mpeg4 -vtag XVID -q:v 5 -bf 2 -c:a libmp3lame xvid-mp3.avi
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v mpeg4 -q:v 5 -bf 2 -flags +qpel+mv4 -c:a aac -movflags +faststart mpeg4asp-aac.mp4
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v libx264 -preset veryfast -c:a libmp3lame h264-mp3.avi
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a aac h264-aac.ts
"${FF[@]}" "${V[@]}" "${A51[@]}" "${X264[@]}" -c:a ac3 -mpegts_m2ts_mode 1 h264-ac3.m2ts
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v mpeg2video -q:v 4 -c:a ac3 mpeg2-ac3.ts
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v mpeg2video -q:v 4 -c:a mp2 -f vob mpeg2-mp2.vob
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v flv -c:a libmp3lame -ar 44100 sorenson-mp3.flv
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a aac h264-aac.flv
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v wmv2 -c:a wmav2 wmv2-wma.wmv
"${FF[@]}" "${V[@]}" "${A[@]}" -c:v rv20 -c:a ac3 -ar 44100 -f rm rv20-ac3.rmvb
# OGM-style: Ogg with VP8 + Opus (ffmpeg cannot write the old OGM DirectShow mapping).
cp -f vp8-opus.ogv vp8-opus.ogm 2>/dev/null || true

# Torrent-shaped names: no extension, odd extension.
cp -f hi10p-aac-ass-font.mkv no-extension
cp -f h264-aac.mp4 mystery.bin

# Reader pages: still images, and a webtoon strip taller than a GPU texture (16384 px).
mkdir -p reader
IMG=(-f lavfi -i "testsrc2=size=800x1200:rate=1:duration=1" -frames:v 1 -update 1)
"${FF[@]}" "${IMG[@]}" reader/page.png
"${FF[@]}" "${IMG[@]}" -q:v 3 reader/page.jpg
"${FF[@]}" "${IMG[@]}" -c:v libsvtav1 -pix_fmt yuv420p -f avif reader/page.avif 2>/dev/null || true
sips -s format heic reader/page.png --out reader/page.heic >/dev/null 2>&1 || true
sips -s format webp reader/page.png --out reader/page.webp >/dev/null 2>&1 || true
"${FF[@]}" -f lavfi -i "testsrc2=size=800x20000:rate=1:duration=1" -frames:v 1 -update 1 -q:v 4 reader/strip-800x20000.jpg

# Streaming: HLS (TS segments) and DASH (fMP4).
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a aac -f hls -hls_time 1 -hls_playlist_type vod hls/index.m3u8
"${FF[@]}" "${V[@]}" "${A[@]}" "${X264[@]}" -c:a aac -f dash -seg_duration 1 dash/manifest.mpd

ls -1 "$OUT" | grep -v '^subs$\|^hls$\|^dash$' | wc -l | xargs echo "samples:"
