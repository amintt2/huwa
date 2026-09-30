// Build flag for the native torrent engine (PLAN phase 7c).
//
//   HUWA_TORRENT=1 npx expo prebuild   → writes `huwa.torrent=1` to android/gradle.properties and
//                                        "huwa.torrent": "1" to ios/Podfile.properties.json.
//
// modules/huwa-torrent/ios/HuwaTorrent.podspec and modules/huwa-torrent/android/build.gradle read
// that property (or the env var directly at pod install / gradle time) and only then link the Rust
// library from native/huwa-torrent-core/dist. Without the flag the module still compiles and
// `isAvailable()` returns false, so the app runs without Rust.
const { withGradleProperties, withPodfileProperties } = require('expo/config-plugins');

const KEY = 'huwa.torrent';

function enabled() {
  return process.env.HUWA_TORRENT === '1';
}

function withTorrentGradleProperty(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === KEY));
    cfg.modResults.push({ type: 'property', key: KEY, value: enabled() ? '1' : '0' });
    return cfg;
  });
}

function withTorrentPodfileProperty(config) {
  return withPodfileProperties(config, (cfg) => {
    cfg.modResults[KEY] = enabled() ? '1' : '0';
    return cfg;
  });
}

module.exports = (config) => withTorrentPodfileProperty(withTorrentGradleProperty(config));
