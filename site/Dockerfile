# SUPERSEDED by docker/Dockerfile.web (deploy/coolify/huwa-site.yaml): same pages plus the P2P
# gateway that web login needs. Kept for a rollback only.
#
# huwa.mciut.fr — public Huwa web app + the legacy site pages (docs/WEB_DOCKER_PLAN.md D15, P1).
# No torrent engine, no ffmpeg, no fetch proxy: nginx serving static files only.
#
# Build context = the repository root (the web app needs src/, assets/…), Dockerfile in site/:
#   docker build -f site/Dockerfile -t huwa-site .
#   docker run --rm -p 8080:80 huwa-site
# Coolify: build pack "Dockerfile", base directory "/", Dockerfile location "/site/Dockerfile",
# port 80. site/Dockerfile.dockerignore keeps the context small (BuildKit reads it for this file).

# ---------- 1. web app: expo export -p web + PWA post-export ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV CI=1 EXPO_NO_TELEMETRY=1 NODE_OPTIONS=--max-old-space-size=4096
COPY package.json package-lock.json ./
# No install scripts: the postinstall builds the Bare worklet bundle, which the web build never
# loads (src/p2p/bare.web.ts). Only the Paperback runtime bundle is needed (below).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build:paperback && npm run build:web

# ---------- 2. nginx ----------
FROM nginx:1.27-alpine
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
# Legacy site first, then the app on top (the app's index.html is the new home page).
COPY site/ /usr/share/nginx/html/
RUN cd /usr/share/nginx/html \
 && mv index.html get.html \
 && rm -f Dockerfile Dockerfile.dockerignore nginx.conf
COPY --from=web /app/dist/ /usr/share/nginx/html/
# Pre-compressed copies for gzip_static (text assets only).
RUN find /usr/share/nginx/html -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.webmanifest' -o -name '*.svg' \) -size +1k -exec gzip -9 -k {} \;
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/huwa-config.json >/dev/null || exit 1
