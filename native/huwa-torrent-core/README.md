# huwa-torrent-core

Moteur torrent natif de Huwa (phase 7c du PLAN) : une session **librqbit 9.0.1** (Apache-2.0, épinglée
`=9.0.1`) + un serveur HTTP loopback maison (axum) servant `/{infoHash}/{fileIdx|auto}` avec `Range` /
`206` et `/stats.json`. Exposé à Expo par un C-ABI (iOS) et des exports JNI (Android), voir
`modules/huwa-torrent/`.

> **Non compilé sur la machine d'écriture** (pas de toolchain Rust). Le code a été écrit contre les sources
> réelles de rqbit `v9.0.1` (`crates/librqbit/src/{session,torrent_state/*}.rs`) mais les premières
> compilations révéleront sûrement des broutilles (imports, lifetimes). Les tests unitaires
> (`range.rs`, `priorities.rs`, `engine.rs`, `api.rs`, `ffi.rs`, `cache.rs`) tournent sur l'hôte :
> `scripts/build-torrent.sh test`.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `src/engine.rs` | Session librqbit (DHT + persistance JSON + fastresume, seeding **off** par défaut via la feature `disable-upload`), registre des torrents, `startStream` (résolution magnet en tâche de fond), statut, pause/reprise/suppression, quota de cache (éviction LRU des torrents inactifs), fichier `huwa-entries.json`. |
| `src/server.rs` | Routeur axum sur `127.0.0.1:<port aléatoire>`. Attend la résolution des métadonnées (504 après `resolveTimeoutSecs`), ouvre un `FileStream` librqbit, applique la politique de fenêtres, répond 200/206/416. |
| `src/priorities.rs` | Politique adaptée de `stream-server/enginefs/src/backend/priorities.rs` (MIT, en-tête conservé) : fenêtre de démarrage ≈ 4 Mio, fenêtres de seek, métadonnées de fin de conteneur (`moov`/Cues), clamps par octets/cache/pairs. librqbit n'ayant ni priorités de pièces ni deadlines, les bandes *Immediate* et *Metadata* sont matérialisées par des `FileStream` auxiliaires (leur file d'attente de 32 Mio est entrelacée avec celle du flux servi). |
| `src/range.rs` | Parsing RFC 9110 de `Range` (premier intervalle, suffixe, clamp, 416). |
| `src/cache.rs` | Taille récursive du dossier de données. |
| `src/api.rs` | Dispatch JSON `call(method, args)` commun aux deux FFI. |
| `src/ffi.rs` | C-ABI (`include/huwa_torrent.h`), `catch_unwind` à chaque frontière. |
| `src/jni_android.rs` | `Java_expo_modules_huwatorrent_HuwaTorrentNative_*`. |

Données : `<dataDir>/torrents/` (fichiers), `<dataDir>/session/` (état librqbit), `<dataDir>/dht.json`,
`<dataDir>/huwa-entries.json`.

## Compiler

```sh
# 1. toolchain (une fois)
brew install rustup && rustup-init -y            # ou curl https://sh.rustup.rs -sSf | sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo install cargo-ndk
export ANDROID_NDK_HOME=~/Library/Android/sdk/ndk/<version>

# 2. tests hôte
scripts/build-torrent.sh test

# 3. binaires (dist/ est ignoré par git)
scripts/build-torrent.sh ios       # dist/HuwaTorrentCore.xcframework
scripts/build-torrent.sh android   # dist/jniLibs/<abi>/libhuwa_torrent_core.so

# 4. app avec le moteur
HUWA_TORRENT=1 npx expo prebuild --clean
HUWA_TORRENT=1 npx expo run:ios      # ou run:android
```

Sans `HUWA_TORRENT=1` (ou sans binaires), le module Expo est compilé mais `isAvailable()` renvoie `false` :
l'app se construit et tourne sans Rust.

## Brancher dans le lecteur (point d'extension `resolveTorrent`)

`src/torrent/index.ts` exporte `resolveTorrent(stream)`. Ordre attendu dans le résolveur de flux
(agent addons/débrid) :

```ts
import { resolveTorrent } from '@/torrent';

// 1. Moteur natif si disponible ET activé par l'utilisateur (réglage « Téléchargements »),
//    l'avertissement légal est affiché à la première utilisation.
const native = await resolveTorrent(stream);        // { url, id } | null
if (native) return { uri: native.url };
// 2. Sinon débrid (TorBox / AllDebrid / Premiumize / Real-Debrid).
return resolveViaDebrid(stream);
```

`resolveTorrent` renvoie `null` proprement quand : lib non liée, moteur désactivé, refus de l'avertissement
légal, réglage « Wi-Fi seulement » actif sur réseau cellulaire, ou `stream.infoHash` absent. L'URL
retournée est lisible directement par `expo-video` (`player.replaceAsync({ uri })`).
