#!/usr/bin/env bash
# Test de fumée Android (CI, .github/workflows/release-android.yml, job `smoke`) :
# installe l'APK sur l'émulateur démarré, lance l'activité principale, attend ~20 s et échoue si
# le processus est mort ou si logcat contient un FATAL pour l'app.
# Puis HTTPS du moteur torrent : le récepteur de test HuwaTorrentTlsCheckReceiver (désactivé et non
# exporté dans l'APK, activé ici par adb root + pm enable) initialise le vérifieur TLS comme le
# module, fait faire au moteur Rust un GET HTTPS valide (doit réussir) et un GET vers un certificat
# expiré (doit échouer proprement), et journalise la politique cleartext (loopback seul).
# Échec si une ligne attendue manque ou si le moteur a paniqué (tag logcat HuwaTorrentRust).
# Sorties dans ./smoke/ : logcat complet, tampon crash, capture d'écran, tls.txt.
#
#   bash scripts/android-smoke.sh dist-apk/Huwa-1.0.0-x86_64.apk
set -uo pipefail

APK="${1:?usage: $0 <apk>}"
PKG="com.amintt2.huwa"
WAIT="${SMOKE_WAIT:-20}"
OUT="smoke"
RECEIVER="$PKG/expo.modules.huwatorrent.HuwaTorrentTlsCheckReceiver"
TLS_OK_URL="${SMOKE_TLS_OK_URL:-https://www.google.com/generate_204}"
TLS_BAD_URL="${SMOKE_TLS_BAD_URL:-https://expired.badssl.com/}"
mkdir -p "$OUT"

adb wait-for-device
adb logcat -c || true

echo "==> install $APK"
adb install -r -g "$APK" || { echo "FAIL: installation"; exit 1; }

# Root (images google_apis) : seul root / système peut activer et joindre le récepteur de test.
# Activé avant le lancement : `pm enable` tue le processus de l'app.
tls=1
adb root >/dev/null 2>&1 || true
adb wait-for-device
for _ in $(seq 1 20); do [ "$(adb shell id -u 2>/dev/null | tr -d '\r')" = 0 ] && break; sleep 1; done
if [ "$(adb shell id -u 2>/dev/null | tr -d '\r')" = 0 ] && adb shell pm enable "$RECEIVER"; then
  echo "==> récepteur de test TLS activé"
else
  echo "FAIL: adb root / pm enable impossible, pas de test HTTPS"
  tls=0
fi

echo "==> start $PKG/.MainActivity"
adb shell am start -W -n "$PKG/.MainActivity" | tee "$OUT/am-start.txt"

ok=1
for i in $(seq 1 "$WAIT"); do
  sleep 1
  if [ -z "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then
    echo "FAIL: process gone after ${i}s"
    ok=0
    break
  fi
done

if [ "$ok" = 1 ] && [ "$tls" = 1 ]; then
  echo "==> HTTPS du moteur torrent : $TLS_OK_URL (doit réussir), $TLS_BAD_URL (doit échouer)"
  adb shell am broadcast -n "$RECEIVER" --esa urls "$TLS_OK_URL,$TLS_BAD_URL"
  for _ in $(seq 1 60); do
    adb logcat -d -s HuwaTorrent:V | grep -qE "tlsCheck (done|failed|engine not linked)" && break
    sleep 1
  done
  adb logcat -d -s HuwaTorrent:V HuwaTorrentRust:V > "$OUT/tls.txt" || true
  cat "$OUT/tls.txt"
  adb shell pm disable "$RECEIVER" >/dev/null 2>&1 || true

  okline="$(grep -F "tlsCheck $TLS_OK_URL -> " "$OUT/tls.txt" | tail -1)"
  badline="$(grep -F "tlsCheck $TLS_BAD_URL -> " "$OUT/tls.txt" | tail -1)"
  grep -q "TLS verifier initialised" "$OUT/tls.txt" || { echo "FAIL: TLS verifier not initialised"; tls=0; }
  if ! echo "$okline" | grep -qE '"ok":\{.*"status":[23][0-9][0-9]'; then
    echo "FAIL: HTTPS GET through the engine did not succeed: ${okline:-<no result>}"; tls=0
  fi
  if ! echo "$badline" | grep -q '"error":'; then
    echo "FAIL: expired certificate accepted or no result: ${badline:-<no result>}"; tls=0
  elif ! echo "$badline" | grep -qi 'certificate'; then
    echo "WARN: $TLS_BAD_URL failed, but not on its certificate (site unreachable?): $badline"
  fi
  if ! grep -q "tlsCheck cleartext 127.0.0.1=true localhost=true example.com=false" "$OUT/tls.txt"; then
    echo "FAIL: cleartext policy is not loopback-only"; tls=0
  fi
  if grep -q "HuwaTorrentRust" "$OUT/tls.txt"; then
    echo "FAIL: Rust panic in the engine"; tls=0
  fi
  [ "$tls" = 1 ] && echo "OK: engine HTTPS (valid certificate accepted, expired one refused), cleartext loopback only"
fi

adb exec-out screencap -p > "$OUT/screen.png" || true
adb logcat -d > "$OUT/logcat.txt" || true
adb logcat -d -b crash > "$OUT/crash.txt" || true

# Only this app's crashes count (Java: "Process: <pkg>" after FATAL EXCEPTION; native:
# "Fatal signal … (<pkg>)"), not other system processes of the emulator.
if grep -qE "AndroidRuntime: Process: $PKG|Fatal signal.*$PKG" "$OUT/logcat.txt" || grep -q "$PKG" "$OUT/crash.txt"; then
  echo "FAIL: crash in logcat"
  grep -n -A25 -E "FATAL EXCEPTION|Fatal signal" "$OUT/logcat.txt" | head -80
  ok=0
fi

echo "==> ReactNativeJS / Huwa (extrait)"
grep -E "ReactNativeJS|BareKit|HuwaTorrent" "$OUT/logcat.txt" | tail -40 || true

if [ "$ok" = 1 ]; then
  echo "OK: $PKG running after ${WAIT}s, no FATAL in logcat"
fi
[ "$ok" = 1 ] && [ "$tls" = 1 ] || exit 1
