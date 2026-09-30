#!/usr/bin/env bash
# Builds modules/huwa-mpv/ios/Libmpv.xcframework (git-ignored): ONE dynamic framework containing
# libmpv + FFmpeg + libass/libplacebo/MoltenVK..., from the LGPL prebuilt static xcframeworks of
# MPVKit (https://github.com/mpvkit/MPVKit).
#
# Why a dynamic framework (and not MPVKit's static ones as-is):
#  - LGPL: libmpv/FFmpeg stay a separate, replaceable binary (Frameworks/Libmpv.framework in the
#    .app). Anyone can relink/replace it with their own build exporting the same `mpv_*` API.
#  - Size: only the `mpv_*` client API is exported and the linker dead-strips everything else.
#  - CocoaPods only vendors frameworks that live inside the pod folder, hence the location.
#
# The library list mirrors the `_MPVKit` product (LGPL) of MPVKit's Package.swift — NOT
# `_MPVKit-GPL` (no -GPL assets, no Libsmbclient). Libluajit is macOS-only upstream.
#
# Usage:  scripts/fetch-mpvkit.sh                 # device (arm64) + simulator (arm64)
#         SIM_X86=1 scripts/fetch-mpvkit.sh       # + x86_64 simulator (Intel Macs)
#         MPVKIT_TAG=1.0.0 scripts/fetch-mpvkit.sh
# Then:   HUWA_MPV=1 npx expo prebuild -p ios     (plugins/with-huwa-mpv.js) and build.
set -euo pipefail

TAG="${MPVKIT_TAG:-1.0.0}"
MIN_IOS="${MIN_IOS:-16.4}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/modules/huwa-mpv/ios/Libmpv.xcframework"
CACHE="${MPVKIT_CACHE:-$HOME/Library/Caches/huwa-mpvkit/$TAG}"
STATIC="$CACHE/static"
WORK="$CACHE/work"
mkdir -p "$STATIC" "$WORK"

PKG="$CACHE/Package.swift"
[[ -s "$PKG" ]] || curl -fsSL "https://raw.githubusercontent.com/mpvkit/MPVKit/$TAG/Package.swift" -o "$PKG"

# Binary targets of the LGPL product (Package.swift `_MPVKit` + `_FFmpeg`).
WANT=(Libmpv Libavcodec Libavdevice Libavfilter Libavformat Libavutil Libswresample Libswscale
      Libssl Libcrypto Libass Libfreetype Libfribidi Libharfbuzz MoltenVK Libshaderc_combined lcms2
      Libplacebo Libdovi Libunibreak gmp nettle hogweed gnutls Libdav1d Libuavs3d Libuchardet Libbluray)

TARGETS="$(python3 - "$PKG" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
for m in re.finditer(r'\.binaryTarget\(\s*name:\s*"([^"]+)",\s*url:\s*"([^"]+)",\s*checksum:\s*"([^"]+)"', src):
    print("|".join(m.groups()))
PY
)"

# ---- 1. download + verify the static xcframeworks ----
for name in "${WANT[@]}"; do
  line="$(grep "^$name|" <<<"$TARGETS" || true)"
  [[ -n "$line" ]] || { echo "error: $name not found in MPVKit $TAG Package.swift" >&2; exit 1; }
  url="$(cut -d'|' -f2 <<<"$line")"; sum="$(cut -d'|' -f3 <<<"$line")"
  case "$url" in *-GPL*) echo "error: refusing GPL asset $url" >&2; exit 1;; esac
  zip="$CACHE/$name.xcframework.zip"
  if [[ ! -s "$zip" ]] || [[ "$(shasum -a 256 "$zip" | cut -d' ' -f1)" != "$sum" ]]; then
    echo "==> download $name"
    curl -fL --retry 3 -s "$url" -o "$zip"
  fi
  got="$(shasum -a 256 "$zip" | cut -d' ' -f1)"
  [[ "$got" == "$sum" ]] || { echo "error: checksum mismatch for $name ($got != $sum)" >&2; exit 1; }
  [[ -d "$STATIC/$name.xcframework" ]] || unzip -q -o "$zip" -d "$STATIC"
done

# ---- 2. link one dynamic Libmpv per slice ----
echo "_mpv_*" > "$WORK/exports.txt"
link() { # <static slice dir> <sdk> <arch> <target triple> <out>
  local slice=$1 sdk=$2 arch=$3 triple=$4 out=$5 libs=() n d
  for x in "$STATIC"/*.xcframework; do
    n="$(basename "$x" .xcframework)"; d="$x/$slice"
    if [[ $n == Libmpv ]]; then libs+=("-Wl,-force_load,$d/$n.framework/$n")
    elif [[ -d "$d/$n.framework" ]]; then libs+=("$d/$n.framework/$n")
    else libs+=("$(ls "$d"/*.a | head -1)"); fi
  done
  echo "==> link $sdk $arch"
  xcrun -sdk "$sdk" clang -arch "$arch" -target "$triple" -dynamiclib -o "$out" \
    -install_name @rpath/Libmpv.framework/Libmpv -compatibility_version 1 -current_version 1 \
    "${libs[@]}" -Wl,-exported_symbols_list,"$WORK/exports.txt" -Wl,-dead_strip -Wl,-w \
    -framework AVFoundation -framework CoreAudio -framework AudioToolbox -framework CoreVideo \
    -framework CoreFoundation -framework CoreMedia -framework Metal -framework VideoToolbox \
    -framework QuartzCore -framework IOSurface -framework UIKit -framework Foundation -framework Security \
    -framework CoreGraphics -framework CoreText -framework OpenGLES \
    -lbz2 -liconv -lexpat -lresolv -lxml2 -lz -lc++
  strip -x "$out"
}

framework() { # <dir> <binary> <platform>
  local fw="$1/Libmpv.framework"
  rm -rf "$fw"; mkdir -p "$fw/Headers" "$fw/Modules"
  cp "$2" "$fw/Libmpv"
  cp -R "$STATIC/Libmpv.xcframework/ios-arm64/Libmpv.framework/Headers/." "$fw/Headers/"
  cat > "$fw/Modules/module.modulemap" <<'MAP'
framework module Libmpv [system] {
    umbrella "."
    export *
}
MAP
  cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Libmpv</string>
  <key>CFBundleIdentifier</key><string>io.mpv.libmpv</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Libmpv</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$TAG</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$3</string></array>
  <key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict></plist>
PLIST
}

rm -rf "$WORK/device" "$WORK/sim"; mkdir -p "$WORK/device" "$WORK/sim"
link ios-arm64 iphoneos arm64 "arm64-apple-ios$MIN_IOS" "$WORK/device.dylib"
framework "$WORK/device" "$WORK/device.dylib" iPhoneOS

SIM_SLICE=ios-arm64_x86_64-simulator
link "$SIM_SLICE" iphonesimulator arm64 "arm64-apple-ios$MIN_IOS-simulator" "$WORK/sim-arm64.dylib"
if [[ "${SIM_X86:-0}" == "1" ]]; then
  link "$SIM_SLICE" iphonesimulator x86_64 "x86_64-apple-ios$MIN_IOS-simulator" "$WORK/sim-x86.dylib"
  lipo -create "$WORK/sim-arm64.dylib" "$WORK/sim-x86.dylib" -output "$WORK/sim.dylib"
else
  cp "$WORK/sim-arm64.dylib" "$WORK/sim.dylib"
fi
framework "$WORK/sim" "$WORK/sim.dylib" iPhoneSimulator

rm -rf "$OUT"
xcodebuild -create-xcframework \
  -framework "$WORK/device/Libmpv.framework" \
  -framework "$WORK/sim/Libmpv.framework" \
  -output "$OUT" >/dev/null
echo "$TAG" > "$OUT/MPVKIT_VERSION"
echo "MPVKit $TAG (LGPL) -> $OUT"
ls -la "$WORK/device/Libmpv.framework/Libmpv"
