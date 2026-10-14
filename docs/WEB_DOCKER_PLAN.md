# Huwa Web + self-hosted Huwa Server — implementation plan

Model: Stremio Web (`app.strem.io/shell-v4.4/?streamingServer=…`) + the Stremio streaming server, adapted to Huwa's P2P accounts. Owner decisions (2026-10-14):

- One Docker image that anyone can deploy: web app (installable PWA) + remote torrent decoder/streaming server + transcoding + a P2P node that helps the network.
- No built-in password: multi-user by default, **one account per browser** (logging in on one browser never logs in the next visitor). Deployers may add reverse-proxy auth.
- huwa.mciut.fr is redone like Stremio Web: catalog browsable when logged out (nothing playable), login syncs the account and its extensions/addons.
- huwa.mciut.fr never runs a torrent engine for the public.

## 0. Findings

Stremio:
- stremio-web (GPL-2.0) = React UI + stremio-core (Rust→WASM) in a Worker; login → `authKey` at api.strem.io; addon/library sync via `addonCollectionGet/Set`, `datastoreGet/Put`.
- Streaming server API: `GET/POST settings`; `POST {infoHash}/create` (peerSearch `tracker:`/`dht:`), `POST /create {blob}`; `GET {infoHash}/{fileIdx}`; `.../stats.json`; `network-info`, `device-info`, `casting`; `GET /get-https?authKey=&ipAddress=`.
- Transcoding (stremio-video): `GET /hlsv2/probe?mediaURL=`; direct play only when container/codecs allowed, no embedded subs, <2 audio tracks; else `/hlsv2/<id>/master.m3u8?mediaURL=…&videoCodecs=…&audioCodecs=…&maxAudioChannels=…` via hls.js / Safari native.
- HTTPS: localhost exempt from mixed content; LAN/remote uses a central `*.stremio.rocks` cert service — Huwa will not do that (would make Huwa a central party).

Huwa:
- Every `modules/*/index.ts` uses `requireOptionalNativeModule` → null on web.
- `native/huwa-torrent-core/src/api.rs` is already a JSON `call(method,args)` dispatcher; `server.rs`/`http_proxy.rs` are axum routers bound to `127.0.0.1:0`; `engine.rs` hard-codes `http://127.0.0.1:{port}`; `http_proxy.rs` blocks only loopback upstreams (no RFC1918 / metadata guard — insufficient on a server); seeding compiled out (`disable-upload`).
- Corestore 7 → hypercore-storage → `rocksdb-native` (no browser backend); hypercore-storage accepts an injected DB. `hyperdht/browser.js` throws. Hypercore signs in-process with the secret key ⇒ **a server-side node per user would hold users' private keys — forbidden**. The node must run in the browser.
- Addons/extensions are AsyncStorage keys (`huwa/addons/v1`, `huwa/pb/registry/v1`), not synced; the home base is publicly readable ⇒ synced addon URLs (debrid keys) must be encrypted. Account-wide `boxSeed` exists (rotated on device revocation).
- `src/app/_layout.tsx` shows Onboarding until `onboarded`; routes behind `Stack.Protected guard={!!me}`; tabs use `NativeTabs`.
- `src/p2p/index.ts` web → `local` backend; `secure.ts` web → AsyncStorage (dev only); downloads & Paperback disabled on web; `app.json` `web.output: "static"`.
- Paperback: hidden WebView + srcdoc iframes; `net.ts` takes an injected `RawFetch`.
- Passkeys: `RP_ID = 'huwa.mciut.fr'` (largeBlob + PRF).

## 1. Architecture

```
BROWSER / PWA (one account per browser profile; keys never leave it)
  Expo Router app via react-native-web (expo export -p web, output "single")
  *.web.tsx shells: Stremio-like left rail (Board/Anime/Manhwa/Library/Calendar/Addons/Settings)
  Player.web: <video> + hls.js | Safari native HLS + existing subtitle overlay (JASSUB opt-in)
  Paperback host: hidden <iframe sandbox="allow-scripts" srcdoc> + postMessage
  P2P client ({m,a} RPC like src/p2p/bare.ts) ──► SharedWorker "huwa-node" (HuwaNode unchanged)
      storage: rocksdb-idb (IndexedDB)   secrets: IndexedDB wrapped by non-extractable WebCrypto key
      DHT: @hyperswarm/dht-relay client, NON-custodial, WebSocket ──► instance /p2p
  Server client: HuwaServerAdapter | StremioServerAdapter ──► HTTPS (CORS)

huwa.mciut.fr = image huwa:<v>-web (web app + P2P gateway + legacy pages; NO engine/ffmpeg/fetch proxy)

User's server = image huwa:<v> (one TCP port 8080, optional UDP 49737)
  tini → huwa-server (Rust/axum; supervises Node child)
    /                    static web build (SPA), /huwa-config.json (from env)
    /api/v1/info|session capabilities, per-browser session tokens
    /api/v1/engine/{m}   JSON dispatch = api.rs
    /s/<tok>/t/<ih>/<f>  torrent Range stream
    /s/<tok>/http/<id>   read-ahead proxy (SSRF-guarded)
    /s/<tok>/hls/<sid>/… ffprobe → direct | remux | transcode → fMP4 HLS
    /s/<tok>/subs|fonts  ASS/SRT/WebVTT sidecars, MKV fonts
    /api/v1/fetch        CORS bridge for Paperback/debrid (net.ts policy, server side)
    Stremio-compat (opt-in): /settings /stats.json /{ih}/create /{ih}/{idx} /hlsv2/probe /hlsv2/{id}/master.m3u8
    /p2p (WS) ─► huwa-gateway (Node 22): dht-relay WS (non-custodial) · HyperDHT node · blind-peer (policy.js) · /p2p/rendezvous (QR "Link a browser")
  ffmpeg/ffprobe (jellyfin-ffmpeg; VAAPI/QSV/NVENC optional)
  /data persistent · /cache disposable

Phone app adds: "Link a browser" (scan web QR), encrypted vault publish, optional own relay key.
```

## 2. Decisions

| # | Decision |
|---|---|
| D1 | One Expo codebase, `expo export -p web`, `*.web.ts(x)` + Metro web aliases; `web.output: "single"`. |
| D2 | Full Huwa node in the browser (SharedWorker, existing `HuwaNode`), keys in IndexedDB. Docker only relays. Never custodial. |
| D3 | `@hyperswarm/dht-relay` non-custodial over WS to `/p2p` (pin/fork). Gated by spike S2. |
| D3-F | Fallback: "linked session lite" — local web profile + phone pushes a sealed vault snapshot via `/p2p/rendezvous`; no comments/DMs on web. |
| D4 | New package `rocksdb-idb`: subset of rocksdb-native used by hypercore-storage (sessions, batches, ordered/reverse iterators, snapshots, column family) over in-memory sorted map + IndexedDB WAL. |
| D5 | SharedWorker; fallback leader election via `navigator.locks` + BroadcastChannel. |
| D6 | Web secrets in IndexedDB encrypted with a non-extractable AES-GCM key; optional "Lock with passkey" (PRF); "Public computer" mode = memory/sessionStorage; logout = signed `remove-device` + wipe. |
| D7 | Login: QR "Link a browser" (web shows QR, phone scans, phone runs `pairingInvite()`, invite sealed via rendezvous, web `acceptPairing`); recovery phrase (not persisted); passkey (D8); "create account in this browser". |
| D8 | Passkeys bound to huwa.mciut.fr work only there; self-hosted domains: per-instance passkey, or QR/phrase. |
| D9 | Rust `huwa-server` front door supervising Node 22 `huwa-gateway` on loopback; tini PID 1; one TCP port. |
| D10 | Native `/api/v1` mirrors `api.rs` (so `modules/huwa-torrent/index.web.ts` is a thin HTTP transport); capability token in media URL paths (`/s/<tok>/…`); opt-in Stremio-compat surface (`HUWA_STREMIO_COMPAT=1`); web client has Huwa + Stremio adapters. Protocol compatibility only, no GPL code copied. |
| D11 | Per-browser sessions: `POST /api/v1/session` with a browser Ed25519 key signing a timestamp → HMAC token (30 d). Quotas: 2 streams/session, 1 transcode/session, global transcode cap, sessions per IP, global cache LRU; `list`/`status` filtered per session; torrents deduped by infohash with refcount. Optional identity-bound tokens later (`HUWA_REQUIRE_IDENTITY`). |
| D12 | HTTPS: use the instance's own origin behind Coolify/Traefik/Caddy TLS; `HUWA_TRUST_PROXY`; huwa.mciut.fr → user server requires https + CORS allowlist; optional built-in TLS; no central cert service; warn on plain-http (no SW/PWA/WebAuthn). |
| D13 | Transcode: jellyfin-ffmpeg; decide from ffprobe + client MediaCapabilities: direct / remux (AAC for AC3/DTS/TrueHD/FLAC) / transcode (HEVC/AV1/VP9 unsupported, **Hi10P**, bitmap subs). fMP4 HLS 4 s, VOD playlist up front, seek = restart at segment; copy-mode keyframes from MKV Cues (tail already prefetched). **ffmpeg never gets a user URL** — only internal loopback `/t/…` or `/http/…`, `-protocol_whitelist http,tcp`. |
| D14 | Subtitles: text tracks extracted progressively as sidecars (`?since=`), fed to existing `src/subtitles` overlay; JASSUB opt-in; bitmap subs burned in. |
| D15 | huwa.mciut.fr = `ghcr.io/amintt2/huwa:<v>-web` (no engine/ffmpeg/fetch proxy) + legacy pages (`/privacy`, `/terms`, AltStore JSON, `.well-known` AASA rules); landing → `/get`. |
| D16 | Logged out: AniList catalog, detail, episodes, search, calendar; "Sign in to play". Logged in: vault sync, addons, playback (direct HTTP/debrid, or configured streaming server for torrents/transcode). Server media routes need a session token. |
| D17 | Encrypted vault op in the home base: `{v, box, coll, ts, n, ct}`, XChaCha20-Poly1305, key = HKDF(boxSeed, "huwa/vault/v1/"+coll); collections `addons`, `pbRepos`, `lists`, `progress`, `prefs`, `debrid` (opt-in); LWW per item; chunked; re-encrypted on box rotation. |
| D18 | Docker = P2P node: HyperDHT node, blind-peer relay (existing `policy.js`, default 2 GB), dht-relay for browsers. No BitTorrent seeding (compile-time). |
| D19 | PWA: manifest + Workbox injectManifest SW (shell, assets, posters LRU), update prompt, `navigator.storage.persist()`, IndexedDB AsyncStorage shim (localStorage is ~5 MB). |
| D20 | Multi-arch amd64/arm64, Rust on native arm64 runners, GHCR tags `<v>`, `<v>-web`, `latest`, `sha-…`; SBOM, Trivy, smoke test with legal test media. |

## 3. Native module inventory → web

| Native | Web |
|---|---|
| huwa-mpv | stub (unavailable); formats handled by server remux/transcode |
| huwa-torrent (+ http proxy) | `index.web.ts`: `call(m,a)` → `POST /api/v1/engine/m`; events via polling/SSE; URLs joined with server base |
| huwa-transcode, huwa-hls | stub (no downloads on web) |
| huwa-cookies | stub; cookie jars in net.ts persisted in IndexedDB |
| huwa-translate | Chrome built-in Translator API when present |
| huwa-netpath | `navigator.connection` |
| huwa-keychain, expo-secure-store | IndexedDB secret store (D6); cloud backup off |
| huwa-passkey | WebAuthn adapter (same contract), `RP_ID = location.hostname` on web |
| Bare worklet | `src/p2p/web/` client + SharedWorker bundle (esbuild) with injected storage/swarm; `bare.web.ts` stub |
| expo-notifications | off v1 (Web Push later) |
| Paperback WebView host | `PaperbackHost.web.tsx` iframe + `/api/v1/fetch` transport |
| WebPlayer / YouTube / Cloudflare sheet | sandboxed iframe / YouTube IFrame API / unsupported message |
| expo-video | `hybrid-player.web.ts` + `EngineView.web.tsx` on `<video>`, hls.js lazy, PiP, Media Session |
| file system / downloads | off; backup export/import via Blob/file input |
| AsyncStorage | Metro alias → IndexedDB shim |
| expo-camera QR | getUserMedia + BarcodeDetector/jsQR |
| orientation/brightness/haptics/keep-awake | no-op / Fullscreen / Wake Lock |
| expo-updates / APK check | off; SW update prompt |
| NativeTabs, glass, formSheet | `(tabs)/_layout.web.tsx` (left rail ≥768 px, bottom bar on phones), CSS, modals |

## 4. Phases

**P0 — spikes & seams (1–1.5 wk, gate)**
- S1 web build: `expo export -p web` (`output: "single"`), list failures, Metro web aliases (AsyncStorage→idb shim, bare-kit→stub).
- S2 browser P2P harness: Corestore/Autobase on `rocksdb-idb` in a Worker; `@hyperswarm/dht-relay` non-custodial vs hyperdht 6.x — browser ↔ mobile peer replicate home base + `acceptPairing`; PoW speed. Go/no-go D3 vs D3-F.
- S3 server engine: `server` cargo feature (base URL abstraction, configurable bind, upstream IP policy in a custom DNS resolver), minimal `native/huwa-server` serving `/api/v1/engine/*` + `/s/<tok>/t/…`, linux amd64/arm64.
- S4 passkeys on web (Safari 18, Chrome macOS/Android, hybrid): iOS-created largeBlob readable? PRF?
- Seams PR first: `HuwaNode` accepts injected storage + `swarmFactory`; specs frozen: `docs/server-api.md`, `/huwa-config.json`, vault schema, rendezvous protocol.
- Acceptance: web export boots; S2 syncs a comment iOS↔browser via local relay; curl streams 206 from local seeder; proxy refuses 10.0.0.1 and 169.254.169.254.

**P1 — public web app, logged-out catalog, PWA on huwa.mciut.fr (2–3 wk)**
Shims, web layouts (no onboarding wall; public catalog routes; protected watch/read/comments/dm/settings/addons), Stremio-like shell, runtime config `/huwa-config.json`, `?streamingServer=` with confirmation + Settings → Streaming server + capability badge, PWA (manifest, SW, persist), deploy (nginx SPA fallback + legacy pages, `.well-known` kept). Playwright acceptance incl. AASA content-type and universal links.

**P2 — Huwa Server image v1 + web playback with a local browser profile (4–5 wk)**
Rust server (routers, static, config, CORS, sessions/quotas, health/metrics, media module: ffprobe, HLS manager, Cues, sidecars, fonts, HW accel), web transport + adapters + web player + subtitles, source resolver, local web profile; Dockerfile (multi-stage, jellyfin-ffmpeg, tini, libatomic1, user huwa, volumes, healthcheck), `Dockerfile.web`, compose, Coolify template, `docker.yml` CI; blind-peer embedded as gateway child. Acceptance: docker run works; CI smoke (remux H.264/AAC MKV, transcode Hi10P/HEVC+AC3, seek 80 % < 5 s, ASS sidecar); session isolation & 429 quotas; Stremio Web ↔ Huwa server compat; Huwa web ↔ stock stremio/server; `-web` image has no engine/ffmpeg; multi-arch.

**P3 — browser P2P & real login (4–6 wk; D3-F = 2 wk)**
`rocksdb-idb` hardened; SharedWorker node + client (extract transport-agnostic RpcP2P base from bare.ts); leader election; gateway (non-custodial dht-relay, origin allowlist, limits, HyperDHT, rendezvous ≤8 KB, 2 min TTL); web login UI (QR, phrase, passkey, public computer, lock, logout=revoke+wipe); phone `settings/link-web.tsx` (OTA); identity-bound tokens; relays mirror browser bases. Acceptance: QR link < 20 s, comment web→phone < 10 s, phrase not persisted, multi-tab single node, revoke on logout, no secrets in gateway heap, custodial refused.

**P4 — encrypted vault: addon/extension sync (2–3 wk)**
`vault` op + RPC + rotation re-encrypt + chunking; contract/local; `src/settings/vault-sync.ts` two-way LWW; Settings → Sync; first web login pulls vault and installs addons. Acceptance: phone→web addon < 15 s, ciphertext only for peers, revoked device can't read new entries, deterministic conflicts.

**P5 — Paperback on web + fetch proxy (1.5–2 wk)**
iframe host, `net-web.ts` → `/api/v1/fetch` (Rust port of net.ts policy: http(s) only, no private IPs after DNS, redirects re-checked, caps, no cookies), disabled in `-web` image; Cloudflare-gated sources unsupported.

**P6 — hardening, compat, docs, one-click (2 wk+)**
HW-accel matrix, load test, metrics, JASSUB, Web Push (opt), Coolify template PR, `docs/SELF_HOSTING.md`, `docs/WEB.md`, privacy/terms updates.

Effort ≈ 17–22 developer-weeks; 7–9 calendar weeks with 4–5 agents after P0.

## 5. Docker image

```
/usr/local/bin/huwa-server   /opt/huwa/gateway/   /opt/huwa/web/   /usr/lib/jellyfin-ffmpeg/
/data (gateway keys, relay store, token.key, settings.json)   /cache (torrents, session, hls, subs)
8080/tcp everything; 49737/udp optional (DHT/relay); no BitTorrent inbound (upload compiled out)
```

Env: `HUWA_PORT`(8080) `HUWA_PUBLIC_URL` `HUWA_ALLOWED_ORIGINS`(self, https://huwa.mciut.fr) `HUWA_TRUST_PROXY`(0) `HUWA_TLS_CERT/KEY` `HUWA_TORRENT`(1) `HUWA_TRANSCODE`(1) `HUWA_HWACCEL`(auto) `HUWA_FETCH_PROXY`(1) `HUWA_STREMIO_COMPAT`(0) `HUWA_P2P_GATEWAY`(1) `HUWA_RELAY`(1) `HUWA_RELAY_MAX_STORAGE_MB`(2048) `HUWA_DHT_PORT`(49737) `HUWA_BOOTSTRAP` `HUWA_CACHE_MAX_GB`(20) `HUWA_MAX_SESSIONS`(50) `HUWA_SESSIONS_PER_IP`(5) `HUWA_STREAMS_PER_SESSION`(2) `HUWA_TRANSCODES_MAX`(1) `HUWA_TRANSCODES_PER_SESSION`(1) `HUWA_DOWNLOAD_LIMIT_MBPS`(0) `HUWA_MAX_WS`(200) `HUWA_REQUIRE_IDENTITY`(0) `HUWA_ALLOW_PRIVATE_UPSTREAMS`(0) `HUWA_INDEXABLE`(0 → noindex) `HUWA_INSTANCE_NAME` `HUWA_OPERATOR_CONTACT` `HUWA_ANILIST_CLIENT_ID` `HUWA_LOG`(info).

```yaml
services:
  huwa:
    image: ghcr.io/amintt2/huwa:latest
    restart: unless-stopped
    ports: ["8080:8080", "49737:49737/udp"]
    environment:
      HUWA_PUBLIC_URL: https://huwa.example.org
      HUWA_TRUST_PROXY: "1"
      HUWA_CACHE_MAX_GB: "30"
    volumes: ["./data:/data", "./cache:/cache"]
    # devices: ["/dev/dri:/dev/dri"]
```

## 6. PWA limits
iOS home-screen storage separate from Safari (sign in again), no background playback when locked, no orientation lock, `<video>`-only fullscreen, autoplay needs a gesture, PRF needs iOS 18, Web Push iOS 16.4+. Plain-http instances: no SW/install/WebAuthn. Offline: shell, posters, catalog, library; no offline playback v1.

## 7. Legal posture
No bundled addons/repos/packs; huwa.mciut.fr runs the `-web` image (no engine/ffmpeg/fetch proxy); seeding off at compile time; instances self-hosted by operators, no directory, noindex default, operator contact shown; `SELF_HOSTING.md` states what the operator sees (infohashes, URLs, IPs, transcodes) and never sees (keys, DM plaintext); licenses: librqbit Apache-2.0, jellyfin-ffmpeg GPL (NOTICE + source pointer), Stremio compat by protocol only.

## 8. Risks
rocksdb-native semantics in the browser adapter (High → S2, D3-F) · dht-relay experimental (High → pin/fork, non-custodial, D3-F) · browser crypto/PoW speed (Medium) · transcode CPU (Medium → quotas, HW accel, remux first) · copy-HLS seek without Cues (Medium) · SSRF via proxy/fetch/ffmpeg (High → IP policy after DNS, loopback-only ffmpeg inputs) · mixed content/CORS/LNA (Medium) · passkey support matrix (Medium) · localStorage quota (Medium → IDB shim) · storage eviction (Medium) · Paperback CORS/Cloudflare (Medium) · RN-web gaps & bundle size (Medium) · debrid CORS (Low–Medium) · public-instance legal exposure (Medium).

## 9. Agent ownership (exclusive writes)
- **A Server/Rust:** `native/huwa-server/**`, `native/huwa-torrent-core/**` (server feature, IP policy, base URL), `docs/server-api.md`.
- **B Web app/UI:** `src/app/**/*.web.tsx`, `src/components/**/*.web.tsx`, `src/web/**`, `modules/*/index.web.ts` (except passkey, torrent), `public/**`, `metro.config.js`, `app.json` web block, `scripts/web-postexport.mjs`, `test/web/**`.
- **C Browser P2P:** `packages/rocksdb-idb/**`, `src/p2p/web/**`, `src/p2p/index.ts`, `src/p2p/bare.ts` (base extraction), `services/huwa-gateway/**`, `modules/huwa-torrent/index.web.ts`.
- **D Account & vault:** `src/p2p/worklet/{node,apply,schema}.js` (after C's seam), `src/p2p/contract.ts`, `src/p2p/local.ts`, `src/settings/vault-sync.ts`, `src/app/settings/link-web.tsx`, `modules/huwa-passkey/index.web.ts`, `test/p2p/vault*.mjs`.
- **E Packaging/infra/docs:** `docker/**`, `deploy/**`, `.github/workflows/docker.yml`, `site/**`, `docs/SELF_HOSTING.md`, `docs/WEB.md`, `docs/ARCHITECTURE.md`, `PLAN.md`.
- Serialized: `src/app/_layout.tsx` (B only), `src/p2p/worklet/node.js` (C seam then D), `services/blind-peer/policy.js` (read-only), `package.json` (one dependency PR per phase).

Sources: github.com/Stremio/stremio-web · stremio-core `models/streaming_server.rs`, `types/streaming_server/request.rs` · stremio-video `withStreamingServer.js` · hub.docker.com/r/stremio/server · tsaridas/stremio-docker · stremio-server-go · holepunchto/hyperswarm-dht-relay · hypercore-storage README · Corestore.
