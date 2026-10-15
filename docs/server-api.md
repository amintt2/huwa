# Huwa Server API (`/api/v1`)

Status: **phase 2** (`docs/WEB_DOCKER_PLAN.md`, decisions D9–D15). The phase 0 contract (S3) is
unchanged; phase 2 adds media (§12), the Stremio-compatible surface (§13) and the server plumbing
(§14), and settles the S3 open questions (§15).
Implementation: `native/huwa-server` (Rust/axum) on top of `native/huwa-torrent-core` with the
`server` cargo feature. Consumers: `modules/huwa-torrent/index.web.ts` (thin HTTP transport, agent C),
web player and source resolver (agent B), packaging (agent E). Operators: `docs/SELF_HOSTING.md`.

Anything marked **(planned)** is not implemented. Clients must ignore unknown JSON fields: fields
will be added without bumping the API version. Removing or renaming a field, or changing a
meaning, bumps `api` (and the path to `/api/v2`).

## 1. Overview

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness, `200 ok` (text) |
| `GET /metrics` | loopback (or `HUWA_METRICS=1`) | Prometheus counters (§14) |
| `GET /huwa-config.json` | none | runtime config of the web app (§14) |
| `GET /api/v1/info` | none | version, features, limits |
| `POST /api/v1/session` | none (optional Ed25519 proof) | create a per-browser session → token |
| `POST /api/v1/engine/{method}` | `Authorization: Bearer <token>` | torrent engine and HTTP proxy calls (mirror of `api.rs`) |
| `POST /api/v1/media/probe` | Bearer | ffprobe + decision for a stream the session holds (§12) |
| `GET /s/{token}/t/{infoHash}/{file}` | media token in path | torrent file stream, `Range` → `206` |
| `GET /s/{token}/http/{id}[.{ext}]` | media token in path | read-ahead proxy stream of a remote HTTP(S) file |
| `GET /s/{token}/hls/{media}/…` | media token in path | fMP4 HLS (remux / transcode) (§12) |
| `GET /s/{token}/subs/{media}/{track}.vtt\|.ass` | media token in path | text subtitle sidecars (§12) |
| `GET /s/{token}/fonts/{media}[/{n}]` | media token in path | MKV attachments (fonts) (§12) |
| `/p2p`, `/p2p/…` | (the gateway's) | HTTP + WebSocket relayed to the P2P gateway (§14) |
| `/settings`, `/{infoHash}/…`, `/hlsv2/…`, … | none | Stremio-compatible surface, opt-in (§13) |
| `/` and everything else | none | the web app (SPA), when `HUWA_WEB_DIR` is set |
| `POST /api/v1/fetch` | | **(planned, P5)** CORS bridge for Paperback / debrid |

One TCP port (`HUWA_PORT`, 8080). Media routes accept `GET` and `HEAD`. Unknown `/api/…`, `/s/…`,
`/hlsv2/…` paths are `404` with the error envelope; other unknown paths serve the web app.

The `-web` image (huwa.mciut.fr) is built without the engine (`--no-default-features`): no
`/api/v1/engine`, no `/s/…`, no media, no compat routes (all `404`), `features.torrent: false`.

## 2. Configuration (environment)

The full table, with defaults, is in `docs/SELF_HOSTING.md` §7. The ones that change what clients
see:

| Variable | Default | Effect on the API |
| --- | --- | --- |
| `HUWA_PUBLIC_URL` | unset | media URLs are absolute (`{publicUrl}/s/…`) when set, server-relative otherwise |
| `HUWA_ALLOWED_ORIGINS` | `self,https://huwa.mciut.fr` | CORS allowlist (§9) |
| `HUWA_STREAMS_PER_SESSION` | `2` | stream slots (§7) |
| `HUWA_TRANSCODES_MAX` / `_PER_SESSION` | `1` / `1` | concurrent video transcodes (§7) |
| `HUWA_PROXY_SESSIONS_PER_SESSION` | `8` | `httpOpen` cap per session (§7) |
| `HUWA_SESSIONS_PER_IP` / `HUWA_MAX_SESSIONS` | `5` / `50` | `POST /session` limits (§3) |
| `HUWA_REQUIRE_IDENTITY` | `0` | `POST /session` needs the Ed25519 proof (§3) |
| `HUWA_STREAM_TOKEN_HOURS` | `6` | lifetime of media tokens (§6) |
| `HUWA_TORRENT`, `HUWA_TRANSCODE`, `HUWA_STREMIO_COMPAT`, `HUWA_P2P_GATEWAY` | `1`, `1`, `0`, `1` | `features` of `/api/v1/info` |

Booleans accept `1/0`, `true/false`, `yes/no`, `on/off`.

BitTorrent upload is **compiled out** (`disable-upload`) and never enabled. `/api/v1/info` reports
`features.seeding: false`, and `setConfig {seeding}` is not available to sessions.

## 3. Sessions and tokens

`POST /api/v1/session`, body `{}` or the D11 proof `{publicKey, ts, sig}`:

- `publicKey`: the browser's Ed25519 public key, 32 bytes, hex or base64url;
- `ts`: Unix seconds (milliseconds accepted), within 5 minutes of the server clock;
- `sig`: Ed25519 signature, 64 bytes (hex or base64url), of the UTF-8 string
  `huwa/session/v1|<ts>|<publicKey as lower-case hex>` (`<ts>` exactly as sent).

```http
POST /api/v1/session
→ 201 Created
{
  "token": "v1.<sid>.<exp>.<mac>",
  "sessionId": "<sid>",
  "expiresAt": 1794582668,
  "mediaBase": "/s/v1.<sid>.<exp>.<mac>",
  "identity": "<publicKey hex>" | null,
  "limits": { "streams": 2, "transcodes": 1, "proxySessions": 8 }
}
```

- **Format.** `v1.<sid>.<exp>.<mac>`:
  - `sid` is 16 random bytes as lower-case hex;
  - `exp` is the expiry in Unix seconds;
  - `mac` is HMAC-SHA256(server key, `huwa/session/v1|<sid>|<exp>`) as hex.

  The token is opaque to clients: store it, don't parse it.
- **Capability.** Whoever holds the token is the session. API calls send it as
  `Authorization: Bearer <token>`. Media URLs carry a separate, narrower **media token** in their
  path (§6). Never log full media URLs, and never put tokens in query strings.
- **Validation.** The server checks the format, then the MAC in constant time, then the expiry.
  The key lives in `HUWA_DATA_DIR/token.key` (created at first start, mode 0600). Without a usable
  data dir, the key is random per process and tokens die with a restart.
- **Proof.** A bad proof is `400 invalid_proof`. A valid one binds the session to the key: the
  same key gets the **same session** back (a fresh token for it) without counting against its
  address again. With `HUWA_REQUIRE_IDENTITY=1`, a request without a proof is
  `401 identity_required`. `/api/v1/info` says `session.identity: "optional" | "required"`.
- **Limits.** A session is *active* while used in the last 24 h.
  - `HUWA_MAX_SESSIONS` active sessions server-wide: `503 server_full` (`limit`, `Retry-After`).
  - `HUWA_SESSIONS_PER_IP` active sessions created from one client address (IPv6 grouped by /64):
    `429 too_many_sessions` (`limit`, `Retry-After`). Behind a reverse proxy, set
    `HUWA_TRUST_PROXY=1`: the right-most `X-Forwarded-For` entry (else `X-Real-IP`) is the client.
- **State.** The server keeps in memory the torrents held, the stream slots, the proxy sessions,
  the probes and the media sessions. A valid token that the process does not know (after a
  restart) gets a fresh, empty state. Clients must cope with `list` becoming empty: start the
  stream again.
- **Expiry.** An expired token returns `401 session_expired`. Create a new session.
- **Multiple tokens.** One browser profile should keep one token (or one key).

## 4. Envelopes

- **Success.** `2xx` with the method's JSON result as the whole body. There is no `{ok: …}`
  wrapper. Responses are `Cache-Control: no-store`.
- **Error.** Non-`2xx` with `{"error": "<human message>", "code": "<machine code>", …extra}`.
  The `error` string is the same field that `api::envelope` returns on mobile, so a transport can
  map both the same way.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | invalid JSON or non-object body, missing or invalid `infoHash` / `id` / `ids` / `url` |
| 400 | `engine_error` | the engine refused the call (message from the engine) |
| 400 | `invalid_proof` | `POST /session`: malformed, stale or forged Ed25519 proof |
| 401 | `unauthorized` | missing, malformed or forged token (`WWW-Authenticate: Bearer`) |
| 401 | `session_expired` | session token past `expiresAt` |
| 401 | `token_expired` | media token past its expiry: ask the API for a new URL |
| 401 | `identity_required` | `HUWA_REQUIRE_IDENTITY=1` and no proof |
| 403 | `forbidden_method` | operator-only engine method (§5) |
| 403 | `upstream_blocked` | upstream refused by the IP policy (§8) |
| 404 | `not_found` | unknown route, or a torrent / probe / proxy / media session that this session does not hold. The server never reveals whether another session holds it. |
| 404 | `unknown_method` | not an engine method |
| 409 | `transcode_disabled` | `HUWA_TRANSCODE=0` and the plan needs a transcode |
| 429 | `quota_exceeded` | a quota (§7). Extra fields `limit` and, except for stream slots, `kind` (`proxy`, `transcode_session`, `transcode_server`); header `Retry-After: 10` |
| 429 | `too_many_sessions` | sessions per address (§3) |
| 502 | `probe_failed`, `transcode_failed`, `extract_failed` | ffprobe / ffmpeg failed (message without internal URLs) |
| 503 | `server_full` | `HUWA_MAX_SESSIONS` (§3) |
| 503 | `segment_not_ready` | an HLS segment / init not produced within 30 s: retry (`Retry-After`) |
| 503 | `p2p_unavailable`, `too_many_connections` | `/p2p` gateway down / `HUWA_MAX_WS` reached |
| 500 | `internal` | server bug |

The media routes use the same envelope for auth, ownership and quota errors (`401`, `404`, `429`).
Errors from the engine itself keep the mobile server's plain-text bodies:
- `404` unknown torrent or file;
- `416` with `Content-Range: bytes */len`;
- `502` / `503`;
- `504` when the metadata is not resolved within 90 s.

Proxy errors keep the upstream status (`401` / `403` / `404` / `410` / `451`), and `403` for an
upstream refused by the policy.

## 5. `POST /api/v1/engine/{method}`

The body is the method's arguments object (an empty body means `{}`). Methods and shapes are those
of `native/huwa-torrent-core/src/api.rs` and `http_proxy.rs`, in camelCase, with per-session rules.
URLs in results are **media URLs** (§6).

| Method | Args | Result | Session rules |
| --- | --- | --- | --- |
| `startStream` | `{infoHash, fileIdx?, sources?, name?, metered?}` | `{id, url, infoHash}` | Takes a stream slot (§7; `429` when full). The session now holds the torrent, which is deduplicated by info hash across sessions, and it becomes **this session's focus** (§15.1). `sources` are Stremio-style (`tracker:<url>`, `dht:<ih>`). |
| `prewarm` | same as `startStream` | same | Holds the torrent without taking a slot or the focus. Fetches the head and the container index, then parks. |
| `status` | `{id}` (or `{infoHash}`) | `TorrentStatus` | `404` unless held |
| `list` | `{}` | `TorrentStatus[]` | only the torrents held by this session |
| `stats` | `{}` | `EngineStats` | `torrents` filtered to this session; `port` is `0`; cache figures are global |
| `pause` / `resume` | `{id}` | `true` | `404` unless held. `pause` is a no-op while another session holds the torrent. |
| `release` | `{id, at?}` | `true`/`false` | Frees the slot. Parks the torrent only if this session is its last holder. |
| `remove` | `{id}` | `true` | Frees the slot and drops this session's hold. The last holder deletes the torrent and its data. |
| `probeStart` | `{infoHash, sources?, name?, fileIdx?, filename?, episode?, timeoutMs?, minPeers?}` | `ProbeStatus` | the probe id is recorded for this session |
| `probeStatus` | `{id}` → `ProbeStatus`; `{ids}` → `ProbeStatus[]` | | ids not owned: `404` for `{id}`; left out for `{ids}` |
| `probeCancel` | `{id}` or `{ids}` | `true` | owned ids only |
| `httpOpen` | `{url, headers?, prefetch?: {startAt?, duration?, readAhead?, target?, size?, container?}}` | `{id, url, reused}` or `{fallback: "noRange"\|"unsupported", reused}` | Upstream checked by the IP policy (`403 upstream_blocked`). At most `HUWA_PROXY_SESSIONS_PER_SESSION` held per session (`429`, `kind: "proxy"`). Proxy sessions are deduplicated by URL and headers; each `httpOpen` takes one reference for this session. |
| `httpPrefetch` | `{id, startAt?, duration?, readAhead?, target?}` | `true` | owned ids only |
| `httpStatus` | `{id}` | `HttpStatus` | owned ids only |
| `httpRelease` | `{id}` | `true` | drops one of this session's references (the last one frees its stream slot) |
| `setConfig`, `clearCache`, `enforceQuota`, `tlsCheck` | | | `403 forbidden_method`: operator settings come from env |

The main shapes are defined in `engine.rs`, `probe.rs` and `http_proxy.rs`.

**`TorrentStatus` fields:**
- identity and state: `id`, `infoHash`, `name`, `state` (`resolving|initializing|live|paused|finished|error`), `error`;
- progress and speed: `progress`, `progressBytes`, `totalBytes`, `downloadBps`, `uploadBps` (always 0);
- peers: `peersLive`, `peersConnecting`, `peersSeen`;
- files and playback: `files[] {idx, name, size, progressBytes}`, `selectedFile`, `url`, `activeStreams` (global);
- bookkeeping: `addedAt`, `lastAccess`, `sizeOnDisk`;
- streaming health: `health` (`ok|searching|stalled|recovering|idle`), `recoveries`;
- `start`: the start timeline (`startedAt`, `metaMs`, `metaFrom`, `firstPeerMs`, `firstPieceMs`, `firstRequestMs`, `firstByteMs`, `bytesServed`, `requests`, `tailRequests`, …).

**`ProbeStatus` fields:** `id`, `infoHash`, `state`, `metaMs`, `peers`, `connected`, `fileIdx`,
`fileName`, `fileSize`, `fileCount`, `pieceLength`, `local`, `elapsedMs`, `error`. `state` is one of
`queued|resolving|healthy|weak|noFile|failed|cancelled`.

**`HttpStatus` fields:** `id`, `host` (redacted to scheme and host), `length`, `rangeOk`, `noRange`,
`error {status, message}`, `bytesFetched`, `bytesServed`, `upstreamRequests`, `ttfbMs`, `segments`,
`retainedBytes`, `refs`.

**Events (planned).** There is no push channel yet; clients poll `status` / `httpStatus` (1 s while
starting, 5 s while playing). An SSE stream `GET /api/v1/events` with the Bearer header (via
`fetch`) is planned.

## 6. Media URLs and media tokens

The engine and the proxy build `/t/{infoHash}/{file}` and `/http/{id}[.{ext}]`. The server rewrites
every `url` field of a result into a media URL carrying a **media token** for that one stream:

```
{publicUrl?}/s/{mediaToken}/t/{infoHash}/{fileIdx|auto}[.{ext}]
{publicUrl?}/s/{mediaToken}/http/{id}[.{ext}]
{publicUrl?}/s/{mediaToken}/hls/{media}/master.m3u8        (from /api/v1/media/probe)
```

- **Media token:** `m1.<sid>.<scope>.<exp>.<mac>`, `mac` = HMAC-SHA256(server key,
  `huwa/stream/v1|<sid>|<scope>|<exp>`). `scope` is `t-<infoHash>`, `h-<proxy id>` or
  `m-<media id>` (one media id covers its HLS, subtitles and fonts). It expires after
  `HUWA_STREAM_TOKEN_HOURS` (6 h, never after the session). A leaked media URL gives one stream for
  a few hours, never the session's API or its other streams. A token for another scope of the same
  session answers `404`; an expired one `401 token_expired` (ask the API again: `status`,
  `httpOpen` reused, or `probe`).
- Session tokens are still accepted in media paths (phase 0 clients), with the same ownership
  checks. New clients should only use the URLs the API returns.
- Every media response (streams, playlists, segments, sidecars, fonts) sends
  `Referrer-Policy: no-referrer`.
- Clients always resolve URLs against the server base (`new URL(url, serverBase)`). This works for
  both the relative and the absolute form.
- `{file}` is the index of the file in the torrent, or `auto` (the largest video). The extension is
  a hint for the player. The server ignores it.
- Torrent streams: `Accept-Ranges: bytes`, `Range` → `206` with `Content-Range`, `416` when
  unsatisfiable, `Content-Type` from the extension (`video/x-matroska`, `video/mp4`, …), and
  `Cache-Control: no-store`. A cold request waits for the metadata, up to 90 s, then answers `504`.
- Proxy streams: same Range semantics. The server answers `302` to the original URL when the
  upstream ignores Range, and `403` when the upstream is refused by the policy.
- A media request for a torrent, proxy or media session that the token's session does not hold
  returns `404`. A forged token returns `401`.

## 7. Quotas

- **Stream slots.** A session has `HUWA_STREAMS_PER_SESSION` slots (2), one per distinct stream:
  an info hash, or an HTTP proxy session (`http:<id>`: proxy streams count too, §15.3).
  - A slot is taken by `startStream`, by a media request (torrent, proxy, HLS of that source) on a
    held stream that has no slot.
  - A slot is refreshed by every media request; it stays busy while a response body is open.
  - A slot is freed by `release`, `remove`, the last `httpRelease`, or after 120 s with no open
    response and no request.
  - A third distinct stream returns `429 quota_exceeded` with `{"limit": 2}`. A refused torrent
    is not registered for the session.
  - Re-starting a held stream, `prewarm`, `probe*`, `httpOpen` and `media/probe` take no slot.
- **HTTP proxy sessions.** At most `HUWA_PROXY_SESSIONS_PER_SESSION` (8) held per session
  (`429`, `kind: "proxy"`: `httpRelease` some); `HUWA_PROXY_SESSIONS` (32) live server-wide (the
  least recently used idle one is evicted); `HUWA_PROXY_READAHEAD_MB` (48) of read-ahead each.
- **Transcodes.** A video transcode (an HLS job in `transcode` mode, running or paused) counts
  against `HUWA_TRANSCODES_PER_SESSION` (1) and `HUWA_TRANSCODES_MAX` (1). Checked when
  `master.m3u8` creates the job's variant and when a job (re)starts: `429 quota_exceeded`,
  `kind: "transcode_session" | "transcode_server"`. A seek restarts the session's own job and is
  never refused. Remux jobs (copy video, AAC audio) are not counted.
- **Background work.** A session holds at most 32 torrents (`startStream` / `prewarm`) and runs
  at most 16 swarm probes (`429`, `kind: "torrents" | "probes"`). Media probes: one ffprobe per
  source at a time, 4 server-wide (others wait); files longer than 12 h are refused
  (`502 probe_failed`).
- **Deduplication.** One engine torrent per info hash, whatever the number of sessions. A
  per-hash holder count decides who may `pause` / `release` / delete it (the last holder).
- **Cache.** `HUWA_CACHE_MAX_GB` is a global LRU over idle torrents. A janitor drops expired
  sessions every minute (and their focus), parks torrents nobody holds any more, stops idle HLS
  jobs (60 s) and closes idle media sessions (30 min).
- **Download.** `HUWA_DOWNLOAD_LIMIT_MBPS` caps the engine (0 = unlimited).

## 8. Upstream IP policy (HTTP proxy, server-side fetches)

The policy is enforced in `native/huwa-torrent-core/src/net_policy.rs` (feature `server`), for the
HTTP proxy and for everything the server fetches itself (compat `/subtitles.vtt`, compat
`/hlsv2` remote `mediaURL`, which goes through the proxy).

- **Denied:**
  - loopback: `127/8`, `::1`;
  - unspecified: `0/8`, `::`;
  - RFC 1918: `10/8`, `172.16/12`, `192.168/16`;
  - CGNAT `100.64/10`;
  - link-local `169.254/16` (including `169.254.169.254`) and `fe80::/10`;
  - ULA `fc00::/7` and site-local `fec0::/10`;
  - `192.0.0/24`, `198.18/15`, multicast, `240/4`, broadcast.

  IPv6 forms that embed an IPv4 address are judged by that IPv4 address: `::ffff:a.b.c.d`,
  `::a.b.c.d`, `64:ff9b::/96`, `2002::/16`. So are integer and octal literals, which the URL
  parser normalizes.
- **Where it is enforced:**
  1. At `httpOpen`: scheme `http(s)` only, no credentials in the URL, no `localhost` names, IP
     literals checked, and one DNS pre-check. A refusal is `403 upstream_blocked`.
  2. In the reqwest **DNS resolver**, on every connection: the first request, each redirect hop
     and each later range request. Only addresses that pass are dialled, so DNS rebinding is
     refused at connect time. The proxy session then fails with `httpStatus.error.status = 403`
     and its media URL answers `403`.
  3. In the **redirect policy**, for every `Location` (IP literals bypass DNS).
  4. Before each request to a remembered redirect target.

  Environment proxies are ignored (`no_proxy`).
- **ffmpeg never gets a user URL.** ffprobe / ffmpeg only read the server's internal loopback
  listener (`http://127.0.0.1:<random port>/i/<capability>/t|http/…`), with
  `-protocol_whitelist http,tcp` and `-format_whitelist` (self-contained containers only: no
  `hls`, `dash`, `concat` or other demuxer that opens URLs found in a file). The capability is an
  HMAC of the one source the URL reads (per-process key): a URL found inside a crafted file cannot
  reach another stream. A remote file reaches ffmpeg only through an HTTP proxy session, i.e.
  after the policy above; the proxy's `302` fallback (upstream without Range) is refused on the
  internal listener, so ffmpeg never follows it.
- **Tracker sources.** `tracker:` URLs in `sources` (`startStream`, `prewarm`, `probeStart`,
  compat `create`) pointing at a refused address (IP literal, `localhost`, or a name resolving to
  one) are dropped before the engine sees them. librqbit's tracker client resolves names again on
  its own: a tracker name that rebinds after the check is not covered (open issue).
- **`HUWA_ALLOW_PRIVATE_UPSTREAMS=1`** allows RFC 1918, CGNAT and ULA, for a media server on the
  LAN. Loopback, link-local (metadata) and the special ranges stay denied.

## 9. CORS, HTTPS, browsers

- **CORS.** tower-http `CorsLayer`:
  - origins from `HUWA_ALLOWED_ORIGINS`;
  - methods `GET, HEAD, POST, OPTIONS`;
  - request headers `Authorization, Content-Type, Range`;
  - exposed headers `Content-Range, Content-Length, Accept-Ranges, Content-Type, Retry-After,
    X-Huwa-Subs-Until, X-Huwa-Subs-Complete`;
  - `max-age` 600.

  No cookies or credentials are used: the token is a Bearer header or a path segment.
- **Private Network Access.** `Access-Control-Allow-Private-Network: true` is answered on
  preflights, so `https://huwa.mciut.fr` can call a LAN server in Chrome. The page still needs
  HTTPS on the server: mixed content blocks `http://` media from an `https://` page, except
  `localhost`.
- **HTTPS.** Behind a reverse proxy (recommended; `HUWA_TRUST_PROXY=1`), or built in with
  `HUWA_TLS_CERT` / `HUWA_TLS_KEY` (PEM, HTTP/1.1, `/api/v1/info` says `tls: true`). The server
  logs a warning when `HUWA_PUBLIC_URL` is plain `http://` (no secure context: no PWA install, no
  service worker, no WebAuthn).
- **Indexing.** Every response carries `X-Robots-Tag: noindex, nofollow` and `/robots.txt`
  disallows everything, unless `HUWA_INDEXABLE=1`.

## 10. `GET /api/v1/info`

```json
{
  "name": "huwa-server", "version": "0.1.0", "api": 1, "engine": "0.1.0+librqbit-9.0.1",
  "publicUrl": null,
  "instance": { "name": null, "operatorContact": null },
  "features": { "torrent": true, "httpProxy": true, "transcode": true, "fetchProxy": false,
                "stremioCompat": false, "p2pGateway": true, "relay": true, "seeding": false },
  "limits": { "streamsPerSession": 2, "transcodesPerSession": 1, "transcodesMax": 1,
              "proxySessionsPerSession": 8, "sessionsPerIp": 5, "cacheMaxBytes": 21474836480,
              "sessionTtlSecs": 2592000, "streamTokenTtlSecs": 21600 },
  "transcode": { "encoder": "libx264", "segmentSeconds": 4, "hls": "fmp4" },
  "session": { "identity": "optional", "proof": "ed25519" },
  "tls": false
}
```

Clients show a capability badge from `features`. They must treat a missing feature as `false`.
`engine` is `null` and `torrent` / `transcode` are `false` in the `-web` image. `transcode.encoder`
is `libx264`, `h264_vaapi`, `h264_qsv` or `h264_nvenc` (§12.6).

## 11. (moved) Stremio-compatible surface: see §13.

## 12. Media: probe, HLS, sidecars, fonts (D13, D14)

### 12.1 `POST /api/v1/media/probe`

Bearer auth. Body: one of
- `{"url": "<a media URL this session got>"}` (absolute or relative, `/s/…/t/…` or `/s/…/http/…`);
- `{"infoHash": "…", "fileIdx": 3}` (`fileIdx` optional: the engine's pick);
- `{"httpId": 12}`.

The session must hold the stream (`startStream` / `httpOpen` first), else `404`. Query: the client
capabilities (§12.2). The server runs ffprobe on the internal URL (the torrent route waits for the
metadata), reads the MKV Cues (§12.3), and registers a **media session** (`id`, reused for the
same source). Result:

```json
{
  "id": "a47ab6e1c40ad7f2d6078dc68a65bb95",
  "source": { "kind": "torrent", "infoHash": "…", "fileIdx": 0 },
  "container": "matroska,webm", "duration": 1420.5, "bitRate": 4000000, "size": 710250000,
  "video": [{ "index": 0, "kind": "video", "track": 0, "codec": "h264", "profile": "High 10",
              "pixFmt": "yuv420p10le", "bitDepth": 10, "level": 51, "width": 1920, "height": 1080,
              "frameRate": 23.976, "default": true, "forced": false }],
  "audio": [{ "index": 1, "kind": "audio", "track": 0, "codec": "flac", "channels": 2, "language": "jpn", … }],
  "subtitles": [{ "index": 3, "kind": "subtitle", "track": 0, "codec": "ass", "language": "fre",
                  "text": true, "bitmap": false,
                  "url": "/s/<m1…>/subs/<id>/0.vtt", "assUrl": "/s/<m1…>/subs/<id>/0.ass" },
                { "index": 4, "track": 1, "codec": "hdmv_pgs_subtitle", "text": false, "bitmap": true, … }],
  "attachments": [{ "index": 5, "track": 0, "codec": "ttf", "filename": "Roboto.ttf",
                    "mimetype": "application/x-truetype-font", "url": "/s/<m1…>/fonts/<id>/0" }],
  "keyframeIndex": "cues",
  "decision": { "mode": "transcode", "video": 0, "videoCodec": "h264", "audio": 1, "videoCopy": false,
                "audioCopy": false, "audioChannels": 2, "burn": null, "maxHeight": 1080,
                "reasons": ["video:h264-10bit", "audio:flac", "container:matroska", "audioTracks"] },
  "direct": "/s/<m1…t-…>/t/<infoHash>/0",
  "hls": "/s/<m1…m-…>/hls/<id>/master.m3u8",
  "fonts": "/s/<m1…m-…>/fonts/<id>"
}
```

`track` is the index among streams of the same kind (what `audioTrack`, `burnSubtitle` and the
sidecar URLs use); `index` is ffmpeg's absolute stream index. `decision` is what `master.m3u8`
would do with the same query. Errors: `502 probe_failed` (ffprobe could not read the file).

### 12.2 Client capabilities and the decision

Query parameters, Stremio-style, repeated or comma-separated, on `probe` and `master.m3u8`:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `videoCodecs` | `h264` | `h264`, `hevc` (`h265`, `hvc1`), `av1`, `vp9`, `vp8`; `h264hi10` if the browser decodes H.264 10-bit |
| `audioCodecs` | `aac,mp3` | `aac` (`mp4a`), `mp3`, `opus`, `eac3`, `ac3`, `flac`, `vorbis` |
| `maxAudioChannels` | `2` | 1–8 |
| `containers` | `mp4,webm` | containers the browser plays as plain files (`mkv` to allow MKV direct) |
| `audioTrack` | default track | audio `track` to play |
| `burnSubtitle` | none | subtitle `track` to burn in (bitmap tracks only; text tracks are sidecars) |
| `forceTranscoding` | `0` | `1`: always transcode |
| `start` | `0` | seconds: the first ffmpeg run starts at that segment (resume position) |

Decision (`decision.mode`):
- **`direct`**: supported container, video and audio codecs, at most `maxAudioChannels`, at most
  one audio track, nothing to burn. Play `direct` as a plain file. (Text subtitles never prevent
  it: they are sidecars.)
- **`remux`**: the video is copied into fMP4 HLS; the audio is copied when supported, else
  converted to AAC (`AC3`, `DTS`, `TrueHD`, `FLAC` and PCM are always converted; anything not in
  `audioCodecs` or above `maxAudioChannels` too). Needs the keyframe index (§12.3).
- **`transcode`**: H.264 High 8-bit (≤ 1080p) + AAC, for HEVC / AV1 / VP9 the browser does not
  decode, **H.264 Hi10P** and other high-bit-depth / 4:2:2 / 4:4:4 H.264 (very common in anime
  fansubs), a bitmap subtitle to burn in (PGS, VobSub), or a remux candidate without keyframe
  index (`noKeyframeIndex`).

`reasons` lists why it is not `direct`: `container:<name>`, `video:<codec>`, `video:h264-10bit`,
`audio:<codec>`, `audio:channels`, `audioTracks`, `subtitle:burn`, `noKeyframeIndex`, `forced`.
`master.m3u8` turns a `direct` decision into `remux` (or `transcode` without index): a client that
asks for HLS gets HLS.

### 12.3 HLS

```
GET /s/{token}/hls/{media}/master.m3u8?<capabilities>
GET /s/{token}/hls/{media}/{variant}/index.m3u8
GET /s/{token}/hls/{media}/{variant}/init.mp4
GET /s/{token}/hls/{media}/{variant}/{n}.m4s
```

- `master.m3u8` has one variant: `#EXT-X-STREAM-INF` with `BANDWIDTH`, `CODECS` (`avc1.64002a`
  for a transcode; the source's `avc1.PPCCLL` / `hvc1.…` for a copy; `mp4a.40.2` for AAC),
  `RESOLUTION`, `FRAME-RATE`. Its URI is relative (`{variant}/index.m3u8`): hls.js and Safari
  resolve it against the master URL, which carries the token.
- `index.m3u8`: **VOD, complete before ffmpeg runs** (`#EXT-X-PLAYLIST-TYPE:VOD`, `ENDLIST`,
  `EXT-X-MAP` → `init.mp4`, version 7, independent segments):
  - transcode: a 4 s grid (keyframes are forced on it);
  - remux: the MKV **Cues** keyframes (video track, from the SeekHead; the Cues sit in the tail the
    engine prefetches) grouped into segments of at least 4 s, each starting on a keyframe.
- Segments are fMP4 (`moof` + `mdat`), `Content-Type: video/mp4`. Their `tfdt` is the **source
  time** (ffmpeg `-copyts` + `frag_discont`), so segments from different ffmpeg runs line up.
- **Seek.** A request for a segment that is neither produced nor within 3 segments of the running
  job restarts ffmpeg there (`-ss <segment start>`, new run id). Segments already produced (older
  runs) stay served. A job more than 45 segments ahead of the latest request is paused
  (`SIGSTOP`) and resumed when the player is within 20.
- A request waits up to 30 s for its segment, then `503 segment_not_ready` (retry).
  `502 transcode_failed` when ffmpeg failed on that segment.
- **Idle.** A variant without requests for 60 s is stopped (ffmpeg killed) and its files deleted
  (`/cache/hls/<media>/<variant>`). A media session idle for 30 min, or whose session expired, is
  closed (`/cache/hls/<media>` deleted). `/cache/hls` is wiped at start.
- One live variant per media session: asking another plan (another audio track, another burn)
  stops the previous one.
- Each HLS request refreshes the source's stream slot (§7).

### 12.4 Subtitle sidecars

```
GET /s/{token}/subs/{media}/{track}.vtt?since=<seconds>
GET /s/{token}/subs/{media}/{track}.ass?since=<seconds>
```

Text tracks (SubRip, ASS/SSA, WebVTT, mov_text) are **extracted progressively** by one ffmpeg per
media session reading the internal URL from `since` (minus 5 s), all text tracks at once. Each
request answers the events known so far that **end after `since`**:
- `.vtt`: WebVTT, ASS override tags removed, `\N` → line break (for the native `<track>` or the
  `src/subtitles` overlay);
- `.ass`: the track's ASS header (styles) + the events (for libass / JASSUB).

Headers: `X-Huwa-Subs-Until: <seconds>` (how far the extraction read) and
`X-Huwa-Subs-Complete: 1` once it reached the end from the start. Clients poll with
`since` = the end of what they have (e.g. every 10 s while playing); a `since` before the run's
start or more than 120 s past its progress restarts the extraction there (a seek). Events of
earlier runs are kept and merged. The extraction stops after 5 min without a request.

### 12.5 Fonts (MKV attachments)

`GET /s/{token}/fonts/{media}` → `{"fonts": [{track, filename, mimetype, url}]}`;
`GET /s/{token}/fonts/{media}/{n}` → the attachment (`font/ttf`, `font/otf`, …, `Cache-Control:
private, max-age=86400`). Extracted once per media session with `-dump_attachment` to
server-chosen file names (the attachment's own name is never a path).

### 12.6 Hardware acceleration

`HUWA_HWACCEL=auto|none|vaapi|qsv|nvenc`. At start the server encodes a test pattern with each
candidate (`auto`: VAAPI on `/dev/dri/renderD128`, then QSV, then NVENC) and keeps the first that
works, else `libx264` (`preset veryfast`, CRF 21, capped bitrate by height). Decoding stays in
software (Hi10P, burned subtitles); frames are uploaded to the GPU for encoding. The encoder in
use is in `/api/v1/info` (`transcode.encoder`) and `/metrics` (`huwa_hwaccel`).

## 13. Stremio-compatible surface (opt-in)

`HUWA_STREMIO_COMPAT=1` mounts, **at the root and without auth**, the routes a Stremio client uses
on a streaming server, so Stremio Web can use a Huwa server as its `streamingServer`, and Huwa
Web's `StremioServerAdapter` can talk to a Huwa server the same way as to a stock Stremio server.
**Protocol compatibility only**: the shapes were read from stremio-core
(`types/streaming_server`, `models/streaming_server.rs`) and stremio-video (`withStreamingServer`);
no Stremio code (GPL) is copied.

All compat requests share **one anonymous session** (one quota bucket): `HUWA_STREMIO_COMPAT_STREAMS`
(4) stream slots, `HUWA_TRANSCODES_PER_SESSION` transcodes, and its torrents are the only ones
compat `stats` show. An operator who exposes this publicly should restrict the instance with
reverse-proxy auth (`docs/SELF_HOSTING.md` §9).

| Route | Request | Response | Notes |
| --- | --- | --- | --- |
| `GET /settings` | `Accept` without `text/html` | `{baseUrl, values: {serverVersion, appPath, cacheRoot, cacheSize, btMaxConnections, btHandshakeTimeout, btRequestTimeout, btDownloadSpeedSoftLimit, btDownloadSpeedHardLimit, btMinPeersForStable, remoteHttps: null, localAddonEnabled, transcodeProfile: null, transcodeHardwareAccel, proxyStreamsEnabled, allTranscodeProfiles}, options: []}` | a browser navigation (`Accept: text/html`) gets the web app's `/settings` page |
| `POST /settings` | partial `values` | `{success: true}` | accepted and ignored (env is the config) |
| `GET /network-info`, `/device-info`, `/casting` | | `{availableInterfaces: []}`, `{availableHardwareAccelerations: [encoder]}`, `[]` | static |
| `POST /{infoHash}/create` | `{torrent: {infoHash}, peerSearch?: {sources, min, max}, guessFileIdx?: false \| {season?, episode?}}` **or** `{blob: "<.torrent hex>"}` | Stremio stats (below) + `guessedFileIdx` | starts the torrent (sources passed through); waits up to 30 s for the metadata; `guessedFileIdx` from the episode number (season-pack matching of the mobile app) or the largest video |
| `POST /create` | `{blob}` (or the first shape) | same | |
| `GET /{infoHash}/{fileIdx}` | `?tr=<source>`, `fileIdx -1` = largest | file, `Range` → `206` | starts the torrent if needed; takes a slot of the bucket |
| `GET /{infoHash}/stats.json`, `/{infoHash}/{fileIdx}/stats.json` | | `null` or `{infoHash, name, files: [{name, path, length, offset}], downloadSpeed, uploadSpeed, downloaded, uploaded, peers, unchoked, queued, unique, connectionTries, swarmPaused, swarmConnections, swarmSize, peerSearchRunning, sources, opts, guessedFileIdx, streamLen?, streamName?, streamProgress?}` | |
| `GET /stats.json` | | `{<infoHash>: stats}` | the bucket's torrents only |
| `GET /hlsv2/probe?mediaURL=` | | `{format: {name, duration}, streams: [{id, track: video\|audio\|subtitle\|attachment, codec, channels?, frameRate?, mimeType?, filename?, language?}]}` | `mediaURL` = this server's `/{ih}/{idx}` or `/s/…` URL, or a remote `http(s)` URL opened through the HTTP proxy (IP policy, §8) |
| `GET /hlsv2/{id}/master.m3u8?mediaURL=&videoCodecs=&audioCodecs=&maxAudioChannels=&forceTranscoding=` | `id` chosen by the client | HLS master (§12.3) | variants at `/hlsv2/{id}/{variant}/index.m3u8`, `init.mp4`, `{n}.m4s` |
| `GET /hlsv2/{id}/subtitles/{track}.vtt\|.ass` | | sidecar (§12.4) | |
| `GET /subtitles.vtt?from=<url>` | | WebVTT from a remote SRT / ASS / VTT (≤ 8 MiB) | fetched under the IP policy |
| `/opensubHash`, `/proxy/…`, `/get-https`, archive routes, `/yt/…` | | `404` | not implemented (`/get-https` depends on Stremio's central certificate service) |

Paths that look like `/{a}/{b}` but are not an info hash (`/assets/x.png`, app routes) are the web
app.

## 14. Server plumbing

- **Web app.** `HUWA_WEB_DIR` (the image: `/opt/huwa/web`, an `expo export -p web` build) served at
  `/` with SPA fallback (`index.html` for unknown paths), precompressed `.br` / `.gz` when present.
  Hashed bundles (`/_expo/static/…`, `/assets/…`) are `immutable`; HTML, the service worker, the
  manifest and the config are `no-cache`. `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json` are served as JSON (no redirect).
  Legacy site (the `-web` image copies `site/` under the app, the old landing page as `get.html`;
  same rules as `site/nginx.conf`): `/.well-known/*` and `/altstore/*` are real files or `404`,
  never the app; `/addon` and `/install` answer with `extensions.html` and `/get` with
  `get.html` when those files exist (the app's routes otherwise, as on self-hosted images); an
  extensionless path with a matching `.html` file answers with it (`/privacy`, `/terms`, `/pack`,
  `/extensions`), then the SPA fallback.
- **`GET /huwa-config.json`** (generated from the environment, `no-cache`; schema `v: 1`):

  ```json
  {
    "v": 1,
    "server": { "url": "", "api": "/api/v1", "version": "0.1.0" },
    "features": { …same as /api/v1/info… },
    "p2p": { "gateway": "/p2p", "rendezvous": "/p2p/rendezvous" },
    "instance": { "name": null, "operatorContact": null, "indexable": false },
    "anilist": { "clientId": null },
    "community": { "discord": null }
  }
  ```

  `server.url` is `HUWA_PUBLIC_URL` or `""` (same origin as the page). `p2p.*` are `null` when
  `HUWA_P2P_GATEWAY=0`. `community.discord` is `HUWA_DISCORD_INVITE` (https only) or `null`: the
  web app shows its Discord invitation only when set.
- **`GET /health`** → `200 ok`. The image's HEALTHCHECK runs `huwa-server --healthcheck`.
- **`GET /metrics`** (Prometheus text): request, session, quota, probe, HLS (jobs, restarts,
  failures, segments), subtitle, compat and WebSocket counters; gauges for sessions, open
  WebSockets, HLS jobs, transcodes, encoder, torrents, download rate, cache bytes, peers, proxy
  sessions, child processes (up, restarts). No label carries a token, hash, URL or address.
  Access: `HUWA_METRICS=loopback` (default: a loopback TCP peer and no forwarding header),
  `1` (anyone), `0` (off: `404`).
- **P2P gateway.** With `HUWA_P2P_GATEWAY=1` the server starts `node <HUWA_GATEWAY_SCRIPT>
  --port <HUWA_GATEWAY_PORT> --host 127.0.0.1` (`services/huwa-gateway`, non-custodial
  dht-relay) and relays `/p2p` and `/p2p/…` to it, HTTP and WebSocket upgrades, at most
  `HUWA_MAX_WS` WebSockets (`503 too_many_connections`). The gateway gets the browser's `Origin`
  and `X-Forwarded-For` (client address) / `X-Forwarded-Proto`. `503 p2p_unavailable` when it is
  off or down. With `HUWA_RELAY=1` the server also runs the blind-peer relay
  (`services/blind-peer/server.js` + `policy.js`; storage `/data/relay`, UDP `HUWA_DHT_PORT`,
  `HUWA_RELAY_MAX_STORAGE_MB`). Children are restarted with a backoff (1 s → 60 s), get `SIGTERM`
  on shutdown (`SIGKILL` after 10 s); `SIGHUP` to the server is forwarded to them.
- **Built-in TLS:** `HUWA_TLS_CERT` / `HUWA_TLS_KEY` (§9).

### 14.1 Gateway (`services/huwa-gateway`), seen from the gateway (additions, phase 3)

- **Process.** `node services/huwa-gateway/index.js --port <p> --host 127.0.0.1` (`relay.js` is
  an alias of `index.js`, so the default `HUWA_GATEWAY_SCRIPT` keeps working). Prints one JSON
  line `{"ready":true,"port":…,"dhtPort":…}` on stdout once listening, then JSON log lines
  (`HUWA_LOG`). Exits 0 on `SIGTERM` / `SIGINT`. Optional `--lifeline`
  (`HUWA_GATEWAY_LIFELINE=1`): exit when stdin closes. Self-contained: `npm ci --omit=dev` in
  `services/huwa-gateway` installs everything, the dht-relay fork is vendored in
  `services/huwa-gateway/dht-relay/` (ISC, upstream licence kept). No blind-peer inside: the
  server's `services/blind-peer` child stays the only one.
- **Routes** (all under the `/p2p` prefix the server relays):

  | Route | |
  |---|---|
  | `GET /p2p` (WebSocket upgrade) | dht-relay, **non-custodial only**: any handshake / connect / listen / announce / unannounce carrying a secret key closes the socket (`stats.custodialRefused`) |
  | `GET /p2p/health` | `200 {ok, version, uptimeS, ws:{open,max}, dht:{host,port,firewalled,ephemeral,online}, rendezvous:{topics}, stats}`; no per-user data |
  | `POST /p2p/rendezvous/<topic>` | body = one opaque frame (≤ 8192 bytes, any content type) → `201 {n, ttlMs}`; `413` too large, `429` topic full (8 frames) or rate limit (30 POST/min per client), `503` box full, `400` bad topic |
  | `GET /p2p/rendezvous/<topic>?after=<n>&wait=<ms ≤ 30000>` | long poll → `200 {frames:[{n, data: base64}], next}` |
  | `DELETE /p2p/rendezvous/<topic>` | `204` |
  | `OPTIONS /p2p/rendezvous/<topic>` | CORS preflight (`204`) |

  `<topic>` = 64 lowercase hex characters (random, chosen by the browser; knowing it is the only
  capability). Frames expire 2 minutes after they were posted (`HUWA_RENDEZVOUS_TTL_MS`). The
  gateway never sees anything but ciphertext there (the QR link of src/p2p/link-web.ts).
- **Headers it relies on.** `Origin` (checked against `HUWA_ALLOWED_ORIGINS`, default
  `self,https://huwa.mciut.fr`; `self` = `HUWA_PUBLIC_URL`'s origin, else the request's
  `X-Forwarded-Host`/`Host`; `*` = any; no `Origin` = not a browser, allowed: `403` on WS and
  rendezvous otherwise, CORS headers only for allowed origins). `X-Forwarded-For`: the gateway
  takes the **right-most** entry, and only when the TCP peer is loopback, as the client address
  (per-IP limits). `X-Forwarded-Proto` for `self`.
- **Limits** (environment; the server's own `HUWA_MAX_WS` cap stays in front):
  `HUWA_MAX_WS` (200, `503`), `HUWA_WS_PER_IP` (8 WebSockets per client, `429`),
  `HUWA_WS_BYTES_PER_SEC` (2 MiB/s per WebSocket, both directions, token bucket),
  `HUWA_WS_IDLE_MS` (90 s without any frame from the client: the relay pings every 15 s, so this
  only closes dead or frozen tabs), `HUWA_WS_MAX_PEERS` (64 relayed peer streams per WebSocket),
  `HUWA_WS_MAX_QUERIES` (32 concurrent DHT queries per WebSocket); mutable records 60/min per
  WebSocket, ≤ 1000 bytes. `HUWA_RENDEZVOUS_MAX_TOPICS` (4096).
- **DHT.** One long-lived HyperDHT node per gateway. Its UDP port is `HUWA_GATEWAY_DHT_PORT`
  (default `0` = random), **not** `HUWA_DHT_PORT`, which the blind-peer relay binds. Forwarding a
  fixed `HUWA_GATEWAY_DHT_PORT` makes the node reachable (fewer holepunches for browsers), but
  it works firewalled. `HUWA_BOOTSTRAP` as for the rest of the server.
- **Never in production:** `--audit <dir>` / `HUWA_GATEWAY_AUDIT_DIR` (keeps inbound bytes and
  adds heap-snapshot routes, for tests) and `--testnet N`, `--static <dir>`.

## 15. Decisions on the phase 0 open questions

1. **Single focus → per-session focus.** The engine keeps one focus per owner; each browser
   session is an owner (`Engine::start_stream_for`). A session's `startStream` backgrounds only
   torrents nobody focuses any more; another session's playback keeps its whole-file download and
   read-ahead. A session that expires drops its focus. (The mobile app has one owner: unchanged.)
2. **Proxy limits** are server settings: `HUWA_PROXY_SESSIONS`, `HUWA_PROXY_READAHEAD_MB`, plus a
   per-session cap `HUWA_PROXY_SESSIONS_PER_SESSION`.
3. **Proxy streams count against the stream quota** (slot `http:<id>`, taken by the media
   request, not by `httpOpen`: a source race can still open several candidates).
4. **Absolute or relative URLs.** Unchanged: absolute when `HUWA_PUBLIC_URL` is set. Clients
   resolve against the server base either way.
5. **Token in the path.** Media responses send `Referrer-Policy: no-referrer`; media URLs carry
   short-lived per-stream tokens (§6).
6. **Session creation limits.** `HUWA_SESSIONS_PER_IP` (with `HUWA_TRUST_PROXY`) and
   `HUWA_MAX_SESSIONS` are enforced; the optional Ed25519 proof is checked (§3).
7. **Stremio compat mount point.** At the root, opt-in, one shared anonymous quota bucket (§13).
