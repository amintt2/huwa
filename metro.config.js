// Metro configuration. Web only: native-only packages are swapped for browser seams
// (docs/WEB_DOCKER_PLAN.md, D1). iOS / Android resolve exactly as with the default config.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const WEB_ALIASES = {
  // localStorage (the package's web backend) caps at ~5 MB: catalogs and progress go to IndexedDB.
  '@react-native-async-storage/async-storage': path.resolve(__dirname, 'src/web/async-storage.ts'),
  // No Bare runtime in a browser; src/p2p/bare.web.ts already keeps the worklet out of the bundle.
  'react-native-bare-kit': path.resolve(__dirname, 'src/web/bare-kit.ts'),
  // `useWindowDimensions` = the area right of the web shell's rail (src/web/viewport.ts), so the
  // phone-sized screens lay out in the space they actually get. babel-preset-expo rewrites
  // `import { useWindowDimensions } from 'react-native'` to this react-native-web path.
  'react-native-web/dist/exports/useWindowDimensions': path.resolve(__dirname, 'src/web/use-window-dimensions.ts'),
  'react-native-web/dist/cjs/exports/useWindowDimensions': path.resolve(__dirname, 'src/web/use-window-dimensions.ts'),
  // The package index pulls the 19 icon fonts (5 MB of TTF in dist/); the app only uses Ionicons.
  '@expo/vector-icons': path.resolve(__dirname, 'src/web/vector-icons.ts'),
};

// Fonts: the TTFs of @expo-google-fonts (subtitle fonts, loaded on demand) and of Ionicons are
// swapped for WOFF2 copies in src/web/fonts (Latin/Greek/Cyrillic subsets, Japanese kept whole
// for M PLUS Rounded): 11 MB of TTF become 3.7 MB. Regenerate them when a font is added.
const FONTS_DIR = path.resolve(__dirname, 'src/web/fonts');
const fs = require('fs');
function webFont(context, moduleName) {
  let m = /^@expo-google-fonts\/[^/]+\/[^/]+\/([A-Za-z0-9_]+)\.ttf$/.exec(moduleName);
  if (!m && /[\\/]@expo[\\/]vector-icons[\\/]/.test(context.originModulePath)) m = /Fonts\/(Ionicons)\.ttf$/.exec(moduleName);
  if (!m) return null;
  const file = path.join(FONTS_DIR, `${m[1]}.woff2`);
  return fs.existsSync(file) ? file : null;
}
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, 'woff2'])];

const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    const alias = WEB_ALIASES[moduleName];
    // The shim itself must not resolve to itself (it imports nothing from the package anyway).
    if (alias && context.originModulePath !== alias) return { type: 'sourceFile', filePath: alias };
    const font = webFont(context, moduleName);
    if (font) return (upstream ?? context.resolveRequest)(context, font, platform);
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
