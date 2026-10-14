# Huwa Server API (`/api/v1`)

Status: **draft, frozen for phase 0** (spike S3 of `docs/WEB_DOCKER_PLAN.md`, decisions D9–D13).
Implementation: `native/huwa-server` (Rust/axum) on top of `native/huwa-torrent-core` with the
`server` cargo feature. Consumers: `modules/huwa-torrent/index.web.ts` (thin HTTP transport, agent C),
web player and source resolver (agent B), packaging (agent E).

Anything marked **(planned)** is not implemented by the spike. Clients must ignore unknown JSON
fields: fields will be added without bumping the API version. Removing or renaming a field, or
changing a meaning, bumps `api` (and the path to `/api/v2`).

## 1. Overview

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness, `200 ok` (text) |
| `GET /api/v1/info` | none | version, features, limits |
| `POST /api/v1/session` | none | create a per-browser session → token |
| `POST /api/v1/engine/{method}` | `Authorization: Bearer <token>` | torrent engine and HTTP proxy calls (mirror of `api.rs`) |
| `GET /s/{token}/t/{infoHash}/{file}` | token in path | torrent file stream, `Range` → `206` |
| `GET /s/{token}/http/{id}[.{ext}]` | token in path | read-ahead proxy stream of a remote HTTP(S) file |
| `/s/{token}/hls/…`, `/s/{token}/subs/…`, `/api/v1/fetch`, `/p2p` | | **(planned)** transcode, sidecars, fetch bridge, P2P gateway |

One TCP port (`HUWA_PORT`, 8080). Media routes accept `GET` and `HEAD`. Everything else is `404`
with the error envelope.

## 2. Configuration (environment)

Implemented by the spike (the full list is in the plan, §5):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUWA_PORT` | `8080` | listen port |
| `HUWA_BIND` | `0.0.0.0` | listen address *(addition to the plan)* |
| `HUWA_PUBLIC_URL` | unset | `https://huwa.example.org`. When set, media URLs returned by the API are absolute (`{publicUrl}/s/…`); otherwise they are server-relative (`/s/…`). |
| `HUWA_ALLOWED_ORIGINS` | `self,https://huwa.mciut.fr` | CORS allowlist, comma-separated origins; `self` = origin of `HUWA_PUBLIC_URL`; `*` = any |
| `HUWA_CACHE_DIR` | `/cache` | torrent data and engine state (`<dir>/engine`) *(addition)* |
| `HUWA_DATA_DIR` | `/data` | persistent state: `token.key` *(addition)* |
| `HUWA_CACHE_MAX_GB` | `20` | torrent cache quota; least-recently-used idle torrents are evicted |
| `HUWA_STREAMS_PER_SESSION` | `2` | stream slots per session (`0` = unlimited), see §7 |
| `HUWA_ALLOW_PRIVATE_UPSTREAMS` | `0` | let the HTTP proxy reach RFC 1918 / CGNAT / ULA hosts (§8) |
| `HUWA_SESSION_TTL_DAYS` | `30` | token lifetime *(addition)* |
| `HUWA_WORKER_THREADS` | CPU count (≥ 2) | engine runtime size *(addition)* |
| `HUWA_LOG` | `info` | `tracing` filter, e.g. `info,huwa_torrent_core=debug` |

Booleans accept `1/0`, `true/false`, `yes/no`, `on/off`.

BitTorrent upload is **compiled out** (`disable-upload`) and never enabled. `/api/v1/info` reports
`features.seeding: false`, and `setConfig {seeding}` is not available to sessions.

## 3. Sessions and tokens

`POST /api/v1/session`, body `{}` (optional). The spike accepts the planned D11 fields
`{publicKey, ts, sig}` but does not check them yet; the response shape will not change when it does.

```http
POST /api/v1/session
→ 201 Created
{
  "token": "v1.<sid>.<exp>.<mac>",
  "sessionId": "<sid>",
  "expiresAt": 1794582668,
  "mediaBase": "/s/v1.<sid>.<exp>.<mac>",
  "limits": { "streams": 2 }
}
```

- **Format.** `v1.<sid>.<exp>.<mac>`:
  - `sid` is 16 random bytes as lower-case hex;
  - `exp` is the expiry in Unix seconds;
  - `mac` is HMAC-SHA256(server key, `huwa/session/v1|<sid>|<exp>`) as hex.

  The token is opaque to clients: store it, don't parse it.
- **Capability.** Whoever holds the token is the session. API calls send it as
  `Authorization: Bearer <token>`. Media URLs carry it in the path (`/s/<token>/…`), because players
  (`<video>`, hls.js, VLC, mpv) cannot send headers. Never log full media URLs, and never put
  tokens in query strings.
- **Validation.** The server checks the format, then the MAC in constant time, then the expiry.
  The key lives in `HUWA_DATA_DIR/token.key` (created at first start, mode 0600). Without a usable
  data dir, the key is random per process and tokens die with a restart.
- **State.** The server keeps in memory the torrents held, the stream slots, the proxy sessions and
  the probes. A valid token that the process does not know (after a restart) gets a fresh, empty
  state. Clients must cope with `list` becoming empty: start the stream again.
- **Expiry.** An expired token returns `401 session_expired`. Create a new session.
- **Multiple tokens.** One browser profile should keep one token. Several sessions from one
  browser are not linked to each other.
- **(planned) Identity.** The body will carry an Ed25519 public key from the browser, signing
  `ts`. `HUWA_REQUIRE_IDENTITY` will bind tokens to a Huwa identity. `HUWA_MAX_SESSIONS` and
  `HUWA_SESSIONS_PER_IP` are not enforced yet.

## 4. Envelopes

- **Success.** `2xx` with the method's JSON result as the whole body. There is no `{ok: …}`
  wrapper. Responses are `Cache-Control: no-store`.
- **Error.** Non-`2xx` with `{"error": "<human message>", "code": "<machine code>", …extra}`.
  The `error` string is the same field that `api::envelope` returns on mobile, so a transport can
  map both the same way.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | invalid JSON or non-object body, missing or invalid `infoHash` / `id` / `ids` |
| 400 | `engine_error` | the engine refused the call (message from the engine) |
| 401 | `unauthorized` | missing, malformed or forged token (`WWW-Authenticate: Bearer`) |
| 401 | `session_expired` | token past `expiresAt` |
| 403 | `forbidden_method` | operator-only engine method (§5) |
| 403 | `upstream_blocked` | HTTP proxy upstream refused by the IP policy (§8) |
| 404 | `not_found` | unknown route, or a torrent / probe / proxy session that this session does not hold. The server never reveals whether another session holds it. |
| 404 | `unknown_method` | not an engine method |
| 429 | `quota_exceeded` | stream slots exhausted. Extra field `limit`, header `Retry-After: 10` |
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
| `startStream` | `{infoHash, fileIdx?, sources?, name?, metered?}` | `{id, url, infoHash}` | Takes a stream slot (§7; `429` when full). The session now holds the torrent, which is deduplicated by info hash across sessions. `sources` are Stremio-style (`tracker:<url>`, `dht:<ih>`). |
| `prewarm` | same as `startStream` | same | Holds the torrent without taking a slot. Fetches the head and the container index, then parks. |
| `status` | `{id}` (or `{infoHash}`) | `TorrentStatus` | `404` unless held |
| `list` | `{}` | `TorrentStatus[]` | only the torrents held by this session |
| `stats` | `{}` | `EngineStats` | `torrents` filtered to this session; `port` is `0`; cache figures are global |
| `pause` / `resume` | `{id}` | `true` | `404` unless held. `pause` is a no-op while another session holds the torrent. |
| `release` | `{id, at?}` | `true`/`false` | Frees the slot. Parks the torrent only if this session is its last holder. |
| `remove` | `{id}` | `true` | Frees the slot and drops this session's hold. The last holder deletes the torrent and its data. |
| `probeStart` | `{infoHash, sources?, name?, fileIdx?, filename?, episode?, timeoutMs?, minPeers?}` | `ProbeStatus` | the probe id is recorded for this session |
| `probeStatus` | `{id}` → `ProbeStatus`; `{ids}` → `ProbeStatus[]` | | ids not owned: `404` for `{id}`; left out for `{ids}` |
| `probeCancel` | `{id}` or `{ids}` | `true` | owned ids only |
| `httpOpen` | `{url, headers?, prefetch?: {startAt?, duration?, readAhead?, target?, size?, container?}}` | `{id, url, reused}` or `{fallback: "noRange"\|"unsupported", reused}` | Upstream checked by the IP policy (`403 upstream_blocked`). Proxy sessions are deduplicated by URL and headers; each `httpOpen` takes one reference for this session. |
| `httpPrefetch` | `{id, startAt?, duration?, readAhead?, target?}` | `true` | owned ids only |
| `httpStatus` | `{id}` | `HttpStatus` | owned ids only |
| `httpRelease` | `{id}` | `true` | drops one of this session's references |
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

## 6. Media URLs

The engine and the proxy build `/t/{infoHash}/{file}` and `/http/{id}[.{ext}]`. The server rewrites
every `url` field of a result into the session's media URL:

```
{publicUrl?}/s/{token}/t/{infoHash}/{fileIdx|auto}[.{ext}]
{publicUrl?}/s/{token}/http/{id}[.{ext}]
```

- Clients always resolve them against the server base (`new URL(url, serverBase)`). This works for
  both the relative and the absolute form.
- `{file}` is the index of the file in the torrent, or `auto` (the largest video). The extension is
  a hint for the player. The server ignores it.
- Torrent streams: `Accept-Ranges: bytes`, `Range` → `206` with `Content-Range`, `416` when
  unsatisfiable, `Content-Type` from the extension (`video/x-matroska`, `video/mp4`, …), and
  `Cache-Control: no-store`. A cold request waits for the metadata, up to 90 s, then answers `504`.
- Proxy streams: same Range semantics. The server answers `302` to the original URL when the
  upstream ignores Range, and `403` when the upstream is refused by the policy.
- A media request for a torrent or proxy session that the token does not hold returns `404`.
  A forged or expired token returns `401`.

## 7. Quotas

- **Stream slots.** A session has `HUWA_STREAMS_PER_SESSION` slots (2), one per distinct info hash.
  - A slot is taken by `startStream`, or by a media request on a held torrent that has no slot.
  - A slot is refreshed by every media request; it stays busy while a response body is open.
  - A slot is freed by `release` or `remove`, or after 120 s with no open response and no request.
  - A third distinct stream returns `429 quota_exceeded` with `{"limit": 2}`. The refused torrent
    is not registered for the session.
  - Re-starting a held stream, `prewarm`, `probe*` and `http*` take no slot.
- **Deduplication.** One engine torrent per info hash, whatever the number of sessions. A
  per-hash holder count decides who may `pause` / `release` / delete it (the last holder).
- **Cache.** `HUWA_CACHE_MAX_GB` is a global LRU over idle torrents. A janitor drops expired
  sessions every 60 s and parks torrents nobody holds any more.
- **Proxy.** At most 6 live proxy sessions server-wide, with 48 MiB of read-ahead each. This is
  the engine's mobile constant: see the open questions.
- **(planned)** `HUWA_MAX_SESSIONS`, `HUWA_SESSIONS_PER_IP`, transcode quotas (`HUWA_TRANSCODES_*`),
  `HUWA_DOWNLOAD_LIMIT_MBPS`.

## 8. Upstream IP policy (HTTP proxy)

The policy is enforced in `native/huwa-torrent-core/src/net_policy.rs` (feature `server`).

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
- **`HUWA_ALLOW_PRIVATE_UPSTREAMS=1`** allows RFC 1918, CGNAT and ULA, for a media server on the
  LAN. Loopback, link-local (metadata) and the special ranges stay denied.

## 9. CORS, HTTPS, browsers

- **CORS.** tower-http `CorsLayer`:
  - origins from `HUWA_ALLOWED_ORIGINS`;
  - methods `GET, HEAD, POST, OPTIONS`;
  - request headers `Authorization, Content-Type, Range`;
  - exposed headers `Content-Range, Content-Length, Accept-Ranges, Content-Type, Retry-After`;
  - `max-age` 600.

  No cookies or credentials are used: the token is a Bearer header or a path segment.
- **Private Network Access.** `Access-Control-Allow-Private-Network: true` is answered on
  preflights, so `https://huwa.mciut.fr` can call a LAN server in Chrome. The page still needs
  HTTPS on the server: mixed content blocks `http://` media from an `https://` page, except
  `localhost`.
- **(planned)** `HUWA_TRUST_PROXY` (`X-Forwarded-*`), built-in TLS (`HUWA_TLS_CERT/KEY`), and a
  plain-http warning in `/api/v1/info`.

## 10. `GET /api/v1/info`

```json
{
  "name": "huwa-server", "version": "0.1.0", "api": 1, "engine": "0.1.0+librqbit-9.0.1",
  "publicUrl": null,
  "features": { "torrent": true, "httpProxy": true, "transcode": false, "fetchProxy": false,
                "stremioCompat": false, "p2pGateway": false, "seeding": false },
  "limits": { "streamsPerSession": 2, "cacheMaxBytes": 21474836480, "sessionTtlSecs": 2592000 },
  "session": { "identity": "none" }
}
```

Clients show a capability badge from `features`. They must treat a missing feature as `false`.

## 11. Stremio-compatible surface (opt-in, **not implemented**)

Planned behind `HUWA_STREMIO_COMPAT=1` (D10), so Stremio Web can use a Huwa server and Huwa Web's
`StremioServerAdapter` can use a stock Stremio server. The surface is **protocol compatibility
only**: no Stremio code (GPL) is copied. The request shapes below were read from stremio-core
(`src/types/streaming_server/request.rs`, `src/models/streaming_server.rs`, `src/types/streaming_server/*`)
and stremio-video (`src/withStreamingServer/*.js`).

Stremio clients send no auth. A compat server is therefore either unauthenticated (localhost or
LAN only), or mounted under a token prefix (`/s/{token}/stremio/…`) given to Stremio Web as its
`streamingServer` URL. The prefix is the recommended choice; it is to be decided in P2.

| Route | Request | Response (fields clients read) | Huwa mapping |
| --- | --- | --- | --- |
| `GET /settings` | | `{baseUrl, values: {serverVersion, appPath, cacheRoot, cacheSize\|null, btMaxConnections, btHandshakeTimeout, btRequestTimeout, btDownloadSpeedSoftLimit, btDownloadSpeedHardLimit, btMinPeersForStable, remoteHttps\|null, transcodeProfile\|null, proxyStreamsEnabled}, options: [{id, label, selections?: [{name, val}]}]}` | Static values from env. `cacheSize` = `HUWA_CACHE_MAX_GB`. |
| `POST /settings` | partial `values` object (e.g. `{cacheRoot}` only) | `{success: true}` | Accepted and ignored (operator config comes from env). |
| `POST /{infoHash}/create` | `{torrent?: {infoHash}, peerSearch?: {sources: ["dht:<ih>", "tracker:<url>"], min, max}, guessFileIdx?: false \| {season?, episode?}}` | Any JSON; stremio-video reads `guessedFileIdx` | `startStream` (sources passed through). `guessedFileIdx` = the engine's selected file, using `episode` (probe `episode` matching). |
| `POST /create` | `{blob: "<hex .torrent>"}` | any JSON | add from torrent bytes |
| `GET /{infoHash}/{fileIdx}` | optional `?tr=<source>`, `&f=<fileMustInclude>`; `fileIdx = -1` = largest file | file with Range / 206 | `/t/{ih}/{idx\|auto}` |
| `GET /{infoHash}/{fileIdx}/stats.json`, `/{infoHash}/stats.json` | | `null` or `{name, infoHash, files: [{name, path, length, offset}], downloadSpeed, uploadSpeed, downloaded, uploaded, peers, unchoked, queued, unique, connectionTries, swarmPaused, swarmConnections, swarmSize, peerSearchRunning, streamLen?, streamName?, streamProgress?, sources: [...], opts: {...}, guessedFileIdx?}` | from `TorrentStatus` |
| `GET /stats.json` | | global stats (shape not in the public clients) | from `EngineStats` |
| `GET /hlsv2/probe?mediaURL=<url>` | | `{format: {name, duration}, streams: [{id, track: video\|audio\|subtitle\|attachment, codec, channels?, frameRate?, mimeType?, filename?}]}` | ffprobe (P2 media module); `mediaURL` must be a Huwa media URL or pass the upstream policy |
| `GET /hlsv2/{id}/master.m3u8` | `?mediaURL=&videoCodecs=<repeated>&audioCodecs=<repeated>&maxAudioChannels=&forceTranscoding=1?`; `id` = random per load | HLS master playlist (`application/vnd.apple.mpegurl`) | D13 HLS manager. Related routes: `/hlsv2/{id}/source/subtitle/{streamId}.ass`, `/hlsv2/{id}/source/attachment/{streamId}` (fonts) |
| `GET /subtitles.vtt?from=<url>` | | WebVTT | sidecar conversion |
| `GET /opensubHash?videoUrl=<url>` | | `{result: {hash, size}}` or `{error}` | optional |
| `GET /network-info`, `/device-info`, `/casting` | | `{availableInterfaces: []}`, `{availableHardwareAccelerations: []}`, `[]` | static |
| `/proxy/d=<origin>&h=<k:v>/<path>`, `/get-https`, `/rar\|zip\|7zip\|tgz\|tar\|nzb/create`, `/yt/{id}` | | | not planned (`/get-https` depends on Stremio's central certificate service) |

Stremio-video's direct-play rule, for reference: it plays the file as is only when all of these hold:
- the container is supported;
- every audio track has a supported codec and at most `maxAudioChannels` channels;
- every video codec is supported;
- there are no embedded subtitle streams;
- there are fewer than two audio tracks.

Otherwise it uses `/hlsv2/{id}/master.m3u8`. Huwa's own transcode decision (D13) is server-side and
uses the client's MediaCapabilities.

## 12. Open questions

1. **Single focus.** The engine has one "focus" torrent: the latest `startStream`, which parks
   the others once their player leaves. That is right for one phone, wrong for N sessions:
   session B's start backgrounds session A's playback. A's open responses keep reading, but the
   whole-file download and the read-ahead selection move to B. The fix is per-session focus, or
   focus = the set of torrents with an open stream slot. This touches `engine.rs` and
   `streaming.rs` (P2).
2. **Proxy limits.** The proxy limits (`MAX_SESSIONS = 6`, 48 MiB per session) are mobile
   constants and process-wide, so the 7th user's `httpOpen` evicts someone's idle session.
   Should they be server options (`HUWA_PROXY_SESSIONS`) with a per-session cap?
3. **Proxy streams and the quota.** Should proxy streams count against `HUWA_STREAMS_PER_SESSION`?
   A web source race opens several candidates at once, so the spike counts only torrents.
4. **Absolute or relative URLs.** Are absolute media URLs (when `HUWA_PUBLIC_URL` is set) what
   web clients want, or always relative plus `mediaBase`?
5. **Token in the path.** Token-in-path media URLs leak through `Referer` and logs. Should the
   media routes send `Referrer-Policy: no-referrer`, and should there be short-lived per-stream
   tokens (`/s/<stream-token>/…`) separate from the API token?
6. **Session creation limits.** With D11 identity checks still pending, `POST /session` is
   unauthenticated and unlimited. `HUWA_SESSIONS_PER_IP` needs `HUWA_TRUST_PROXY` to see the
   client IP behind Traefik or Caddy.
7. **Stremio compat mount point.** Unauthenticated at the root, or under a token prefix?
