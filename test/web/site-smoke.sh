#!/bin/sh
# Smoke test of the huwa.mciut.fr image (site/Dockerfile): legacy pages and rules + the web app.
#   docker build -f site/Dockerfile -t huwa-site .   (BuildKit; the legacy builder needs a root
#   .dockerignore copied from site/Dockerfile.dockerignore)
#   sh test/web/site-smoke.sh [image=huwa-site] [port=8160]
set -eu
IMAGE=${1:-huwa-site}
PORT=${2:-8160}
NAME=huwa-site-smoke
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:80" "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
sleep 2
BASE="http://localhost:$PORT"
fail=0

check() { # path, expected status, expected content-type prefix (optional)
  got=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE$1")
  code=${got%% *}
  type=${got#* }
  if [ "$code" != "$2" ] || { [ -n "${3:-}" ] && case "$type" in "$3"*) false ;; *) true ;; esac; }; then
    echo "FAIL $1 -> $got (attendu $2 ${3:-})"
    fail=1
  else
    echo "ok   $1 -> $got"
  fi
}

check / 200 text/html
check /anime/al1 200 text/html
check /settings 200 text/html
check /get 200 text/html
check /privacy 200 text/html
check /privacy.html 200 text/html
check /terms.html 200 text/html
check /pack.html 200 text/html
check /extensions 200 text/html
check '/addon?url=x' 200 text/html
check /install 200 text/html
check /altstore-source.json 200 application/json
check /sideload-source.json 200 application/json
check /altstore/icon.png 200 image/png
check /.well-known/apple-app-site-association 200 application/json
check /.well-known/assetlinks.json 200 application/json
check /.well-known/nope 404
check /sw.js 200 application/javascript
check /manifest.webmanifest 200 application/manifest+json
check /huwa-config.json 200 application/json
check /_expo/static/js/web/nope.js 404

# The app is the home page, the old landing is /get, /addon is the legacy extensions page.
curl -s "$BASE/" | grep -q 'rel="manifest"' || { echo 'FAIL / sans manifest'; fail=1; }
curl -s "$BASE/get" | grep -q 'altstore' || { echo 'FAIL /get n’est pas l’ancienne page'; fail=1; }
curl -s "$BASE/addon?url=x" | grep -qi 'extension' || { echo 'FAIL /addon'; fail=1; }
# No redirect on the association file.
[ "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/.well-known/apple-app-site-association")" = "" ] || { echo 'FAIL AASA redirige'; fail=1; }
# Hashed bundle: immutable and gzip.
entry=$(curl -s "$BASE/" | grep -o '/_expo/static/js/web/entry-[0-9a-f]*\.js' | head -1)
headers=$(curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' "$BASE$entry")
echo "$headers" | grep -qi 'cache-control: public, max-age=31536000, immutable' || { echo "FAIL $entry pas immutable"; fail=1; }
echo "$headers" | grep -qi 'content-encoding: gzip' || { echo "FAIL $entry pas gzip"; fail=1; }
curl -s -o /dev/null -D - "$BASE/sw.js" | grep -qi 'cache-control: no-cache' || { echo 'FAIL sw.js en cache'; fail=1; }

[ $fail = 0 ] && echo 'site: OK'
exit $fail
