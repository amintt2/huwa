#!/usr/bin/env bash
# Builds native/huwa-torrent-core for iOS (xcframework) and Android (jniLibs).
#
# Usage:
#   scripts/build-torrent.sh            # both platforms
#   scripts/build-torrent.sh ios        # HuwaTorrentCore.xcframework
#   scripts/build-torrent.sh android    # dist/jniLibs/<abi>/libhuwa_torrent_core.so
#   scripts/build-torrent.sh test       # cargo test (host)
#
# One-time setup (not done by this script):
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # or brew install rustup
#   rustup toolchain install stable                                   # >= 1.89 (librqbit 9 is edition 2024)
#   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
#   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
#   cargo install cargo-ndk
#   # Android: export ANDROID_NDK_HOME=~/Library/Android/sdk/ndk/<version>
#   # iOS: Xcode + command line tools (xcodebuild, lipo)
#
# Outputs (git-ignored):
#   native/huwa-torrent-core/dist/HuwaTorrentCore.xcframework
#   native/huwa-torrent-core/dist/jniLibs/{arm64-v8a,armeabi-v7a,x86_64}/libhuwa_torrent_core.so
#
# Then build the app with the flag:  HUWA_TORRENT=1 npx expo prebuild --clean && HUWA_TORRENT=1 npx expo run:ios

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/native/huwa-torrent-core"
DIST="$CRATE/dist"
LIB="libhuwa_torrent_core"
MIN_IOS="${MIN_IOS:-16.4}"
ANDROID_API="${ANDROID_API:-24}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found. See the setup notes at the top of $0" >&2; exit 1; }; }

build_ios() {
  need cargo; need rustup; need xcodebuild; need lipo
  for t in aarch64-apple-ios aarch64-apple-ios-sim; do
    rustup target list --installed | grep -q "^$t\$" || { echo "error: run: rustup target add $t" >&2; exit 1; }
  done
  export IPHONEOS_DEPLOYMENT_TARGET="$MIN_IOS"

  echo "==> cargo build (iOS device, arm64)"
  (cd "$CRATE" && cargo build --release --lib --target aarch64-apple-ios)
  echo "==> cargo build (iOS simulator, arm64)"
  (cd "$CRATE" && cargo build --release --lib --target aarch64-apple-ios-sim)

  # Optional x86_64 simulator slice (Intel Macs): SIM_X86=1
  local sim_lib="$CRATE/target/aarch64-apple-ios-sim/release/$LIB.a"
  if [[ "${SIM_X86:-0}" == "1" ]]; then
    rustup target add x86_64-apple-ios
    (cd "$CRATE" && cargo build --release --lib --target x86_64-apple-ios)
    mkdir -p "$CRATE/target/universal-sim"
    lipo -create "$sim_lib" "$CRATE/target/x86_64-apple-ios/release/$LIB.a" \
      -output "$CRATE/target/universal-sim/$LIB.a"
    sim_lib="$CRATE/target/universal-sim/$LIB.a"
  fi

  echo "==> xcframework"
  rm -rf "$DIST/HuwaTorrentCore.xcframework"
  mkdir -p "$DIST"
  xcodebuild -create-xcframework \
    -library "$CRATE/target/aarch64-apple-ios/release/$LIB.a" -headers "$CRATE/include" \
    -library "$sim_lib" -headers "$CRATE/include" \
    -output "$DIST/HuwaTorrentCore.xcframework"
  echo "OK: $DIST/HuwaTorrentCore.xcframework"
}

build_android() {
  need cargo; need rustup; need cargo-ndk
  : "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to your NDK folder}"
  for t in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android; do
    rustup target list --installed | grep -q "^$t\$" || { echo "error: run: rustup target add $t" >&2; exit 1; }
  done
  echo "==> cargo ndk (arm64-v8a, armeabi-v7a, x86_64)"
  rm -rf "$DIST/jniLibs"
  mkdir -p "$DIST/jniLibs"
  (cd "$CRATE" && cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -P "$ANDROID_API" -o "$DIST/jniLibs" build --release --lib)
  echo "OK: $DIST/jniLibs"
  ls -la "$DIST/jniLibs"/*/
}

run_tests() {
  need cargo
  (cd "$CRATE" && cargo test --lib)
}

case "${1:-all}" in
  ios) build_ios ;;
  android) build_android ;;
  test) run_tests ;;
  all) build_ios; build_android ;;
  *) echo "usage: $0 [ios|android|test|all]" >&2; exit 2 ;;
esac
