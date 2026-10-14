# syntax=docker/dockerfile:1.7
#
# Huwa Server, full image (ghcr.io/amintt2/huwa:<version>): web app + per-browser sessions +
# torrent engine (no seeding: compiled out) + read-ahead HTTP proxy + jellyfin-ffmpeg (HLS
# remux / transcode) + P2P gateway and blind-peer relay (Node 22 children). One TCP port.
# Operators: docs/SELF_HOSTING.md. Plan: docs/WEB_DOCKER_PLAN.md §5.
#
#   docker build -f docker/Dockerfile -t huwa .
#
# CI (.github/workflows/docker.yml) builds the web export once and passes it with
# `--build-context web=<dir>`, which replaces the `web` stage below.

ARG NODE_VERSION=22
ARG RUST_IMAGE=rust:1-bookworm
ARG JELLYFIN_FFMPEG=jellyfin-ffmpeg7

# ---- 1. Web export (platform independent: runs once, on the build machine) --------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm AS web-build
WORKDIR /src
ENV EXPO_NO_TELEMETRY=1 CI=1
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
# `build:web` (web agent: export + post-export steps) when the project has it, plain export otherwise.
RUN if node -e "process.exit(require('./package.json').scripts['build:web'] ? 0 : 1)"; then \
      npm run build:web; \
    else \
      npx expo export -p web --output-dir dist; \
    fi \
 && test -f dist/index.html

FROM scratch AS web
COPY --from=web-build /src/dist/ /

# ---- 2. huwa-server (Rust, native to the target platform) ---------------------------------------
FROM ${RUST_IMAGE} AS rust
ARG CARGO_FLAGS=""
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/native
# Dependencies first (cached layer): manifests, lock files, vendored crates, stub sources.
COPY native/vendor ./vendor
COPY native/huwa-torrent-core/Cargo.toml native/huwa-torrent-core/Cargo.lock ./huwa-torrent-core/
COPY native/huwa-server/Cargo.toml native/huwa-server/Cargo.lock ./huwa-server/
RUN mkdir -p huwa-torrent-core/src huwa-torrent-core/bench huwa-server/src huwa-server/examples \
 && echo "pub const VERSION: &str = \"stub\";" > huwa-torrent-core/src/lib.rs \
 && echo "fn main() {}" > huwa-torrent-core/bench/start_bench.rs \
 && echo "" > huwa-server/src/lib.rs \
 && echo "fn main() {}" > huwa-server/src/main.rs \
 && cd huwa-server && cargo build --locked --release $CARGO_FLAGS || true
COPY native/huwa-torrent-core ./huwa-torrent-core
COPY native/huwa-server ./huwa-server
RUN cd huwa-server \
 && touch ../huwa-torrent-core/src/lib.rs src/lib.rs src/main.rs \
 && cargo build --locked --release $CARGO_FLAGS \
 && cp target/release/huwa-server /usr/local/bin/huwa-server \
 && /usr/local/bin/huwa-server --version

# ---- 3. Node children: P2P gateway + blind-peer relay (production dependencies) -----------------
FROM node:${NODE_VERSION}-bookworm AS gateway
WORKDIR /opt/huwa
COPY services/huwa-gateway/package.json services/huwa-gateway/package-lock.json ./gateway/
RUN --mount=type=cache,target=/root/.npm cd gateway && npm ci --omit=dev --no-audit --no-fund
COPY services/huwa-gateway/ ./gateway/
COPY services/blind-peer/package.json services/blind-peer/package-lock.json ./blind-peer/
RUN --mount=type=cache,target=/root/.npm cd blind-peer && npm ci --omit=dev --no-audit --no-fund
COPY services/blind-peer/server.js services/blind-peer/policy.js ./blind-peer/

FROM node:${NODE_VERSION}-bookworm-slim AS node

# ---- 4. Runtime ------------------------------------------------------------------------------------
FROM debian:bookworm-slim AS full
ARG JELLYFIN_FFMPEG
ARG VERSION=dev
LABEL org.opencontainers.image.title="Huwa Server" \
      org.opencontainers.image.description="Self-hostable Huwa: web app, torrent streaming (no seeding), HLS transcoding, P2P relay" \
      org.opencontainers.image.source="https://github.com/amintt2/huwa" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0 AND GPL-3.0-or-later"
# tini (PID 1, signal forwarding), libatomic1 (rocksdb-native on arm64), jellyfin-ffmpeg (GPL:
# see /usr/share/doc/huwa/NOTICE) from the Jellyfin repository; VAAPI / QSV drivers come with it
# on amd64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini libatomic1 \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" > /etc/apt/sources.list.d/jellyfin.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends ${JELLYFIN_FFMPEG} \
 && dpkg-query -W -f='${Package} ${Version}\n' ${JELLYFIN_FFMPEG} > /usr/lib/jellyfin-ffmpeg/PACKAGE_VERSION \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && /usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -version | head -1
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN groupadd --system --gid 1000 huwa \
 && useradd --system --uid 1000 --gid huwa --groups video --home-dir /home/huwa --create-home --shell /usr/sbin/nologin huwa \
 && mkdir -p /data /cache /opt/huwa \
 && chown huwa:huwa /data /cache
COPY --from=rust /usr/local/bin/huwa-server /usr/local/bin/huwa-server
COPY --from=gateway /opt/huwa/gateway /opt/huwa/gateway
COPY --from=gateway /opt/huwa/blind-peer /opt/huwa/blind-peer
COPY --from=web / /opt/huwa/web/
COPY docker/NOTICE /usr/share/doc/huwa/NOTICE
COPY LICENSE /usr/share/doc/huwa/LICENSE
ENV HUWA_PORT=8080 \
    HUWA_DATA_DIR=/data \
    HUWA_CACHE_DIR=/cache \
    HUWA_WEB_DIR=/opt/huwa/web \
    HUWA_FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    HUWA_FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe \
    NODE_ENV=production
USER huwa
WORKDIR /home/huwa
VOLUME ["/data", "/cache"]
# 8080/tcp: everything (web app, API, media, /p2p). 49737/udp: DHT of the blind-peer relay
# (optional). No BitTorrent inbound port: upload is compiled out.
EXPOSE 8080 49737/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/huwa-server", "--healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/huwa-server"]
