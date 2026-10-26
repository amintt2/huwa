Hello,

Thank you for the review. Huwa contains no obfuscated code, no selector mangling and no hidden features, and its concept does not change after approval. We have submitted build 1.0.2 (5), which removes the only part that could look obfuscated.

What the app contains:

- main.jsbundle: a standard React Native / Expo SDK 57 app compiled to Hermes bytecode, the Expo default. It is not obfuscated.
- The JavaScript runtime for manga reader extensions, which use the open Paperback extension format. It runs in a sandboxed iframe inside WKWebView. In build 4 our bundler (esbuild) minified this runtime. In build 5 it ships unminified, with the original names kept.
- A plain JavaScript bundle for the peer-to-peer layer (Holepunch Bare runtime).
- Native libraries: React Native / Expo frameworks, mpv (video playback), Bare, libsodium, RocksDB, and a Rust library for media streaming. These are standard compiler output.

How the app works: like Stremio, Huwa ships no content. Users add sources they choose themselves, in two kinds:
- video addons, which are HTTP JSON APIs in the open Stremio addon format;
- manga reader extensions, which are JavaScript run only in WebKit.

Sources only supply catalog entries and media links, which are shown in the app's existing screens. They do not add features or change what the app does. The app has no remote feature flags or server-controlled switches, and over-the-air updates are disabled.

Since nothing is obfuscated, there are no obfuscated selectors to index. The full source code is public at https://github.com/amintt2/huwa. The extension runtime is in src/manga-ext/runtime/ and its build script is scripts/build-paperback-runtime.mjs.

Thank you,
Tahar Touzi
