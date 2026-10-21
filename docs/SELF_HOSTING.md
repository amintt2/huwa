# Self-hosting Huwa Server

One Docker image gives you your own Huwa: the web app (installable PWA), a remote torrent
decoder / streaming server (no seeding), transcoding to HLS for any browser, and a P2P node that
helps the Huwa network (relay for browsers, blind-peer storage). Accounts stay in the browsers:
the server never holds a user's keys.

- Image: `ghcr.io/amintt2/huwa:<version>` (`latest` = the latest release), `linux/amd64` and
  `linux/arm64`.
- The `-web` variant (`ghcr.io/amintt2/huwa:<version>-web`) is the web app and P2P gateway
  only: no torrent engine, no ffmpeg, no proxy. That is what huwa.mciut.fr runs.
- API reference: `docs/server-api.md`. Design: `docs/WEB_DOCKER_PLAN.md`.

## 1. Quick start (`docker run`)

```sh
mkdir -p huwa/data huwa/cache && sudo chown -R 1000:1000 huwa
docker run -d --name huwa --restart unless-stopped \
  -p 8080:8080 -p 49737:49737/udp \
  -v "$PWD/huwa/data:/data" -v "$PWD/huwa/cache:/cache" \
  -e HUWA_PUBLIC_URL=https://huwa.example.org \
  -e HUWA_TRUST_PROXY=1 \
  ghcr.io/amintt2/huwa:latest
```

Open `http://<host>:8080` to check that it runs, then put it behind HTTPS (§4): a browser only
installs the PWA, runs its service worker and offers passkeys on a secure origin.

- `/data` keeps the session key (`token.key`: losing it logs every browser out of this server)
  and the relay's identity and store. Back it up.
- `/cache` holds torrent data and HLS segments. It can be deleted at any time (stopped server).
- The container runs as uid 1000 (`huwa`), with `tini` as PID 1. `docker stop` gives it 10 s.
- Health: `docker inspect --format '{{.State.Health.Status}}' huwa` (the image's HEALTHCHECK calls
  `GET /health`).

## 2. Docker Compose

`deploy/docker-compose.yml` in the repository:

```sh
curl -O https://raw.githubusercontent.com/amintt2/huwa/huwa-v1/deploy/docker-compose.yml
# edit HUWA_PUBLIC_URL, then
docker compose up -d
docker compose logs -f huwa
```

Updating: `docker compose pull && docker compose up -d`.

## 3. Coolify

`deploy/coolify/huwa.yaml` is a one-click style service template:

1. In Coolify: **+ New → Docker Compose Empty** (or a service from a custom template), paste the
   file.
2. Coolify fills `SERVICE_FQDN_HUWA_8080` (the domain routed to port 8080) and gives the
   container its `https://` URL as `HUWA_PUBLIC_URL`. Traefik terminates TLS and sets
   `X-Forwarded-For`, hence `HUWA_TRUST_PROXY=1`.
3. Set the optional variables (instance name, contact, cache size, Stremio compatibility) in the
   service's Environment Variables, then deploy.
4. Open UDP 49737 on the host firewall if you want the relay to help the network (optional).

### huwa.mciut.fr (the public web app)

huwa.mciut.fr runs the `-web` image (`docker/Dockerfile.web`): huwa-server without the engine,
ffmpeg or fetch proxy, the web app, the P2P gateway at `/p2p` (web login needs it) and the legacy
site (`site/`: `/get` landing page, `/privacy`, `/terms`, `/pack`, `/extensions`, AltStore
sources, `.well-known` association files served as JSON, `/addon` and `/install` universal links
→ the extensions page). The exact Coolify settings (Dockerfile build pack, base `/`, Dockerfile
`/docker/Dockerfile.web`, port 8080, `HUWA_PUBLIC_URL`, `HUWA_TRUST_PROXY=1`, `HUWA_INDEXABLE=1`,
`HUWA_RELAY=0`, `HUWA_DISCORD_INVITE=https://discord.gg/JSwf34Kw3E`, volume `/data`) are at the top of `deploy/coolify/huwa-site.yaml`, which is also
a Compose file for the same deployment. `HUWA_RELAY=0` because the standalone `huwa-relay` app
(`services/blind-peer`, UDP 49738) already relays on that host.

## 4. HTTPS and reverse proxies

Recommended: a reverse proxy that terminates TLS and forwards everything (HTTP and WebSocket) to
port 8080, with `HUWA_TRUST_PROXY=1`.

**Caddy**

```
huwa.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name huwa.example.org;
    # ssl_certificate … ;
    client_max_body_size 8m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;          # /p2p WebSockets
        proxy_set_header Connection $connection_upgrade; # map $http_upgrade $connection_upgrade {…}
        proxy_buffering off;                             # media streams
        proxy_read_timeout 3600s;
    }
}
```

**Built-in TLS** (no proxy): mount a certificate and key (PEM) and set
`HUWA_TLS_CERT=/data/tls/fullchain.pem`, `HUWA_TLS_KEY=/data/tls/privkey.pem`. The server then
speaks only HTTPS on `HUWA_PORT` (HTTP/1.1). Renewing the certificate needs a restart.

There is no central certificate service (unlike Stremio's `*.stremio.rocks`): each instance uses
its own domain.

### CORS and `HUWA_ALLOWED_ORIGINS`

Browsers on another origin may use this server (its API and media) only if their origin is
allowed. Default: `self,https://huwa.mciut.fr`, i.e. the web app served by this server itself
(`HUWA_PUBLIC_URL`'s origin) and the public web app. Examples:

- `HUWA_ALLOWED_ORIGINS=self` — only your own web app;
- `HUWA_ALLOWED_ORIGINS=self,https://huwa.mciut.fr,http://localhost:8081` — plus a dev build;
- `*` — any site (not recommended: any page could use your server with a session it creates).

Only origins are compared (`scheme://host[:port]`). No cookies are used: a session is a Bearer
token per browser.

### LAN and plain HTTP

On a LAN without HTTPS (`http://192.168.1.10:8080`), the web app works but the browser gives it
**no secure context**: no PWA install, no service worker (no offline shell), no WebAuthn /
passkeys, no `navigator.storage.persist()`, and some browsers limit IndexedDB. Use a local domain
with a certificate (Caddy with an internal CA, or a public domain with a DNS challenge) for the
full experience. `http://localhost` is a secure context, so the server's own machine is fine.

An `https://huwa.mciut.fr` page cannot load media from an `http://` LAN server (mixed content);
Chrome also asks Private Network Access preflights, which the server answers. Give the LAN server
HTTPS too, or open its own web app.

## 5. Hardware transcoding

Transcoding runs only when a browser cannot play a file (HEVC / AV1 / VP9 it does not decode,
H.264 10-bit "Hi10P" anime encodes, PGS subtitles to burn in). Remuxing (copy video, AAC audio)
costs little. Software x264 handles about one 1080p stream per 4 modern cores; with a GPU:

- **Intel / AMD (VAAPI, QSV):** pass `/dev/dri` and the render group:

  ```yaml
  devices: ["/dev/dri:/dev/dri"]
  group_add: ["<gid of /dev/dri/renderD128 on the host>"]
  environment: { HUWA_HWACCEL: auto }   # or vaapi / qsv
  ```

- **NVIDIA (NVENC):** install the NVIDIA Container Toolkit and give the container the GPU
  (`--gpus all`, or the compose `deploy.resources.reservations.devices` block in
  `deploy/docker-compose.yml`), `HUWA_HWACCEL=nvenc`.

At start the server tries the encoder(s) on a test pattern and logs which one it uses
(`/api/v1/info` → `transcode.encoder`). Decoding stays in software. Raise `HUWA_TRANSCODES_MAX`
to what the machine sustains.

## 6. Stremio compatibility (optional)

`HUWA_STREMIO_COMPAT=1` adds the Stremio streaming-server routes at the root, so Stremio (web or
desktop) can use `https://huwa.example.org` as its streaming server. These routes have **no
authentication** (Stremio clients send none): every Stremio client shares one quota bucket
(`HUWA_STREMIO_COMPAT_STREAMS`). Enable it on a private instance, or behind reverse-proxy auth.

## 7. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUWA_PORT` | `8080` | TCP port for everything (web app, API, media, `/p2p`) |
| `HUWA_BIND` | `0.0.0.0` | listen address |
| `HUWA_PUBLIC_URL` | unset | public base URL (`https://huwa.example.org`): absolute media URLs, `self` origin |
| `HUWA_ALLOWED_ORIGINS` | `self,https://huwa.mciut.fr` | CORS allowlist (§4) |
| `HUWA_TRUST_PROXY` | `0` | client address from `X-Forwarded-For` / `X-Real-IP` (only behind a proxy that sets them) |
| `HUWA_TLS_CERT`, `HUWA_TLS_KEY` | unset | built-in HTTPS (PEM) |
| `HUWA_DATA_DIR` | `/data` | persistent state (session key, relay) |
| `HUWA_CACHE_DIR` | `/cache` | torrents, HLS, sidecars |
| `HUWA_WEB_DIR` | `/opt/huwa/web` | web app build (`-`: none) |
| `HUWA_TORRENT` | `1` | torrent engine and HTTP proxy |
| `HUWA_TRANSCODE` | `1` | media module (probe, HLS, sidecars) |
| `HUWA_HWACCEL` | `auto` | `auto`, `none`, `vaapi`, `qsv`, `nvenc` |
| `HUWA_FFMPEG`, `HUWA_FFPROBE` | jellyfin-ffmpeg | binaries |
| `HUWA_FETCH_PROXY` | — | reserved (Paperback / debrid fetch bridge, not in this version) |
| `HUWA_STREMIO_COMPAT` | `0` | Stremio streaming-server routes (§6) |
| `HUWA_STREMIO_COMPAT_STREAMS` | `4` | streams of the shared Stremio bucket |
| `HUWA_P2P_GATEWAY` | `1` | P2P gateway for browsers at `/p2p` (Node child) |
| `HUWA_GATEWAY_PORT` | `18081` | its internal loopback port |
| `HUWA_RELAY` | `1` | blind-peer relay (Node child) |
| `HUWA_RELAY_MAX_STORAGE_MB` | `2048` | relay storage budget |
| `HUWA_DHT_PORT` | `49737` | relay UDP port (publish it to help the network) |
| `HUWA_BOOTSTRAP` | unset | custom HyperDHT bootstrap `host:port,…` |
| `HUWA_CACHE_MAX_GB` | `20` | torrent cache (least recently used idle torrents evicted) |
| `HUWA_MAX_SESSIONS` | `50` | active browser sessions server-wide |
| `HUWA_SESSIONS_PER_IP` | `5` | active sessions created from one address (IPv6: per /64) |
| `HUWA_SESSION_TTL_DAYS` | `30` | session lifetime |
| `HUWA_STREAM_TOKEN_HOURS` | `6` | lifetime of a media URL |
| `HUWA_REQUIRE_IDENTITY` | `0` | sessions must prove a browser Ed25519 key |
| `HUWA_STREAMS_PER_SESSION` | `2` | concurrent streams per browser (torrent or HTTP) |
| `HUWA_TRANSCODES_MAX` | `1` | concurrent video transcodes server-wide |
| `HUWA_TRANSCODES_PER_SESSION` | `1` | per browser |
| `HUWA_PROXY_SESSIONS` | `32` | HTTP proxy sessions server-wide |
| `HUWA_PROXY_SESSIONS_PER_SESSION` | `8` | per browser |
| `HUWA_PROXY_READAHEAD_MB` | `48` | read-ahead kept per HTTP proxy session |
| `HUWA_DOWNLOAD_LIMIT_MBPS` | `0` | torrent download cap in Mbit/s (0 = none) |
| `HUWA_MAX_WS` | `200` | concurrent `/p2p` WebSockets |
| `HUWA_ALLOW_PRIVATE_UPSTREAMS` | `0` | let the HTTP proxy reach LAN hosts (RFC 1918 / ULA); loopback and metadata stay blocked |
| `HUWA_INDEXABLE` | `0` | allow search engines (default: `X-Robots-Tag: noindex`, `robots.txt` disallow) |
| `HUWA_INSTANCE_NAME` | unset | shown by the web app |
| `HUWA_OPERATOR_CONTACT` | unset | shown by the web app (abuse / legal contact) |
| `HUWA_ANILIST_CLIENT_ID` | unset | AniList OAuth client for this domain |
| `HUWA_DISCORD_INVITE` | unset | community invite (`https://discord.gg/…`) shown by the web app after sign-in and in Réglages; unset or `none` = hidden. The compose file and Coolify templates set the Huwa server, `https://discord.gg/JSwf34Kw3E` |
| `HUWA_METRICS` | `loopback` | `/metrics`: `loopback`, `1` (public), `0` (off) |
| `HUWA_WORKER_THREADS` | CPU count | engine threads |
| `HUWA_LOG` | `info` | log filter (`info,huwa_server=debug`) |

Booleans: `1/0`, `true/false`, `yes/no`, `on/off`. An invalid value stops the server at start
with a message naming the variable.

Monitoring: `curl http://127.0.0.1:8080/metrics` from the host (or `HUWA_METRICS=1` behind your
own access control) for Prometheus.

## 8. What the operator sees, and what it never sees

Running a Huwa server makes you the operator of a service other people use. Be clear about what
passes through your machine.

**The operator can see** (logs, `/metrics`, the cache, a packet capture):
- the **info hashes** of the torrents your users stream, the files' names and the data itself
  (in `/cache` while cached);
- the **URLs** of the remote files streamed through the HTTP proxy (debrid links included: they
  often embed an account token);
- the **IP addresses** of the browsers that connect, and of the BitTorrent peers the engine
  downloads from;
- which media are **transcoded**, when, and with which settings;
- the number of sessions, their activity times, and P2P relay traffic (encrypted Hypercore
  blocks, sizes, peers).

**The operator never sees:**
- users' **private keys**: accounts, devices and signatures live in each browser (the P2P node
  runs in the browser; the gateway only relays ciphertext and refuses custodial clients);
- **direct messages** and private vault data in plaintext: they are end-to-end encrypted; the
  relay stores ciphertext;
- passwords: there are none (sessions are per-browser tokens, optionally bound to a browser key).

The server does not log full media URLs or tokens, and `/metrics` carries no hash, URL or
address. Logs at `debug` level can contain more: keep `HUWA_LOG=info` in production.

## 9. Operator responsibility and access control

- You are responsible for what your server is used for in your jurisdiction. Huwa ships **no
  addons, no catalogs of streams and no content**; users bring their own sources.
- **No seeding.** BitTorrent upload is compiled out of the engine: the server downloads to stream
  and never uploads to other peers (no inbound BitTorrent port either).
- Instances are **not listed** anywhere and are `noindex` by default.
- Set `HUWA_OPERATOR_CONTACT` so users and rights holders can reach you.
- To keep the server for yourself and people you know, put **authentication in the reverse
  proxy** (HTTP basic auth, Authelia, Authentik, Cloudflare Access, Tailscale…). The web app and
  its API calls all go to the same origin, so a proxy login in front of everything works. Two
  details:
  - a media player or `<video>` element cannot answer a login prompt: use cookie-based proxy auth
    (forward-auth / SSO), not per-request basic auth, or the browser asks again for every
    segment;
  - with the public web app (huwa.mciut.fr) using your server cross-origin, cookie auth does not
    apply (no credentials are sent): restrict with `HUWA_ALLOWED_ORIGINS=self` and use your own
    instance's web app.
- `HUWA_MAX_SESSIONS`, `HUWA_SESSIONS_PER_IP`, the stream and transcode quotas and
  `HUWA_DOWNLOAD_LIMIT_MBPS` bound what one user can take.
- Licenses: Huwa (MIT), librqbit (Apache-2.0), jellyfin-ffmpeg (GPL-3.0-or-later, unmodified
  Jellyfin package; source pointers in `/usr/share/doc/huwa/NOTICE` inside the image).

## 10. Troubleshooting

| Symptom | Check |
| --- | --- |
| `permission denied` on `/data` or `/cache` | the directories must belong to uid 1000 |
| Web app loads but the server badge says "offline" | CORS: is the page's origin in `HUWA_ALLOWED_ORIGINS`? |
| `429 too_many_sessions` for everyone | behind a proxy without `HUWA_TRUST_PROXY=1`, every client has the proxy's address |
| Playback stalls at the start of a torrent | no peers: the engine needs outbound TCP/UDP; check `status.peersLive` |
| `503 segment_not_ready` | the transcode is slower than real time (`HUWA_HWACCEL`, fewer concurrent transcodes) or the torrent has no data yet |
| `/p2p` answers 503 | `HUWA_P2P_GATEWAY=0`, or the gateway child keeps restarting: see the logs |
| Hardware encoder not used | `docker exec huwa ls -l /dev/dri`, the group in `group_add`, `HUWA_LOG=info,huwa_server=debug` |
