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
};

const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    const alias = WEB_ALIASES[moduleName];
    // The shim itself must not resolve to itself (it imports nothing from the package anyway).
    if (alias && context.originModulePath !== alias) return { type: 'sourceFile', filePath: alias };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
