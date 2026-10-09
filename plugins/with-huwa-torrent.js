// Build flag for the native torrent engine (PLAN phase 7c).
//
//   HUWA_TORRENT=1 npx expo prebuild   → writes `huwa.torrent=1` to android/gradle.properties and
//                                        "huwa.torrent": "1" to ios/Podfile.properties.json.
//
// modules/huwa-torrent/ios/HuwaTorrent.podspec and modules/huwa-torrent/android/build.gradle read
// that property (or the env var directly at pod install / gradle time) and only then link the Rust
// library from native/huwa-torrent-core/dist. Without the flag the module still compiles and
// `isAvailable()` returns false, so the app runs without Rust.
//
// Android, flag on: the engine's HTTPS stack needs the Kotlin half of rustls-platform-verifier
// (org.rustls:rustls-platform-verifier, added by modules/huwa-torrent/android/build.gradle).
//  - Its Maven repository goes into `android.extraMavenRepos`, which Expo autolinking adds to every
//    Gradle project (the app resolves the module's dependencies too).
//  - The library's manifest sets android:networkSecurityConfig. The app declares its own
//    (plugins/with-android-release.js: cleartext to loopback only in release) with tools:replace,
//    so the library's never applies; the verifier's revocation check is SOFT_FAIL anyway.
const { withGradleProperties, withPodfileProperties } = require('expo/config-plugins');

const KEY = 'huwa.torrent';
const MAVEN_REPOS_KEY = 'android.extraMavenRepos';
const RUSTLS_MAVEN = 'https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/';

function enabled() {
  return process.env.HUWA_TORRENT === '1';
}

function withTorrentGradleProperty(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === KEY));
    cfg.modResults.push({ type: 'property', key: KEY, value: enabled() ? '1' : '0' });
    if (enabled()) {
      const item = cfg.modResults.find((it) => it.type === 'property' && it.key === MAVEN_REPOS_KEY);
      let repos = [];
      try {
        repos = item ? JSON.parse(item.value) : [];
      } catch {
        repos = [];
      }
      if (!repos.some((r) => (typeof r === 'string' ? r : r?.url) === RUSTLS_MAVEN)) {
        repos.push({ url: RUSTLS_MAVEN });
      }
      if (item) item.value = JSON.stringify(repos);
      else cfg.modResults.push({ type: 'property', key: MAVEN_REPOS_KEY, value: JSON.stringify(repos) });
    }
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
