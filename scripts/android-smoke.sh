#!/usr/bin/env bash
# Test de fumée Android (CI, .github/workflows/release-android.yml, job `smoke`) :
# installe l'APK sur l'émulateur démarré, lance l'activité principale, attend ~20 s et échoue si
# le processus est mort ou si logcat contient un FATAL pour l'app.
# Sorties dans ./smoke/ : logcat complet, tampon crash, capture d'écran.
#
#   bash scripts/android-smoke.sh dist-apk/Huwa-1.0.0-x86_64.apk
set -uo pipefail

APK="${1:?usage: $0 <apk>}"
PKG="com.amintt2.huwa"
WAIT="${SMOKE_WAIT:-20}"
OUT="smoke"
mkdir -p "$OUT"

adb wait-for-device
adb logcat -c || true

echo "==> install $APK"
adb install -r -g "$APK" || { echo "FAIL: installation"; exit 1; }

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
else
  exit 1
fi
