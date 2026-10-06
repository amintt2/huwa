# Format samples

Synthetic media to check which formats Huwa plays, and with which engine. Nothing copyrighted:
ffmpeg test patterns (`testsrc2`) and tones (`sine`), subtitles written by the script, Comic Neue
(SIL OFL, from `node_modules/@expo-google-fonts`) as the attached font, and a hand-made PGS
stream (`make-pgs.py`, FFmpeg has no PGS encoder).

```sh
scripts/format-samples/generate.sh            # → $TMPDIR/huwa-format-samples (not in the repo: `.ts` samples trip tsc)
scripts/format-samples/verify-mpv.sh          # mpv CLI with MpvCore.swift's options, one TSV row per check
swift scripts/format-samples/avf-check.swift "$TMPDIR"/huwa-format-samples/*.mp4   # AVFoundation's view
sips -g format -g pixelHeight "$TMPDIR"/huwa-format-samples/reader/*                # ImageIO (reader pages)
```

Needs ffmpeg (libx264 10-bit, libx265, libsvtav1, libvpx, libopus, libmp3lame), mkvmerge/mkvextract,
python3, mpv. The 4 KiB fixtures of `src/components/player/engines/__tests__/fixtures/` (`dts.mp4.head`,
`hi10p-ass.mkv.head`…) come from these samples.

## Bundled libmpv (what the app really has)

`modules/huwa-mpv/ios/Libmpv.xcframework` = MPVKit 1.0.0, LGPL build (`scripts/fetch-mpvkit.sh`).
Version strings in the binary: **mpv v0.41.0**, **FFmpeg n8.1.2**, libass + libplacebo + MoltenVK,
dav1d, uchardet, libbluray. The decoder / demuxer list is MPVKit's (`Sources/BuildScripts/XCFrameworkBuild/main.swift`
at tag 1.0.0), cross-checked with `strings` on the binary:

| | Enabled |
|---|---|
| Video decoders | h264 (8/10-bit, software + VideoToolbox), hevc, av1 + **libdav1d**, vp8, vp9, mpeg1/2/4 (Xvid/DivX), h263, flv, wmv1/2/3, vc1, rv10–40, prores, mjpeg, vp6 |
| Audio decoders | aac, ac3, eac3, **dca (DTS, DTS-HD core+XLL)**, **truehd**, flac, opus, vorbis, mp1/2/3, alac, wma*, cook, ape, pcm*, amr |
| Subtitle decoders | ass/ssa, srt/subrip, webvtt, mov_text, **pgssub**, **dvdsub (VobSub)**, dvbsub, xsub, mpl2, cc |
| Demuxers | matroska/webm, mov/mp4, avi, mpegts/mpegps (`mpeg*`), flv, asf (WMV), rm, ogg, hls, dash, srt, webvtt, ass, aac/ac3/eac3/flac/mp3/wav |
| **Not in the build** | `vobsub` demuxer (external `.idx/.sub`), `sup` demuxer (external `.sup`), `microdvd`/`subviewer` demuxers, libarchive (no `archive://`: RAR'd releases), dvdnav (DVD ISO) |

The Homebrew mpv used by `verify-mpv.sh` is the same mpv version with a full FFmpeg: a row it
passes is only meaningful for the app when the table above has the codec / demuxer.

## Results

Engine: **AVPlayer** = expo-video (native), **mpv** = libmpv. "Before" = routing before this
change; "After" = now. AVFoundation was checked on macOS 27 (same rules as iOS for these
containers and codecs; flagged where iOS may differ).

### Containers

| Format | Before | After | Checked |
|---|---|---|---|
| MP4 / M4V / MOV, H.264 8-bit + AAC/AC-3/E-AC-3/FLAC/ALAC/Opus | AVPlayer | AVPlayer | AVF ok, mpv ok |
| MP4 moov at the end | AVPlayer, codecs unknown (4 KiB sniff) | second Range read of the `moov`, codecs known | test + AVF + mpv |
| MKV, WebM, AVI, FLV, WMV/ASF, RMVB, Ogg/OGM, MPEG-TS | mpv (by extension / magic) | mpv | mpv ok (all) |
| M2TS (Blu-ray, 192-byte packets) | mpv by extension; **no magic** (extension-less → AVPlayer, 15 s, then mpv) | mpv, magic detected | test + mpv |
| VOB / MPG (MPEG-PS) | mpv by extension (labelled TS); **no magic** | mpv, magic detected | test + mpv |
| `.ogm`, `.xvid`, `.f4v`, `.evo`, `.m2v`, `.m2t`, `.qt` | unknown → AVPlayer attempt, then mpv | mapped (mpv; `.f4v`/`.3gp` sniffed as MP4) | test |
| HLS | AVPlayer | AVPlayer | mpv ok (fallback) |
| DASH | mpv | mpv | Homebrew FFmpeg lacks the dash demuxer (libxml2); MPVKit has it, not checked |
| ISO / BDMV folder | unsupported | BDMV: largest `.m2ts` picked (main title); ISO: not picked (no reader over HTTP) | Rust tests |
| No / unknown extension (torrent) | largest file, even a `.rar` / `.iso` | largest file not known to be something else; mpv sniffs it | Rust tests + mpv (`no-extension`, `mystery.bin`) |

### Video

| Codec | Before | After | Checked |
|---|---|---|---|
| H.264 8-bit | AVPlayer | AVPlayer | AVF + mpv |
| **Hi10P (10-bit H.264) in MP4** | AVPlayer (iPhone VideoToolbox decodes 8-bit H.264 only; not checked on a device) | **mpv** (`H.264 10 bits (Hi10P)`), software fallback at the first failed frame | avcC profile 110 parsed; AVF and mpv decode it on an M3 Mac |
| Hi10P in MKV | mpv | mpv; also routed to mpv on Android (MediaCodec) | test |
| HEVC 8/10-bit `hvc1` | AVPlayer | AVPlayer | AVF + mpv |
| HEVC `hev1` | mpv | mpv | AVF: not playable |
| HEVC 4:2:2 / 4:4:4 (RExt) | AVPlayer | mpv | parser |
| AV1 | mpv without hardware decoder, else AVPlayer | same, + AV1 High profile → mpv | AVF + mpv (dav1d) |
| VP9 / VP8 | mpv | mpv | mpv |
| **MPEG-4 Part 2 (Xvid/DivX) in MP4** | AVPlayer (track not decoded) | **mpv** | AVF: `mp4v (no decode)` |
| MPEG-2 in MP4 / TS / VOB | AVPlayer for MP4 | mpv | mpv |

### Audio (the "silent video" trap: AVPlayer plays the picture and drops the track, no error, no fallback)

| Codec | Before | After | Checked |
|---|---|---|---|
| AAC, AC-3, E-AC-3, FLAC, ALAC, Opus in MP4 | AVPlayer | AVPlayer | AVF ok |
| **DTS in MP4** | AVPlayer, **silent** | **mpv** | AVF hides the track |
| **TrueHD in MP4** | AVPlayer, **silent** | **mpv** | AVF: `mlpa (no decode)` |
| **MP3 in MP4** | AVPlayer, **silent** | **mpv** | AVF hides the track |
| DTS / TrueHD / FLAC / Opus / Vorbis in MKV | mpv | mpv; Android → mpv for DTS/TrueHD | mpv ok |
| Multi-track (JPN + ENG) | mpv tracks, dub language from settings | same | mpv |

### Subtitles

| Format | Before | After | Checked |
|---|---|---|---|
| Embedded ASS/SSA with attached fonts | mpv/libass, `embeddedfonts=yes` | same, `sub-ass-override=scale` pinned, `sub-fonts-dir` set; `force` when "respect the video's style" is off | font differs from `--embeddedfonts=no` render |
| Embedded SRT / mov_text / WebVTT on mpv | mpv default look, **offset ignored** | user's look (font, size, colours, outline, box, position) + **sync offset** (`sub-delay`) | mpv accepts every option |
| Embedded PGS / VobSub | mpv | mpv | rendered (frame differs) |
| **External styled ASS (addon / local) on mpv** | JS overlay (no \clip, \t, drawings, karaoke, attached fonts) | **libass** (file written to cache, `sub-add`), overlay when the user forces their style | mpv `--sub-file` renders; Swift `sub-add` path not runnable here |
| External SRT/VTT/ASS, gzip, UTF-8/16, CP-125x, Shift-JIS | overlay | overlay | unit tests |
| **ZIP archives** | refused ("archive") | the subtitle inside (ASS > SRT > VTT > SUB > TXT, biggest first) | unit tests |
| **MicroDVD `.sub`, MPL2** | "no subtitle" | converted to cues (frame rate line, `|`, `{y:i}`, `/`) | unit tests + mpv CLI renders them |
| VobSub `.idx/.sub`, PGS `.sup` (external) | garbage / generic error | clear message: bitmap subtitles only when embedded | unit tests; not drawable (no demuxer in MPVKit, no JS decoder) |

### Streams

| Kind | Before | After |
|---|---|---|
| `url` HTTP(S) / HLS / DASH | ok | ok |
| `infoHash` + `fileIdx` | engine / debrid | same; extras (NCOP/NCED/sample/menu…) never picked as the episode |
| magnet in `url` | → torrent | → torrent, **base32 hashes decoded** |
| magnet in `externalUrl` | opened in another app | → torrent |
| **`.torrent` link in `url`** | given to the player (fails) | downloaded, bencode-parsed, info hash + trackers → torrent stream (12 per answer, 6 s each) |
| `ytId` | embedded YouTube player + "Ouvrir dans YouTube" | unchanged |
| `externalUrl` (web page) | web player / Safari | unchanged |
| `proxyHeaders.request` | sent by both engines and the probe | unchanged |

### Downloads

| Case | Before | After |
|---|---|---|
| MKV/WebM/AVI… | original kept (`unsupported`), mpv offline | same |
| MP4 with DTS / MP3 audio | **re-encoded without its audio track** (AVFoundation does not list it, the output passes the duration/size check), original deleted | `unsupported`: original kept, offline playback routed to mpv by sniffing the local file |
| MP4 with TrueHD, Hi10P, MPEG-4 ASP, hev1 | encoder failure ×3, then kept (played by AVPlayer offline) | `unsupported` at once, played by mpv |
| `.wmv`, `.vob`, `.flv`, `.rmvb`, `.ogm`… | saved as `video.mp4` (AVPlayer attempt offline) | real extension kept |

### Reader

JPEG, PNG, GIF, WebP, AVIF (SDWebImage AVIF/WebP coders in expo-image), HEIC (ImageIO): decoded from
the bytes, whatever the extension (checked with ImageIO: `reader/page.{jpg,png,avif,heic}`, an
800 × 20000 strip). Offline pages keep `.heic/.heif/.bmp` names now.

## Still unsupported

- External VobSub `.idx/.sub` and PGS `.sup`: no demuxer in MPVKit, no bitmap decoder in JS.
- RAR'd releases, ISO images, DVD/Blu-ray menus: not streamable (no libarchive / dvdnav, libbluray needs a local path).
- Local CBZ / ZIP / PDF / EPUB import in the reader: there is no "local series" in the catalog;
  needs a picker, unzip (fflate is there) into `chapters/`, a local source registered as a
  `PageSource`, and PDF rendering (PDFKit page → image) for PDFs.
- Webtoon strips taller than ~16384 px *after* scaling to the screen width are drawn as one image;
  cutting them into tiles in the feed would be safer on older GPUs (not reproducible off-device).
