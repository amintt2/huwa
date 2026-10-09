// Android release build settings (sideload APK, see distribution/ANDROID.md and
// .github/workflows/release-android.yml).
//
// gradle.properties:
//  - android.minSdkVersion=29: react-native-bare-kit (P2P worklet) declares minSdk 29, the
//    manifest merger refuses an app below it (RN's default is 24).
//  - reactNativeArchitectures: arm64-v8a (phones), armeabi-v7a (old phones, TV boxes), x86_64
//    (emulators). No 32-bit x86: the torrent engine is not built for it.
//  - expo.useLegacyPackaging=true: native libraries are stored compressed in the APK. Bare's
//    libbare-kit.so alone is ~60 MB per ABI uncompressed; compressed it is a fraction of that,
//    which matters for a sideloaded download (the cost is extraction at install time).
//
// app/build.gradle:
//  - release signing from the environment: HUWA_KEYSTORE_FILE (path), HUWA_KEYSTORE_PASSWORD,
//    HUWA_KEY_ALIAS, HUWA_KEY_PASSWORD. Without HUWA_KEYSTORE_FILE the template's debug signing
//    stays (local `assembleRelease` keeps working). Secrets never touch the generated files.
//  - ABI splits: one APK per ABI + a universal APK; 32-bit x86 libraries (prebuilt by some
//    dependencies) are left out of every APK.
//  - dex compressed too (AGP stores it uncompressed from minSdk 28): smaller download, the
//    install extracts it once.
//
// Network security config (@xml/huwa_network_security_config, AndroidManifest application):
//  - release: cleartext refused everywhere EXCEPT loopback (127.0.0.1, localhost), where the
//    torrent engine's stream server and the HTTP proxy listen and the player (expo-video, OkHttp)
//    reads. Android's default since targetSdk 28 refuses cleartext to 127.0.0.1 too, which breaks
//    torrent playback. System CAs only (the default).
//  - debug (src/debug overlay): cleartext allowed (Metro on the LAN / 10.0.2.2): a
//    networkSecurityConfig makes the debug manifest's usesCleartextTraffic ignored.
//  - tools:replace: wins over a library's own config (rustls-platform-verifier's AAR sets one).
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withAppBuildGradle, withDangerousMod, withGradleProperties } = require('expo/config-plugins');

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const PROPS = {
  'android.minSdkVersion': '29',
  reactNativeArchitectures: ABIS.join(','),
  'expo.useLegacyPackaging': 'true',
};
const MARK = '// huwa-android-release';

function withProps(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key in PROPS));
    for (const [key, value] of Object.entries(PROPS)) cfg.modResults.push({ type: 'property', key, value });
    return cfg;
  });
}

const SIGNING = `
        ${MARK}: release key from the environment (CI), see plugins/with-android-release.js
        huwaRelease {
            def ks = System.getenv('HUWA_KEYSTORE_FILE')
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv('HUWA_KEYSTORE_PASSWORD')
                keyAlias System.getenv('HUWA_KEY_ALIAS')
                keyPassword System.getenv('HUWA_KEY_PASSWORD')
            }
        }`;

const SPLITS = `
    ${MARK}: one APK per ABI + a universal one
    splits {
        abi {
            enable true
            reset()
            include ${ABIS.map((a) => `'${a}'`).join(', ')}
            universalApk true
        }
    }
    packaging {
        jniLibs {
            // Drops the x86 copies of prebuilt libraries (libbare-kit.so alone is ~20 MB compressed).
            // React Native's own libs (libreactnative, libhermesvm, libjsi, libfbjni, libc++_shared)
            // stay in lib/x86 of the universal APK: RN's Gradle plugin marks them pickFirst, which
            // wins over excludes (~4 MB). 32-bit x86 devices are not supported either way.
            excludes += ['**/x86/*.so']
        }
        // minSdk >= 28 stores dex uncompressed by default (~60 MB here): compress it for download size.
        dex {
            useLegacyPackaging true
        }
    }
`;

function withBuildGradle(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') throw new Error('with-android-release: only a Groovy app/build.gradle is supported');
    let src = cfg.modResults.contents;
    if (src.includes(MARK)) return cfg;

    const fail = (what) => {
      throw new Error(`with-android-release: app/build.gradle template changed (${what}), update the plugin`);
    };

    if (!/signingConfigs\s*\{/.test(src)) fail('signingConfigs');
    src = src.replace(/signingConfigs\s*\{/, (m) => m + SIGNING);

    // The release build type: switch its signing config when a release key is provided.
    const release = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!release.test(src)) fail('buildTypes.release.signingConfig');
    src = src.replace(
      release,
      "$1signingConfig(System.getenv('HUWA_KEYSTORE_FILE') ? signingConfigs.huwaRelease : signingConfigs.debug)",
    );

    if (!/\n    packagingOptions\s*\{/.test(src)) fail('packagingOptions');
    src = src.replace(/\n    packagingOptions\s*\{/, (m) => SPLITS + m);

    cfg.modResults.contents = src;
    return cfg;
  });
}

const NSC = 'huwa_network_security_config';
const NSC_RELEASE = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by plugins/with-android-release.js. Cleartext only to the app's loopback servers. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
</network-security-config>
`;
const NSC_DEBUG = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by plugins/with-android-release.js. Debug build: cleartext allowed (Metro). -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;

function withNetworkSecurityFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src');
      for (const [variant, xml] of [['main', NSC_RELEASE], ['debug', NSC_DEBUG]]) {
        const dir = path.join(src, variant, 'res', 'xml');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${NSC}.xml`), xml);
      }
      return cfg;
    },
  ]);
}

function withNetworkSecurityManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
    const app = manifest.application?.[0];
    if (!app) throw new Error('with-android-release: no <application> in AndroidManifest.xml');
    const attr = 'android:networkSecurityConfig';
    app.$[attr] = `@xml/${NSC}`;
    const markers = (key) => (app.$[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const remove = markers('tools:remove').filter((a) => a !== attr);
    if (remove.length) app.$['tools:remove'] = remove.join(',');
    else delete app.$['tools:remove'];
    const replace = markers('tools:replace');
    if (!replace.includes(attr)) replace.push(attr);
    app.$['tools:replace'] = replace.join(',');
    return cfg;
  });
}

module.exports = (config) =>
  withNetworkSecurityManifest(withNetworkSecurityFiles(withBuildGradle(withProps(config))));
