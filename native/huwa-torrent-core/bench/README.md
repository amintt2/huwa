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
| `attach.mkv` | `h264.mkv` + 2 × 3 MiB random "font" attachments before the first cluster | fansub layout: mpv reads every attachment before frame 1 |

Pieces: 1 MiB for files over 800 MiB, 512 KiB below (`--piece-kib` to force).

## Parameters

| flag | default | meaning |
|---|---|---|
| `--profiles a,b` | `popular,mid,obscure` | swarm profiles (below); suffix `-dead` adds 4 dead addresses per live peer (80 % dead) |
| `--files a,b` | `h264.mkv` | fixtures in `--fixtures` |
| `--scenarios a,b` | `start` | `start`, `resume` (open at `--resume-at`), `seek` (start, then seek to `--seek-to` 1 s after the first frame), `storm`; `need` (bytes mpv needs for frame 1, by bisection on a gated HTTP server), `floor-start` / `floor-resume` (time those bytes take to arrive from the swarm, no player), `hang-tail` (HTTP server whose last 2 MiB never come) |
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
| `--verified` / `--unverified` | unverified (engine default `unverifiedStart`) | serve written blocks before the piece's SHA-1 for the opening reads |
| `--engine-cfg k=json` | | extra field of the engine's `initialize` config (repeatable) |
| `--http-proxy` | off | HTTP profiles and `hang-tail`: through the shipped read-ahead proxy (`src/http_proxy.rs`), opened like the app does (`httpOpen` with the resume position) |
| `--duration S` | 1440 | `--http-proxy` resume: the duration the app passes (saved progress) |
| `--no-size` | off | `--http-proxy`: no file size hint (an addon without `behaviorHints.videoSize`) |
| `--net-timeout S` | 8 (MpvCore, remote) | mpv `network-timeout` for HTTP profiles |
| `--hang-once` | off | `hang-tail`: the stuck range hangs once, then answers (a debrid server's first try) |
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
| `few4` | 4 | 300 KB/s | 60–120 ms (device trace: 4 peers at first byte; run with `--piece-kib 2048`) |
| `mixed4` | 4 | 100 KB/s–1.2 MB/s | 40–150 ms (same, peers of very different speeds) |
| `lan` | 3 | 50 MB/s | 1 ms (engine + mpv floor) |
| `http-<ttfb>-<rate>[-norange]` | — | e.g. `http-300ms-10M` | debrid-like HTTP server instead of a swarm: time to first byte per request, MB/s per response; `-norange`: the server ignores Range (200 + whole file) |

The whole campaign: `bench/matrix.sh target/release/examples/start_bench after` (cells `start
storm cache prewarm stalls big http http-proxy hang floor device`; `REPEAT=5`). The baseline
is the same bench built against the original engine with `RUSTFLAGS="--cfg huwa_baseline"`
(its defaults: verified reads, mpv `network-timeout` 20 s).

Prefill: torrents written the way the engine stores them — single episodes (350 MB–1.4 GB) and
12-episode season packs with an extras folder, real files under `<dataDir>/torrents`, added
through an engine (librqbit session JSON + fastresume bitfields + `huwa-entries.json`), built
once per size, then cloned per run with `cp -c` (APFS clone) and the session paths rewritten.

## Results

Machine: Apple Silicon Mac, everything on 127.0.0.1, one bench at a time. Every cell: 5 runs
(cache and stall cells 3), each with a fresh engine, data folder and seeding session.
Values: **median / worst** in seconds; "timeout" = no first frame within 60 s (counted, never
dropped).

- **First frame** = mpv's `playback-restart` after `file-loaded` (MpvCore's `firstFrame`), not
  "bytes ready". **start→frame**: from `startStream` (the tap once the race is decided) to that
  event. **tap→frame** adds the race / probe (peer-race.ts rules: `probe` column of the logs).
- **before** = the engine as it was before this work (huwa-v1 at the start of the task) built
  with the same bench (`--cfg huwa_baseline`: verified reads, mpv `network-timeout` 20 s).
  **after** = branch `worktree-agent-aeec2837276e14ce8`: engine at 7d007b3, pre-warm cells at
  093750e (only the pre-warm path differs), HTTP cells at 1c04b26 (no engine involved).
- Commands: `bench/matrix.sh <binary> <tag> <cells>`, tables: `bench/report.py`.

### Summary (start→frame, median / worst)

| profile | MKV start | MKV resume 10:05 | MKV seek (seek→frame) | MP4 (moov at end) start | MP4 resume |
|---|---|---|---|---|---|
| popular (30 × 1–3 MB/s) | 2.53 / 3.46 → **0.53 / 0.58** | 42.2 / 43.2 → **0.97 / 1.01** | 37.5 / 39.5 → **0.87 / 1.08** | 2.95 / timeout → **0.70 / 0.77** | 44.7 / timeout → **0.97 / 1.00** |
| mid (6 × 500 KB/s) | 4.51 / 12.9 → **0.77 / 0.82** | 11.0 / timeout → **1.46 / 1.60** | 15.9 / timeout → **1.94 / 2.03** | 4.53 / 13.0 → **1.62 / 1.65** | 11.1 / timeout → **1.92 / 2.08** |
| obscure (1 × 300 KB/s) | 7.59 / 7.66 → **1.59 / 1.59** | timeout → **2.74 / 2.80** | timeout → **14.1 / 14.1** | 15.0 / 15.1 → **5.32 / 8.81** | timeout → **6.41 / 6.47** |

Obscure seek: 300 KB/s is below the fixture's bitrate (~710 KB/s); the seek's frame comes
once a keyframe (10 s GOP) is there, and playback stalls afterwards whatever the engine does.

### Floor: when the bytes mpv needs are there, and what is left

`need` = bytes mpv reads before frame 1 (`--scenarios need`: bisection on a gated HTTP server
serving the same file). Floor = the time those bytes take to arrive from the swarm with nothing
else requested (`floor-start` / `floor-resume`: narrow urgent readers, no player). Overhead =
first frame − floor: mpv's serial requests (head, then the index at the end, then back), the
loopback HTTP and the decoder, 0.3–0.8 s. On the single-peer profile the floor tool is
pessimistic (it walks the regions one after the other; the engine fetches head and index in
parallel): a negative overhead there means "at the floor". The verified floor (each piece must
pass its SHA-1 before a byte is served) shows what the unverified opening reads buy: obscure
MKV 7.4 s → 1.6 s, obscure resume 14.4 s → 2.7 s.

### Floor (bytes needed for frame 1 from the swarm) vs actual, unverified

| profile | file | scenario | need KiB | floor (median) | first frame (median) | overhead | overhead % | runs floor / frame |
|---|---|---|---|---|---|---|---|---|
| popular | h264.mkv | start | 336 | 0.21 | 0.53 | 0.32 | 61 % | 5 / 5 |
| mid | h264.mkv | start | 336 | 0.43 | 0.77 | 0.34 | 44 % | 5 / 5 |
| obscure | h264.mkv | start | 336 | 1.59 | 1.59 | 0.01 | 0 % | 5 / 5 |
| popular | moov-end.mp4 | start | 1410 | 0.32 | 0.70 | 0.39 | 55 % | 5 / 5 |
| mid | moov-end.mp4 | start | 1410 | 1.09 | 1.62 | 0.54 | 33 % | 5 / 5 |
| obscure | moov-end.mp4 | start | 1410 | 7.77 | 5.32 | -2.45 | -46 % | 5 / 5 |
| popular | h264.mkv | resume | 480 | 0.32 | 0.97 | 0.65 | 67 % | 5 / 5 |
| mid | h264.mkv | resume | 480 | 0.69 | 1.46 | 0.77 | 53 % | 5 / 5 |
| obscure | h264.mkv | resume | 480 | 2.40 | 2.74 | 0.34 | 12 % | 5 / 5 |
| popular | moov-end.mp4 | resume | 1458 | 0.43 | 0.97 | 0.54 | 56 % | 5 / 5 |
| mid | moov-end.mp4 | resume | 1458 | 1.24 | 1.92 | 0.68 | 36 % | 5 / 5 |
| obscure | moov-end.mp4 | resume | 1458 | 8.48 | 6.41 | -2.07 | -32 % | 5 / 5 |

### Floor, verified reads

| profile | file | scenario | need KiB | floor (median) | first frame (median) | overhead | overhead % | runs floor / frame |
|---|---|---|---|---|---|---|---|---|
| popular | h264.mkv | start | 336 | 0.27 | 0.53 | 0.26 | 49 % | 3 / 5 |
| mid | h264.mkv | start | 336 | 0.95 | 0.77 | -0.18 | -23 % | 3 / 5 |
| obscure | h264.mkv | start | 336 | 7.44 | 1.59 | -5.84 | -367 % | 3 / 5 |
| popular | moov-end.mp4 | start | 1410 | 0.33 | 0.70 | 0.38 | 53 % | 3 / 5 |
| mid | moov-end.mp4 | start | 1410 | 1.21 | 1.62 | 0.41 | 26 % | 3 / 5 |
| obscure | moov-end.mp4 | start | 1410 | 7.88 | 5.32 | -2.56 | -48 % | 3 / 5 |
| popular | h264.mkv | resume | 480 | 0.37 | 0.97 | 0.60 | 62 % | 3 / 5 |
| mid | h264.mkv | resume | 480 | 1.85 | 1.46 | -0.39 | -27 % | 3 / 5 |
| obscure | h264.mkv | resume | 480 | 14.43 | 2.74 | -11.69 | -427 % | 3 / 5 |
| popular | moov-end.mp4 | resume | 1458 | 0.60 | 0.97 | 0.38 | 39 % | 3 / 5 |
| mid | moov-end.mp4 | resume | 1458 | 1.91 | 1.92 | 0.01 | 0 % | 3 / 5 |
| obscure | moov-end.mp4 | resume | 1458 | 14.88 | 6.41 | -8.46 | -132 % | 3 / 5 |

### Start / resume / seek (MKV, MP4)

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| popular | h264.mkv | start | 2.53 / 3.46 | 0.53 / 0.58 | 0.73 / 0.78 |  |  | 5 / 5 |
| mid | h264.mkv | start | 4.51 / 12.89 | 0.77 / 0.82 | 1.17 / 1.23 |  |  | 5 / 5 |
| obscure | h264.mkv | start | 7.59 / 7.66 | 1.59 / 1.59 | 3.22 / 3.23 |  |  | 5 / 5 |
| popular | h264.mkv | resume | 42.21 / 43.15 | 0.97 / 1.01 | 1.18 / 1.21 |  |  | 5 / 5 |
| mid | h264.mkv | resume | 11.04 / timeout | 1.46 / 1.60 | 1.87 / 2.02 |  |  | 5 / 5 |
| obscure | h264.mkv | resume | timeout | 2.74 / 2.80 | 4.37 / 4.45 |  |  | 5 / 5 |
| popular | h264.mkv | seek | 3.38 / 3.77 | 0.45 / 0.58 | 0.65 / 0.78 | 37.53 / 39.48 | 0.87 / 1.08 | 5 / 5 |
| mid | h264.mkv | seek | 4.50 / 10.92 | 0.76 / 0.83 | 1.17 / 1.24 | 15.93 / timeout | 1.94 / 2.03 | 5 / 5 |
| obscure | h264.mkv | seek | 7.59 / 7.60 | 1.59 / 1.59 | 3.22 / 3.22 | timeout | 14.09 / 14.09 | 5 / 5 |
| popular | moov-end.mp4 | start | 2.95 / timeout | 0.70 / 0.77 | 0.91 / 0.97 |  |  | 5 / 5 |
| mid | moov-end.mp4 | start | 4.53 / 12.95 | 1.62 / 1.65 | 2.04 / 2.06 |  |  | 5 / 5 |
| obscure | moov-end.mp4 | start | 15.03 / 15.05 | 5.32 / 8.81 | 6.95 / 10.45 |  |  | 5 / 5 |
| popular | moov-end.mp4 | resume | 44.71 / timeout | 0.97 / 1.00 | 1.18 / 1.20 |  |  | 5 / 5 |
| mid | moov-end.mp4 | resume | 11.07 / timeout | 1.92 / 2.08 | 2.33 / 2.49 |  |  | 5 / 5 |
| obscure | moov-end.mp4 | resume | timeout | 6.41 / 6.47 | 8.04 / 8.10 |  |  | 5 / 5 |
| popular | moov-end.mp4 | seek | 2.87 / 58.28 | 0.65 / 0.71 | 0.85 / 0.92 | 14.36 / 41.11 | 0.86 / 1.24 | 5 / 5 |
| mid | moov-end.mp4 | seek | 4.49 / timeout | 1.61 / 1.67 | 2.02 / 2.07 | 16.08 / timeout | 1.80 / 1.81 | 5 / 5 |
| obscure | moov-end.mp4 | seek | 15.02 / 22.03 | 5.32 / 5.32 | 6.95 / 6.96 | timeout | 15.01 / 15.02 | 5 / 5 |

### Other files

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| popular | faststart.mp4 | start | 3.54 / 3.82 | 0.70 / 0.81 | 0.91 / 1.02 |  |  | 5 / 5 |
| obscure | faststart.mp4 | start | 11.12 / timeout | 5.29 / 5.29 | 6.92 / 6.93 |  |  | 5 / 5 |
| popular | x265.mkv | start | 1.14 / 3.12 | 0.38 / 0.45 | 0.58 / 0.66 |  |  | 5 / 5 |
| obscure | x265.mkv | start | 3.52 / timeout | 1.15 / 1.16 | 2.77 / 2.79 |  |  | 5 / 5 |

### 80 % dead peers

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| popular-dead | h264.mkv | start | 1.39 / 1.69 | 0.40 / 0.44 | 0.63 / 0.80 |  |  | 5 / 5 |
| mid-dead | h264.mkv | start | 4.46 / 4.51 | 0.73 / 0.74 | 1.14 / 1.15 |  |  | 5 / 5 |
| obscure-dead | h264.mkv | start | 7.58 / 7.58 | 1.59 / 1.60 | 3.22 / 3.23 |  |  | 5 / 5 |

### Device traces (few4 / mixed4, 2 MiB pieces; fansub attachments)

few4 / mixed4 reproduce the device timelines (4 peers at first byte, 2 MiB pieces). `attach.mkv`: mpv reads every attachment (6 MiB of fonts here) before frame 1, so the floor is attachments / swarm throughput (obscure: 6.3 MiB at 300 KB/s ≈ 22 s); pre-warm is what helps there (below).

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| few4 | h264.mkv | start | 7.42 / 10.80 | 1.11 / 1.24 | 1.65 / 1.85 |  |  | 5 / 5 |
| mixed4 | h264.mkv | start | 3.51 / 19.46 | 0.79 / 2.28 | 1.40 / 2.89 |  |  | 5 / 5 |
| few4 | h264.mkv | resume | 28.53 / timeout | 2.03 / 2.15 | 2.64 / 2.76 |  |  | 5 / 5 |
| mixed4 | h264.mkv | resume | 27.05 / timeout | 1.99 / 3.40 | 2.39 / 4.01 |  |  | 5 / 5 |
| popular | attach.mkv | start | 6.01 / 9.91 | 1.05 / 1.17 | 1.25 / 1.37 |  |  | 5 / 5 |
| mid | attach.mkv | start | 13.26 / 13.36 | 2.83 / 2.88 | 3.24 / 3.29 |  |  | 5 / 5 |
| few4 | attach.mkv | start | 32.55 / 35.93 | 6.37 / 6.38 | 6.97 / 7.00 |  |  | 5 / 5 |
| obscure | attach.mkv | start | timeout | 22.58 / 23.46 | 24.22 / 25.10 |  |  | 5 / 5 |
| popular | attach.mkv | resume | 41.75 / 42.63 | 1.49 / 1.64 | 1.70 / 1.85 |  |  | 5 / 5 |
| mid | attach.mkv | resume | 21.40 / 21.45 | 3.32 / 3.35 | 3.73 / 3.76 |  |  | 5 / 5 |
| few4 | attach.mkv | resume | timeout | 7.52 / 7.58 | 8.15 / 8.20 |  |  | 5 / 5 |
| obscure | attach.mkv | resume | timeout | 23.73 / 23.74 | 25.38 / 25.41 |  |  | 5 / 5 |

### Big pieces (8 / 16 MiB)

Rows merge the 8 MiB and 16 MiB cells (10 runs). Before: one peer downloads a whole piece; after: the urgent pieces are split block by block between peers (librqbit patch 5).

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| popular | h264.mkv | start | 6.94 / 13.42 | 0.43 / 0.61 | 0.64 / 0.82 |  |  | 10 / 10 |
| mid | h264.mkv | start | 37.69 / timeout | 0.74 / 0.96 | 1.15 / 1.37 |  |  | 10 / 10 |
| obscure | h264.mkv | start | timeout | 1.59 / 1.60 | 3.25 / 3.26 |  |  | 10 / 10 |
| popular | h264.mkv | resume | 15.45 / 36.76 | 0.94 / 1.20 | 1.15 / 1.41 |  |  | 10 / 10 |
| mid | h264.mkv | resume | 55.56 / timeout | 1.25 / 1.33 | 1.67 / 1.75 |  |  | 10 / 10 |
| obscure | h264.mkv | resume | timeout | 2.75 / 3.57 | 4.40 / 5.24 |  |  | 10 / 10 |

### Pre-warm (Wi-Fi pre-search, 8 s / 15 s of browsing)

"before" = the same start without pre-warm. Pre-warm runs only on Wi-Fi (never metered). Before 093750e the pre-warm kept running after the tap: obscure MP4 took 7.35 / 7.37 s.

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| popular | h264.mkv | start | 0.53 / 0.58 | 0.15 / 0.15 | 0.15 / 0.15 |  |  | 5 / 5 |
| mid | h264.mkv | start | 0.77 / 0.82 | 0.29 / 0.39 | 0.29 / 0.39 |  |  | 5 / 5 |
| obscure | h264.mkv | start | 1.59 / 1.59 | 0.15 / 0.15 | 0.15 / 0.15 |  |  | 5 / 5 |
| popular | moov-end.mp4 | start | 0.70 / 0.77 | 0.15 / 0.15 | 0.15 / 0.15 |  |  | 5 / 5 |
| mid | moov-end.mp4 | start | 1.62 / 1.65 | 0.15 / 0.16 | 0.15 / 0.16 |  |  | 5 / 5 |
| obscure | moov-end.mp4 | start | 5.32 / 8.81 | 3.88 / 4.28 | 3.88 / 4.28 |  |  | 5 / 5 |
| popular | attach.mkv | start | 1.05 / 1.17 | 0.27 / 0.38 | 0.27 / 0.38 |  |  | 5 / 5 |
| mid | attach.mkv | start | 2.83 / 2.88 | 0.69 / 0.83 | 0.69 / 0.83 |  |  | 5 / 5 |
| few4 | attach.mkv | start | 6.37 / 6.38 | 1.04 / 1.23 | 1.04 / 1.23 |  |  | 5 / 5 |
| obscure | attach.mkv | start | 22.58 / 23.46 | 8.45 / 8.46 | 8.45 / 8.46 |  |  | 5 / 5 |

### Stalls in the first 5 min of playback

| cell | profile | scenario | start→frame | engine launch ms (median) | disk written to the frame MiB (median) | evictions (count, ms) | stalls: count, paused s (all runs) | runs |
|---|---|---|---|---|---|---|---|---|
| baseline-stalls | popular | start | 2.76 / 3.45 | 0 | 31 | 0, 0 | 2, 9.4 | 3 |
| baseline-stalls | mid | start | 4.48 / 4.49 | 0 | 12 | 0, 0 | 3, 19.0 | 3 |
| after-stalls | popular | start | 0.52 / 0.56 | 1 | 5 | 0, 0 | 0, 0.0 | 3 |
| after-stalls | mid | start | 0.77 / 0.84 | 0 | 1 | 0, 0 | 0, 0.0 | 3 |

### HTTP (debrid-like): baseline mpv 20 s network-timeout vs after

Profiles `http-<time to first byte>-<MB/s>`. Start time is TTFB × mpv’s serial requests + transfer: no engine involved. After = MpvCore options of this branch (resume opens without hr-seek, `network-timeout` 8 s).

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| http-100ms-50M | h264.mkv | start | 0.48 / 0.52 | 0.49 / 0.57 | 0.49 / 0.57 |  |  | 5 / 5 |
| http-300ms-10M | h264.mkv | start | 1.07 / 1.08 | 1.13 / 1.14 | 1.13 / 1.14 |  |  | 5 / 5 |
| http-800ms-2M | h264.mkv | start | 2.64 / 2.66 | 2.69 / 2.71 | 2.69 / 2.71 |  |  | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | start | 0.47 / 0.47 | 0.55 / 0.60 | 0.55 / 0.60 |  |  | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | start | 1.18 / 1.21 | 1.23 / 1.26 | 1.23 / 1.26 |  |  | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | start | 3.22 / 3.23 | 3.27 / 3.30 | 3.27 / 3.30 |  |  | 5 / 5 |
| http-100ms-50M | h264.mkv | resume | 0.84 / 0.84 | 0.60 / 0.60 | 0.60 / 0.60 |  |  | 5 / 5 |
| http-300ms-10M | h264.mkv | resume | 1.76 / 1.79 | 1.43 / 1.45 | 1.43 / 1.45 |  |  | 5 / 5 |
| http-800ms-2M | h264.mkv | resume | 5.52 / 5.54 | 3.67 / 3.68 | 3.67 / 3.68 |  |  | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | resume | 0.73 / 0.76 | 0.52 / 0.53 | 0.52 / 0.53 |  |  | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | resume | 1.49 / 1.50 | 1.23 / 1.24 | 1.23 / 1.24 |  |  | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | resume | 5.24 / 5.24 | 3.27 / 3.27 | 3.27 / 3.27 |  |  | 5 / 5 |
| http-100ms-50M | h264.mkv | seek | 0.46 / 0.49 | 0.51 / 0.51 | 0.51 / 0.51 | 0.47 / 0.58 | 0.49 / 0.51 | 5 / 5 |
| http-300ms-10M | h264.mkv | seek | 1.10 / 1.13 | 1.10 / 1.11 | 1.10 / 1.11 | 0.77 / 0.79 | 0.75 / 0.75 | 5 / 5 |
| http-800ms-2M | h264.mkv | seek | 2.67 / 2.68 | 2.68 / 2.68 | 2.68 / 2.68 | 2.90 / 2.92 | 2.90 / 2.90 | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | seek | 0.50 / 0.53 | 0.52 / 0.52 | 0.52 / 0.52 | 0.54 / 0.55 | 0.48 / 0.51 | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | seek | 1.20 / 1.23 | 1.24 / 1.25 | 1.24 / 1.25 | 0.76 / 0.79 | 0.78 / 0.80 | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | seek | 3.27 / 3.48 | 3.28 / 3.29 | 3.28 / 3.29 | 3.03 / 3.04 | 3.03 / 3.04 | 5 / 5 |

#### A range that never comes (`hang-tail`: the last 2 MiB hang once, then answer)

| file | scenario | before (network-timeout 20 s) | after (8 s) |
|---|---|---|---|
| h264.mkv | start | 20.80 | 8.72 |
| h264.mkv | resume | 21.20 | 8.82 |
| moov-end.mp4 | start | 20.84 | 8.80 |
| moov-end.mp4 | resume | 21.25 | 8.80 |

### HTTP through the read-ahead proxy (shipped: `src/http_proxy.rs`)

`bench/http-proxy-campaign.sh`: the same binary, mpv straight on the link ("before", the app
without the proxy: MpvCore options, `network-timeout` 8 s) vs through the shipped proxy, opened the
way the app opens it (`httpOpen` with the resume position, the duration and the file size an addon
gives as `behaviorHints.videoSize`; unmetered read-ahead), its loopback URL handed to mpv ("after").
5 runs per cell, median / worst, s. What it does at open: head (open-ended for a start, 2 MiB for a
resume), tail (512 KiB suffix for Matroska: Cues + Tags; 2 MiB for MP4: the moov) and the resume
target (5 s before the position, from the mean bitrate) requested in parallel; mpv's reads are then
served from them. Seek (mid-play, to a position nobody predicted) still costs one round trip: same
as before.

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| http-100ms-2M | h264.mkv | start | 0.57 / 0.62 | 0.43 / 0.46 | 0.43 / 0.46 |  |  | 5 / 5 |
| http-100ms-10M | h264.mkv | start | 0.48 / 0.49 | 0.31 / 0.38 | 0.31 / 0.38 |  |  | 5 / 5 |
| http-100ms-50M | h264.mkv | start | 0.47 / 0.48 | 0.25 / 0.26 | 0.25 / 0.26 |  |  | 5 / 5 |
| http-300ms-2M | h264.mkv | start | 1.17 / 1.18 | 0.70 / 0.71 | 0.70 / 0.71 |  |  | 5 / 5 |
| http-300ms-10M | h264.mkv | start | 1.09 / 1.09 | 0.51 / 0.51 | 0.51 / 0.51 |  |  | 5 / 5 |
| http-300ms-50M | h264.mkv | start | 1.07 / 1.07 | 0.47 / 0.47 | 0.47 / 0.47 |  |  | 5 / 5 |
| http-800ms-2M | h264.mkv | start | 2.67 / 2.67 | 1.22 / 1.23 | 1.22 / 1.23 |  |  | 5 / 5 |
| http-800ms-10M | h264.mkv | start | 2.59 / 2.60 | 1.01 / 1.03 | 1.01 / 1.03 |  |  | 5 / 5 |
| http-800ms-50M | h264.mkv | start | 2.57 / 2.57 | 0.97 / 0.97 | 0.97 / 0.97 |  |  | 5 / 5 |
| http-100ms-2M | moov-end.mp4 | start | 1.25 / 1.26 | 1.11 / 1.11 | 1.11 / 1.11 |  |  | 5 / 5 |
| http-100ms-10M | moov-end.mp4 | start | 0.64 / 0.64 | 0.47 / 0.48 | 0.47 / 0.48 |  |  | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | start | 0.51 / 0.51 | 0.29 / 0.30 | 0.29 / 0.30 |  |  | 5 / 5 |
| http-300ms-2M | moov-end.mp4 | start | 1.85 / 1.86 | 1.51 / 1.52 | 1.51 / 1.52 |  |  | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | start | 1.24 / 1.25 | 0.67 / 0.68 | 0.67 / 0.68 |  |  | 5 / 5 |
| http-300ms-50M | moov-end.mp4 | start | 1.11 / 1.12 | 0.50 / 0.50 | 0.50 / 0.50 |  |  | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | start | 3.37 / 3.39 | 2.01 / 2.01 | 2.01 / 2.01 |  |  | 5 / 5 |
| http-800ms-10M | moov-end.mp4 | start | 2.74 / 2.75 | 1.17 / 1.17 | 1.17 / 1.17 |  |  | 5 / 5 |
| http-800ms-50M | moov-end.mp4 | start | 2.60 / 2.62 | 1.00 / 1.01 | 1.00 / 1.01 |  |  | 5 / 5 |
| http-100ms-2M | h264.mkv | resume | 0.84 / 0.85 | 0.71 / 0.74 | 0.71 / 0.74 |  |  | 5 / 5 |
| http-100ms-10M | h264.mkv | resume | 0.60 / 0.61 | 0.30 / 0.30 | 0.30 / 0.30 |  |  | 5 / 5 |
| http-100ms-50M | h264.mkv | resume | 0.57 / 0.58 | 0.25 / 0.26 | 0.25 / 0.26 |  |  | 5 / 5 |
| http-300ms-2M | h264.mkv | resume | 1.65 / 1.65 | 1.20 / 1.20 | 1.20 / 1.20 |  |  | 5 / 5 |
| http-300ms-10M | h264.mkv | resume | 1.42 / 1.42 | 0.51 / 0.51 | 0.51 / 0.51 |  |  | 5 / 5 |
| http-300ms-50M | h264.mkv | resume | 1.39 / 1.39 | 0.47 / 0.47 | 0.47 / 0.47 |  |  | 5 / 5 |
| http-800ms-2M | h264.mkv | resume | 3.65 / 3.66 | 1.73 / 1.73 | 1.73 / 1.73 |  |  | 5 / 5 |
| http-800ms-10M | h264.mkv | resume | 3.42 / 3.43 | 1.01 / 1.02 | 1.01 / 1.02 |  |  | 5 / 5 |
| http-800ms-50M | h264.mkv | resume | 3.39 / 3.39 | 0.97 / 0.97 | 0.97 / 0.97 |  |  | 5 / 5 |
| http-100ms-2M | moov-end.mp4 | resume | 1.25 / 1.27 | 1.11 / 1.11 | 1.11 / 1.11 |  |  | 5 / 5 |
| http-100ms-10M | moov-end.mp4 | resume | 0.63 / 0.64 | 0.47 / 0.47 | 0.47 / 0.47 |  |  | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | resume | 0.51 / 0.51 | 0.28 / 0.29 | 0.28 / 0.29 |  |  | 5 / 5 |
| http-300ms-2M | moov-end.mp4 | resume | 1.86 / 1.87 | 1.50 / 1.51 | 1.50 / 1.51 |  |  | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | resume | 1.23 / 1.24 | 0.67 / 0.67 | 0.67 / 0.67 |  |  | 5 / 5 |
| http-300ms-50M | moov-end.mp4 | resume | 1.11 / 1.11 | 0.50 / 0.52 | 0.50 / 0.52 |  |  | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | resume | 3.36 / 3.37 | 2.00 / 2.01 | 2.00 / 2.01 |  |  | 5 / 5 |
| http-800ms-10M | moov-end.mp4 | resume | 2.73 / 2.74 | 1.17 / 1.17 | 1.17 / 1.17 |  |  | 5 / 5 |
| http-800ms-50M | moov-end.mp4 | resume | 2.61 / 2.62 | 1.00 / 1.00 | 1.00 / 1.00 |  |  | 5 / 5 |
| http-100ms-2M | h264.mkv | seek | 0.56 / 0.58 | 0.46 / 0.46 | 0.46 / 0.46 | 2.20 / 2.21 | 2.20 / 2.21 | 5 / 5 |
| http-100ms-10M | h264.mkv | seek | 0.49 / 0.50 | 0.30 / 0.31 | 0.30 / 0.31 | 0.54 / 0.54 | 0.53 / 0.54 | 5 / 5 |
| http-100ms-50M | h264.mkv | seek | 0.47 / 0.47 | 0.26 / 0.26 | 0.26 / 0.26 | 0.46 / 0.48 | 0.45 / 0.46 | 5 / 5 |
| http-300ms-2M | h264.mkv | seek | 1.17 / 1.18 | 0.71 / 0.71 | 0.71 / 0.71 | 2.40 / 2.40 | 2.41 / 2.42 | 5 / 5 |
| http-300ms-10M | h264.mkv | seek | 1.09 / 1.10 | 0.51 / 0.51 | 0.51 / 0.51 | 0.73 / 0.74 | 0.74 / 0.74 | 5 / 5 |
| http-300ms-50M | h264.mkv | seek | 1.07 / 1.08 | 0.47 / 0.47 | 0.47 / 0.47 | 0.64 / 0.67 | 0.65 / 0.66 | 5 / 5 |
| http-800ms-2M | h264.mkv | seek | 2.67 / 2.67 | 1.22 / 1.22 | 1.22 / 1.22 | 2.90 / 2.91 | 2.91 / 2.91 | 5 / 5 |
| http-800ms-10M | h264.mkv | seek | 2.59 / 2.59 | 1.01 / 1.02 | 1.01 / 1.02 | 1.24 / 1.25 | 1.23 / 1.24 | 5 / 5 |
| http-800ms-50M | h264.mkv | seek | 2.57 / 2.58 | 0.97 / 0.98 | 0.97 / 0.98 | 1.16 / 1.16 | 1.15 / 1.16 | 5 / 5 |
| http-100ms-2M | moov-end.mp4 | seek | 1.26 / 1.27 | 1.11 / 1.12 | 1.11 / 1.12 | 2.21 / 2.21 | 2.20 / 2.21 | 5 / 5 |
| http-100ms-10M | moov-end.mp4 | seek | 0.64 / 0.65 | 0.46 / 0.47 | 0.46 / 0.47 | 0.53 / 0.54 | 0.53 / 0.54 | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | seek | 0.51 / 0.51 | 0.29 / 0.30 | 0.29 / 0.30 | 0.45 / 0.47 | 0.45 / 0.47 | 5 / 5 |
| http-300ms-2M | moov-end.mp4 | seek | 1.86 / 1.86 | 1.51 / 1.53 | 1.51 / 1.53 | 2.41 / 2.41 | 2.40 / 2.42 | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | seek | 1.24 / 1.24 | 0.67 / 0.68 | 0.67 / 0.68 | 0.74 / 0.74 | 0.73 / 0.74 | 5 / 5 |
| http-300ms-50M | moov-end.mp4 | seek | 1.11 / 1.12 | 0.50 / 0.50 | 0.50 / 0.50 | 0.65 / 0.65 | 0.64 / 0.65 | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | seek | 3.37 / 3.38 | 2.00 / 2.01 | 2.00 / 2.01 | 2.91 / 2.91 | 2.90 / 2.91 | 5 / 5 |
| http-800ms-10M | moov-end.mp4 | seek | 2.74 / 2.75 | 1.17 / 1.18 | 1.17 / 1.18 | 1.24 / 1.24 | 1.23 / 1.24 | 5 / 5 |
| http-800ms-50M | moov-end.mp4 | seek | 2.61 / 2.61 | 0.99 / 1.00 | 0.99 / 1.00 | 1.16 / 1.19 | 1.16 / 1.17 | 5 / 5 |

#### Resume without a file size from the addon (`--no-size`)

The target leaves with the first answer (the length), one round trip later; head + tail in
parallel still save one.

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| http-100ms-2M | h264.mkv | resume | 0.84 / 0.85 | 0.71 / 0.74 | 0.71 / 0.74 |  |  | 5 / 5 |
| http-100ms-10M | h264.mkv | resume | 0.60 / 0.61 | 0.40 / 0.40 | 0.40 / 0.40 |  |  | 5 / 5 |
| http-100ms-50M | h264.mkv | resume | 0.57 / 0.58 | 0.26 / 0.27 | 0.26 / 0.27 |  |  | 5 / 5 |
| http-300ms-2M | h264.mkv | resume | 1.65 / 1.65 | 1.19 / 1.20 | 1.19 / 1.20 |  |  | 5 / 5 |
| http-300ms-10M | h264.mkv | resume | 1.42 / 1.42 | 0.80 / 0.81 | 0.80 / 0.81 |  |  | 5 / 5 |
| http-300ms-50M | h264.mkv | resume | 1.39 / 1.39 | 0.67 / 0.68 | 0.67 / 0.68 |  |  | 5 / 5 |
| http-800ms-2M | h264.mkv | resume | 3.65 / 3.66 | 2.53 / 2.54 | 2.53 / 2.54 |  |  | 5 / 5 |
| http-800ms-10M | h264.mkv | resume | 3.42 / 3.43 | 1.80 / 1.81 | 1.80 / 1.81 |  |  | 5 / 5 |
| http-800ms-50M | h264.mkv | resume | 3.39 / 3.39 | 1.68 / 1.68 | 1.68 / 1.68 |  |  | 5 / 5 |
| http-100ms-2M | moov-end.mp4 | resume | 1.25 / 1.27 | 1.10 / 1.11 | 1.10 / 1.11 |  |  | 5 / 5 |
| http-100ms-10M | moov-end.mp4 | resume | 0.63 / 0.64 | 0.47 / 0.48 | 0.47 / 0.48 |  |  | 5 / 5 |
| http-100ms-50M | moov-end.mp4 | resume | 0.51 / 0.51 | 0.36 / 0.36 | 0.36 / 0.36 |  |  | 5 / 5 |
| http-300ms-2M | moov-end.mp4 | resume | 1.86 / 1.87 | 1.51 / 1.51 | 1.51 / 1.51 |  |  | 5 / 5 |
| http-300ms-10M | moov-end.mp4 | resume | 1.23 / 1.24 | 0.84 / 0.85 | 0.84 / 0.85 |  |  | 5 / 5 |
| http-300ms-50M | moov-end.mp4 | resume | 1.11 / 1.11 | 0.77 / 0.78 | 0.77 / 0.78 |  |  | 5 / 5 |
| http-800ms-2M | moov-end.mp4 | resume | 3.36 / 3.37 | 2.24 / 2.24 | 2.24 / 2.24 |  |  | 5 / 5 |
| http-800ms-10M | moov-end.mp4 | resume | 2.73 / 2.74 | 1.85 / 1.85 | 1.85 / 1.85 |  |  | 5 / 5 |
| http-800ms-50M | moov-end.mp4 | resume | 2.61 / 2.62 | 1.77 / 1.77 | 1.77 / 1.77 |  |  | 5 / 5 |

#### Server ignoring Range (`http-…-norange`)

The proxy finds out from its first answers (head and suffix both `200`) and redirects mpv to the
original link: one round trip lost the first time, then the origin is remembered for the app's
session (`httpOpen` answers `fallback: "noRange"` at once). Each bench run starts a fresh proxy, so
every row pays it.

| profile | file | scenario | before: start→frame | after: start→frame | after: tap→frame | before: seek | after: seek | runs |
|---|---|---|---|---|---|---|---|---|
| http-300ms-10M-norange | h264.mkv | start | 0.47 / 0.48 | 0.77 / 0.78 | 0.77 / 0.78 |  |  | 5 / 5 |
| http-800ms-2M-norange | h264.mkv | start | 1.02 / 1.03 | 1.83 / 1.84 | 1.83 / 1.84 |  |  | 5 / 5 |

#### A range that never comes (`hang-tail --hang-once`: the last 2 MiB hang once)

| file | scenario | before (mpv alone, `network-timeout` 8 s) | after (proxy) |
|---|---|---|---|
| h264.mkv | start | 8.73 / 8.74 | 0.37 / 0.38 |
| h264.mkv | resume | 8.79 / 8.79 | 0.30 / 0.30 |
| moov-end.mp4 | start | 8.80 / 8.81 | 0.40 / 0.41 |
| moov-end.mp4 | resume | 8.80 / 8.81 | 0.40 / 0.41 |

The stuck request is the proxy's own tail prefetch; mpv's read is served by a new request (a
range that stops delivering is asked again after 2–6 s, `stall_after`, or at once when a new
request is sooner than the stuck one could be).

### Storm

20 switches every 2 s, popular / obscure in turn, then back to the first; the app’s `release` of the screen left is mirrored. "later starts" = switches 2…21.

#### baseline-storm.jsonl
- popular: first start 1.499 s; later starts median 17.351 s, worst 28.258 s, no frame 3/11
- obscure: first start 3.494 s; later starts median 7.033 s, worst 16.019 s, no frame 3/9
- resources at the end: {'connecting': 2, 'disk_mib': 1182, 'fds': 945, 'inflight_kib': 258958, 'live': 7, 'net_conns': 129, 'peers': 128, 'responses': 1, 'rss_mib': 350, 'tasks': 375, 'torrents': 10}
- peaks: {'live': 8, 'peers': 128, 'net_conns': 129, 'tasks': 375, 'rss_mib': 350, 'fds': 945, 'disk_mib': 1474}
#### after-storm.jsonl
- popular: first start 0.54 s; later starts median 0.745 s, worst 0.964 s, no frame 0/11
- obscure: first start 1.049 s; later starts median 1.093 s, worst 1.155 s, no frame 0/9
- resources at the end: {'connecting': 0, 'disk_mib': 671, 'fds': 584, 'inflight_kib': 18334, 'live': 1, 'net_conns': 30, 'peers': 30, 'responses': 1, 'rss_mib': 82, 'tasks': 99, 'torrents': 21}
- peaks: {'live': 2, 'peers': 32, 'net_conns': 31, 'tasks': 109, 'rss_mib': 82, 'fds': 586, 'disk_mib': 671}
#### baseline-cache-storm-95.jsonl
- popular: first start 2.76 s; later starts median 19.668 s, worst 29.95 s, no frame 2/11
- obscure: first start 3.5 s; later starts median 7.445 s, worst 16.969 s, no frame 4/9
- resources at the end: {'connecting': 0, 'disk_mib': 1338, 'fds': 936, 'inflight_kib': 254938, 'live': 7, 'net_conns': 127, 'peers': 127, 'responses': 1, 'rss_mib': 351, 'tasks': 374, 'torrents': 10}
- peaks: {'live': 8, 'peers': 127, 'net_conns': 127, 'tasks': 374, 'rss_mib': 351, 'fds': 936, 'disk_mib': 4897}
#### after-cache-storm-95.jsonl
- popular: first start 0.506 s; later starts median 0.746 s, worst 0.948 s, no frame 0/11
- obscure: first start 1.065 s; later starts median 1.069 s, worst 1.122 s, no frame 0/9
- resources at the end: {'connecting': 0, 'disk_mib': 5534, 'fds': 602, 'inflight_kib': 18975, 'live': 4, 'net_conns': 30, 'peers': 30, 'responses': 1, 'rss_mib': 84, 'tasks': 123, 'torrents': 24}
- peaks: {'live': 5, 'peers': 32, 'net_conns': 31, 'tasks': 133, 'rss_mib': 84, 'fds': 604, 'disk_mib': 5534}

### Cache

Cap 5 / 10 GB, data folder empty / 2 GB / 50 % / 95 % / 100 % full before the tap. Eviction runs in the background (LRU, headroom), never on the start path: start times at 95–100 % are within the noise of the empty cache (rule: ≤ ~100 ms). Obscure stalls: the swarm (300 KB/s) is slower than the bitrate; before, playback stopped for good (~59 s paused of 60), after it keeps playing between stalls.

| cell | profile | scenario | start→frame | engine launch ms (median) | disk written to the frame MiB (median) | evictions (count, ms) | stalls: count, paused s (all runs) | runs |
|---|---|---|---|---|---|---|---|---|
| baseline-cache-5G-0 | popular | start | 3.39 / 3.42 | 0 | 33 | 0, 0 | 2, 4.7 | 3 |
| baseline-cache-5G-0 | obscure | start | 7.56 / 7.89 | 1 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-5G-2G | popular | start | 2.65 / 2.67 | 6 | 30 | 0, 0 | 2, 5.1 | 3 |
| baseline-cache-5G-2G | obscure | start | 7.59 / 7.62 | 4 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-5G-50% | popular | start | 2.68 / 2.68 | 3 | 30 | 0, 0 | 1, 5.0 | 1 |
| baseline-cache-5G-95% | popular | start | 2.96 / 3.43 | 5 | 33 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-5G-95% | obscure | start | 7.59 / 7.59 | 3 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-5G-100% | popular | start | 2.63 / 2.76 | 3 | 30 | 0, 0 | 2, 6.4 | 3 |
| baseline-cache-5G-100% | obscure | start | 7.60 / 7.62 | 4 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-5G-100%-seek | popular | resume | 42.20 / 42.34 | 3 | 441 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-5G-100%-seek | obscure | resume | timeout | 2 | 0 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-5G-100%-seek | popular | seek | 2.63 / 2.88 | 3 | 30 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-5G-100%-seek | obscure | seek | 7.59 / timeout | 2 | 2 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-10G-0 | popular | start | 3.46 / 3.48 | 0 | 34 | 0, 0 | 1, 5.5 | 3 |
| baseline-cache-10G-0 | obscure | start | 7.58 / 7.60 | 0 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-10G-2G | popular | start | 2.78 / 3.42 | 4 | 31 | 0, 0 | 1, 4.8 | 3 |
| baseline-cache-10G-2G | obscure | start | 7.59 / 7.60 | 4 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-10G-50% | popular | start | 2.88 / 3.48 | 3 | 32 | 0, 0 | 2, 5.9 | 3 |
| baseline-cache-10G-50% | obscure | start | 7.58 / 7.59 | 2 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-10G-95% | popular | start | 2.76 / 2.79 | 6 | 31 | 0, 0 | 2, 8.8 | 3 |
| baseline-cache-10G-95% | obscure | start | 7.59 / 7.60 | 6 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-10G-100% | popular | start | 2.60 / 2.75 | 6 | 30 | 0, 0 | 1, 1.1 | 3 |
| baseline-cache-10G-100% | obscure | start | 7.58 / 7.59 | 5 | 2 | 0, 0 | 3, 176.6 | 3 |
| baseline-cache-10G-100%-seek | popular | resume | 41.51 / 41.85 | 6 | 444 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-10G-100%-seek | obscure | resume | timeout | 5 | 0 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-10G-100%-seek | popular | seek | 2.94 / 3.45 | 6 | 33 | 0, 0 | 0, 0.0 | 3 |
| baseline-cache-10G-100%-seek | obscure | seek | 7.59 / 7.60 | 5 | 2 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-0 | popular | start | 0.49 / 0.53 | 0 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-0 | obscure | start | 1.60 / 1.60 | 0 | 0 | 0, 0 | 24, 106.8 | 3 |
| after-cache-5G-2G | popular | start | 0.46 / 0.56 | 3 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-2G | obscure | start | 1.60 / 2.04 | 2 | 0 | 0, 0 | 24, 107.0 | 3 |
| after-cache-5G-50% | popular | start | 0.48 / 0.56 | 3 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-50% | obscure | start | 1.60 / 1.61 | 3 | 0 | 0, 0 | 24, 106.6 | 3 |
| after-cache-5G-95% | popular | start | 0.46 / 0.57 | 3 | 4 | 6, 0 | 0, 0.0 | 3 |
| after-cache-5G-95% | obscure | start | 1.60 / 1.61 | 2 | 0 | 3, 0 | 24, 107.0 | 3 |
| after-cache-5G-100% | popular | start | 0.39 / 0.40 | 2 | 3 | 3, 0 | 0, 0.0 | 3 |
| after-cache-5G-100% | obscure | start | 1.60 / 1.60 | 3 | 0 | 0, 0 | 24, 106.9 | 3 |
| after-cache-5G-100%-seek | popular | resume | 0.93 / 1.12 | 3 | 10 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-100%-seek | obscure | resume | 2.75 / 2.75 | 2 | 1 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-100%-seek | popular | seek | 0.46 / 0.49 | 2 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-5G-100%-seek | obscure | seek | 1.60 / 1.60 | 2 | 0 | 0, 0 | 3, 2.9 | 3 |
| after-cache-10G-0 | popular | start | 0.45 / 0.56 | 0 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-10G-0 | obscure | start | 1.60 / 1.60 | 0 | 0 | 0, 0 | 24, 106.6 | 3 |
| after-cache-10G-2G | popular | start | 0.48 / 0.56 | 4 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-10G-2G | obscure | start | 1.59 / 1.59 | 3 | 0 | 0, 0 | 24, 107.0 | 3 |
| after-cache-10G-50% | popular | start | 0.48 / 0.57 | 3 | 5 | 0, 0 | 0, 0.0 | 3 |
| after-cache-10G-50% | obscure | start | 1.59 / 1.60 | 3 | 0 | 0, 0 | 24, 107.3 | 3 |
| after-cache-10G-95% | popular | start | 0.53 / 0.55 | 6 | 5 | 3, 0 | 0, 0.0 | 3 |
| after-cache-10G-95% | obscure | start | 1.60 / 1.60 | 6 | 0 | 3, 0 | 24, 106.9 | 3 |
| after-cache-10G-100% | popular | start | 0.58 / 0.60 | 6 | 6 | 3, 0 | 0, 0.0 | 3 |
| after-cache-10G-100% | obscure | start | 1.60 / 1.60 | 5 | 1 | 0, 0 | 24, 106.9 | 3 |
| after-cache-10G-100%-seek | popular | resume | 0.94 / 1.04 | 5 | 10 | 0, 0 | 0, 0.0 | 3 |
| after-cache-10G-100%-seek | obscure | resume | 2.75 / 2.76 | 5 | 1 | 0, 0 | 0, 0.0 | 3 |
| after-cache-10G-100%-seek | popular | seek | 0.43 / 0.47 | 5 | 4 | 0, 0 | 0, 0.0 | 3 |
| after-cache-10G-100%-seek | obscure | seek | 1.60 / 1.60 | 5 | 1 | 0, 0 | 3, 3.0 | 3 |

### What remains

- Bytes before frame 1: MP4 `moov` (1.4 MB here) and fansub font attachments (MiB) bound the
  start on slow swarms; pre-warm (Wi-Fi) is the only lever there.
- A single slow peer's throughput (obscure): the first frame is at the floor; seeks stall.
- mpv's serial requests (head → index → back): 0.3–0.8 s over the floor on fast swarms. On HTTP
  the read-ahead proxy removes them (one round trip for a start or a resume); a seek still pays one.
