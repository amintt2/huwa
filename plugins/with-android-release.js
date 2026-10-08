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
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

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
            excludes += ['x86/**', '/x86/**', 'lib/x86/**', '/lib/x86/**', '**/x86/*.so']
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

module.exports = (config) => withBuildGradle(withProps(config));
