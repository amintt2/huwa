// Build flag for the mpv fallback engine (modules/huwa-mpv).
//
//   npx expo prebuild               → "huwa.mpv": "1" (default: linked if Libmpv.xcframework exists)
//   HUWA_MPV=0 npx expo prebuild    → "huwa.mpv": "0" (AVPlayer only, e.g. the store "Lite" build)
//
// modules/huwa-mpv/ios/HuwaMpv.podspec reads it from ios/Podfile.properties.json (or HUWA_MPV
// directly at pod install time). The framework itself comes from scripts/fetch-mpvkit.sh.
// Android: property written to gradle.properties for symmetry; libmpv is not wired there yet.
const { withGradleProperties, withPodfileProperties } = require('expo/config-plugins');

const KEY = 'huwa.mpv';
const enabled = () => process.env.HUWA_MPV !== '0' && process.env.HUWA_LITE !== '1';

module.exports = function withHuwaMpv(config) {
  config = withPodfileProperties(config, (cfg) => {
    cfg.modResults[KEY] = enabled() ? '1' : '0';
    return cfg;
  });
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === KEY));
    cfg.modResults.push({ type: 'property', key: KEY, value: enabled() ? '1' : '0' });
    return cfg;
  });
};
