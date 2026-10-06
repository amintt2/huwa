# Start benchmark (offline, end to end)

Measures **tap → first frame** for torrent streams with the real engine and a real player, on
one machine and without the internet:

```
synthetic videos (ffmpeg testsrc2 + sine, mkvmerge layout)
  → .torrent (librqbit create_torrent, cached in <fixtures>/torrents)
  → one local librqbit seeding session on 127.0.0.1
  → one shaping TCP proxy per simulated peer (its upload rate + RTT), shared client downlink
    + dead addresses (half time out: 127.0.0.x is not configured on macOS's lo0; half refused)
  → local HTTP tracker (compact peers, every peer of the profile, shuffled)
  → the engine API exactly as the app calls it: probe (the race, peer-race.ts rules) →
    startStream → loopback HTTP
  → mpv CLI with MpvCore.swift's options (vo=null, ao=null), started idle and driven over IPC
    like the app (set start / hr-seek, loadfile replace)
first frame = mpv `playback-restart` after `file-loaded`, the event MpvCore reports as
"firstFrame". Every number below comes from that (mpv was installed, no bytes-ready fallback).
```

The bench is an example binary: `cargo run --release --example start_bench -- <flags>`.

## Setup

```sh
brew install ffmpeg mpv mkvtoolnix     # mkvtoolnix: optional, mkvmerge file layout (see below)
bench/make-fixtures.sh                 # ~6 min, 3.6 GB in target/bench-fixtures (git-ignored)
cargo build --release --example start_bench
```

Fixtures (test patterns only, no real content):

| file | content | why |
|---|---|---|
| `h264.mkv` | 24 min 1080p24 H.264 ~5.7 Mbit/s + AAC, keyframe every 10 s, remuxed by mkvmerge | SeekHead first, **Cues + Tags after the last cluster** (mpv reads them before frame 1) |
| `x265.mkv` | 24 min 1080p24 HEVC Main10 2.5 Mbit/s + AAC, mkvmerge | typical small anime encode |
| `moov-end.mp4` | `h264.mkv` remuxed, moov at the end | MP4 index read before frame 1 |
| `faststart.mp4` | same, moov first | |

Pieces: 1 MiB for files over 800 MiB, 512 KiB below (`--piece-kib` to force).

## Parameters

| flag | default | meaning |
|---|---|---|
| `--profiles a,b` | `popular,mid,obscure` | swarm profiles (below); suffix `-dead` adds 4 dead addresses per live peer (80 % dead) |
| `--files a,b` | `h264.mkv` | fixtures in `--fixtures` |
| `--scenarios a,b` | `start` | `start`, `resume` (open at `--resume-at`), `seek` (start, then seek to `--seek-to` 1 s after the first frame), `storm` |
| `--repeat N` | 3 | runs per cell (fresh engine and data folder each) |
| `--resume-at S` / `--seek-to S` | 605 / 605 | seconds (10:05, mid-GOP: not on a keyframe) |
| `--timeout D` | 45s | first frame (or seek) deadline: missing frames are counted, never dropped |
| `--play-secs S` | 0 | keep playing S s after the first frame and count `paused-for-cache` stalls |
| `--downlink MBIT` | 100 | client downlink shared by all peers (0 = unlimited) |
| `--race-ms MS` | 2500 | race deadline (peer-race.ts: healthy → go; 1.5 s soft commit; deadline) |
| `--presearched` | off | the race ran in the pre-search: tap = `startStream` |
| `--prewarm-ms MS` | 0 | pre-search on Wi-Fi: `prewarm` the winner, MS of browsing, then the tap |
| `--cache-cap SIZE` | engine default 5G | `cacheLimitBytes` (`5G`, `512M`…) |
| `--prefill SPEC` | none | data folder filled before the run: `2G`, `50%`, `95%`, `100%` (of the cap) |
| `--switches N` / `--switch-every D` | 20 / 2s | storm: N switches (popular / obscure in turn, or `--profiles a,b` in turn), then back to the first |
| `--switch-hard` | off | storm: switch exactly every D after the tap, frame or not (default: wait for the frame, then D) |
| `--no-release` | off | storm: do not mirror the app's `release` of the screen it left |
| `--fresh-mpv` | off | storm: a new mpv per switch (default: one mpv, `loadfile replace`) |
| `--mpv-opt k=v` | | extra / overriding mpv option (repeatable), e.g. `--mpv-opt hr-seek=no` |
| `--piece-kib N` | auto | piece size of the generated torrents |
| `--trace` | off | log every HTTP request mpv makes (offset, first byte, bytes) |
| `--out FILE` | | append every run as JSON (timeline of the engine, disk, evictions…) |
| `--work DIR` / `--fixtures DIR` | `target/bench-work` / `target/bench-fixtures` | |

`HUWA_BENCH_LOG=librqbit=debug,huwa_torrent_core=debug` prints the engine's and librqbit's logs.

Profiles (RTT per peer drawn in the range; rates in bytes/s):

| profile | live peers | upload per peer | RTT |
|---|---|---|---|
| `popular` | 30 | 1–3 MB/s | 20–80 ms |
| `mid` | 6 | 500 KB/s | 40–100 ms |
| `obscure` | 1 | 300 KB/s | 150 ms |
| `obscure2` | 2 | 300 KB/s | 150 ms |
| `lan` | 3 | 50 MB/s | 1 ms (engine + mpv floor) |

The whole campaign: `bench/matrix.sh target/release/examples/start_bench after` (cells `start
storm cache prewarm stalls`; `REPEAT=5`).

Prefill: torrents written the way the engine stores them — single episodes (350 MB–1.4 GB) and
12-episode season packs with an extras folder, real files under `<dataDir>/torrents`, added
through an engine (librqbit session JSON + fastresume bitfields + `huwa-entries.json`), built
once per size, then cloned per run with `cp -c` (APFS clone) and the session paths rewritten.

## Results

See the end of this file (filled by the measurement campaign).
