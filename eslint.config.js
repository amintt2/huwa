// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "src/p2p/worklet.bundle.js", "src/manga-ext/runtime/runtime.bundle.js"],
  }
]);
