#!/usr/bin/env bash
# Plays every sample with the mpv CLI and the options of modules/huwa-mpv/ios/MpvCore.swift that
# matter off-screen (demuxing, decoding, subtitles/fonts). Prints one TSV row per check.
#
#   scripts/format-samples/verify-mpv.sh [out-dir]
#
# Columns: sample, result (ok/FAIL), container, video codec, hwdec, audio codec, subtitle codec,
# and for subtitle checks whether the subtitle changed the rendered frame (drawn=yes/no).
# Caveat: the Homebrew mpv links a full FFmpeg; the app's MPVKit build has a reduced decoder and
# demuxer list (see README.md, "Bundled libmpv"). Rows the app cannot match are flagged there.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/huwa-format-samples}"
cd "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# MpvCore.swift (decode/subtitle side). Rendering (gpu-next/MoltenVK) is replaced by vo=null/image,
# and hwdec by its copy-back variant (vo=null has no GPU interop).
MPV=(mpv --no-config --load-scripts=no --load-auto-profiles=no --msg-level=all=error,term-msg=info
  --profile=fast --hwdec=auto-copy-safe --vd-lavc-check-hw-profile=yes --hwdec-software-fallback=yes --vd-lavc-threads=6
  --demuxer-lavf-analyzeduration=1 --demuxer-lavf-probesize=2097152
  --sub-ass=yes --embeddedfonts=yes --sub-ass-override=scale --sub-font-provider=auto --sub-codepage=auto
  --sub-use-margins=yes --sub-ass-force-margins=yes)
MSG='${file-format}\t${current-tracks/video/codec}\t${hwdec-current}\t${current-tracks/audio/codec}\t${current-tracks/sub/codec}'

play() { # <file> [extra mpv args...]: decodes 1.5 s of audio + video
  local f=$1; shift
  local info rc
  info="$("${MPV[@]}" --vo=null --ao=null --length=1.5 --term-playing-msg="$MSG" "$@" "$f" 2>"$TMP/err" | tail -1)"
  rc=$?
  if [[ $rc -eq 0 && -n "$info" && ! -s "$TMP/err" ]]; then printf '%s\tok\t%s\n' "$f" "$info"
  else printf '%s\tFAIL\t%s\t%s\n' "$f" "$info" "$(tr '\n' ' ' < "$TMP/err" | cut -c1-160)"; fi
}

frame() { # <file> <name> [args]: PNG of the frame at 1.0 s
  local f=$1 n=$2; shift 2
  rm -rf "$TMP/$n"; mkdir -p "$TMP/$n"
  "${MPV[@]}" --ao=null --vo=image --vo-image-format=png --vo-image-outdir="$TMP/$n" --start=1.0 --frames=1 "$@" "$f" >/dev/null 2>&1
  ls "$TMP/$n"/*.png 2>/dev/null | head -1
}

drawn() { # <file> <label> [args]: does the selected subtitle change the picture?
  local f=$1 label=$2; shift 2
  local a b
  a="$(frame "$f" off --sid=no)"; b="$(frame "$f" on "$@")"
  if [[ -z "$a" || -z "$b" ]]; then printf '%s\tFAIL\tsub:%s\tno frame\n' "$f" "$label"; return; fi
  if cmp -s "$a" "$b"; then printf '%s\tFAIL\tsub:%s\tdrawn=no\n' "$f" "$label"; else printf '%s\tok\tsub:%s\tdrawn=yes\n' "$f" "$label"; fi
}

echo -e "sample\tresult\tcontainer\tvideo\thwdec\taudio\tsub"
for f in *.mkv *.mp4 *.m4v *.webm *.ogv *.ogm *.avi *.ts *.m2ts *.vob *.flv *.wmv *.rmvb no-extension mystery.bin hls/index.m3u8 dash/manifest.mpd; do
  [[ -e "$f" ]] && play "$f" --sid=auto
done

echo
echo -e "# subtitles: rendered at 1.0 s, compared with subtitles off"
drawn hi10p-aac-ass-font.mkv "ass embedded" --sid=1
drawn hi10p-dual-audio-2subs.mkv "srt (2nd track)" --sid=2
drawn hevc10-opus-srt.mkv "srt embedded" --sid=1
drawn h264-aac-movtext.mp4 "mov_text" --sid=1
drawn h264-vobsub.mkv "vobsub embedded" --sid=1
drawn h264-pgs.mkv "pgs embedded" --sid=1
for s in subs/styled.ass subs/utf16.ass subs/plain.srt subs/cp1252.srt subs/shift-jis.srt subs/plain.vtt subs/plain.srt.gz subs/microdvd.sub subs/mpl2.txt subs/vobsub.idx subs/boxes.sup; do
  drawn h264-nosub.mkv "external ${s#subs/}" --sub-file="$s" --sid=1
done

echo
echo "# embedded font (Comic Neue is not installed on the system: the attachment must be used)"
a="$(frame hi10p-aac-ass-font.mkv font-on --sid=1 --embeddedfonts=yes)"
b="$(frame hi10p-aac-ass-font.mkv font-off --sid=1 --embeddedfonts=no)"
if [[ -n "$a" && -n "$b" ]] && ! cmp -s "$a" "$b"; then echo -e "hi10p-aac-ass-font.mkv\tok\tattached font used (differs from --embeddedfonts=no)"
else echo -e "hi10p-aac-ass-font.mkv\tFAIL\tattached font not used"; fi
a="$(frame hi10p-aac-ass-font.mkv ovr-scale --sid=1 --sub-ass-override=scale)"
b="$(frame hi10p-aac-ass-font.mkv ovr-force --sid=1 --sub-ass-override=force --sub-font=Helvetica)"
if [[ -n "$a" && -n "$b" ]] && ! cmp -s "$a" "$b"; then echo -e "hi10p-aac-ass-font.mkv\tok\tsub-ass-override=force restyles (file style kept with =scale)"
else echo -e "hi10p-aac-ass-font.mkv\tFAIL\toverride has no effect"; fi
