# huwa-mpv — moteur de lecture de secours (libmpv)

Le lecteur de Huwa reste **AVPlayer (iOS) / ExoPlayer (Android)** via `expo-video` : décodage
matériel, PiP, AirPlay, meilleure autonomie. Ce module fournit un 2e moteur, **libmpv**, utilisé
seulement pour ce que le moteur natif ne sait pas lire. La politique est dans
`src/components/player/engines/policy.ts` (testée), le choix/bascule dans `hybrid-player.ts`.

| Situation (réglage « Automatique ») | iOS | Android |
|---|---|---|
| MP4/MOV H.264, HEVC `hvc1`, HLS | AVPlayer | ExoPlayer |
| MKV, WebM, AVI, FLV, TS, Ogg, WMV, RM, DASH | **mpv** | ExoPlayer (sauf WMV/RM → mpv) |
| MP4 VP9 / VP8, HEVC `hev1` | **mpv** | ExoPlayer |
| AV1 | AVPlayer si `VTIsHardwareDecodeSupported(av01)`, sinon **mpv** (dav1d) | ExoPlayer |
| Le moteur natif échoue sur la source | **mpv**, même position | idem quand mpv sera branché |

Détection : extension de l'URL → `Content-Type` → 4 premiers Kio (requête `Range: bytes=0-4095`,
annulée si le serveur répond 200 ; résultat mis en cache par URL). Réglages → Lecture → « Moteur de
lecture : Automatique / Natif / mpv ». Un badge « mpv » s'affiche sous le lecteur et dans le menu
des sources, avec la raison et le décodage (matériel/logiciel).

## iOS

- `scripts/fetch-mpvkit.sh` télécharge les xcframeworks **LGPL** de
  [MPVKit](https://github.com/mpvkit/MPVKit) (tag `1.0.0` : mpv 0.41.0, FFmpeg n8.1.2 ; somme SHA-256
  vérifiée, les assets `-GPL` et Libsmbclient sont refusés) et les **lie en un seul framework
  dynamique** `ios/Libmpv.xcframework` (arm64 appareil + arm64 simulateur, `SIM_X86=1` pour Intel).
  Seule l'API `mpv_*` est exportée ; le reste est éliminé par `-dead_strip`.
- Le podspec ne lie mpv que si le framework est présent et que le drapeau n'est pas coupé
  (`HUWA_MPV=0`, ou build « Lite » `HUWA_LITE=1` → `plugins/with-huwa-mpv.js` écrit
  `huwa.mpv` dans `ios/Podfile.properties.json`). Sans lui, le module compile, `isAvailable()`
  vaut `false` et l'app reste sur AVPlayer.
- Rendu : `vo=gpu-next` (libplacebo) sur Vulkan/MoltenVK → `CAMetalLayer` dans la vue native.
  `hwdec=auto-safe` (VideoToolbox), `profile=fast` (scalers bilinéaires, pas de dithering ni
  d'interpolation), cache borné (`demuxer-max-bytes=48MiB`, `demuxer-max-back-bytes=16MiB`,
  20 s de lecture anticipée), progression à 4 Hz seulement pendant la lecture, pause + `vid=no`
  en arrière-plan. Sous-titres intégrés (ASS/SSA rendus par libass avec leur style, SRT, PGS),
  pistes audio, vitesse, volume, en-têtes HTTP (dont `User-Agent`).
- Pas de PiP ni d'AirPlay vidéo avec mpv (ce sont des fonctions d'AVPlayer).

Construire :

```sh
scripts/fetch-mpvkit.sh
LANG=en_US.UTF-8 npx expo prebuild -p ios
npx expo run:ios
```

## Mesures (simulateur iPhone 17 Pro, iOS 27, build Release, Mac Apple Silicon)

Taille ajoutée : `Libmpv.framework` = 28,4 Mo (arm64 appareil, strippé), ≈ 11,7 Mo compressé
(ordre de grandeur du surcoût de téléchargement de l'IPA). Le module Swift/JS est négligeable.

CPU moyen sur 30 s (`top`, échantillons de 2 s ; « appareil » = tous les processus du simulateur,
décodeurs VideoToolbox et serveur média compris), Sintel 1280×720 24 i/s, réglage Automatique :

| Cas | Moteur | App | Appareil |
|---|---|---|---|
| Accueil (référence) | — | 5,7 % | 6,5 % |
| MP4 H.264 | AVPlayer | 15,1 % | 21,6 % |
| Même flux H.264 remuxé en MKV | mpv (VideoToolbox) | 27,0 % | 41,8 % |
| MKV HEVC 10 bits + 2 pistes ASS | mpv (VideoToolbox + libass) | 40,4 % | 58,0 % |
| WebM VP9 | mpv (logiciel, pas de VP9 matériel sur iOS) | 30,5 % | 33,6 % |
| MKV HEVC en arrière-plan | mpv en pause, `vid=no` | 1,2 % | 2,1 % |
| Retour à l'accueil après mpv | libmpv détruit | 5,5 % | 6,5 % |

À flux égal, mpv coûte ≈ 2× AVPlayer sur le simulateur (rendu gpu-next via MoltenVK en plus du
décodage) : c'est pourquoi il n'est utilisé que lorsque AVPlayer ne sait pas lire. Le simulateur
n'est pas représentatif de la consommation réelle (GPU du Mac, pas de moteur vidéo d'iPhone) ; à
re-mesurer sur appareil avec Instruments (Energy Log).

## Licences (conformité LGPL)

Le code de ce module (Swift/Kotlin/TS) est MIT. `Libmpv.framework` embarque des bibliothèques
tierces, toutes dans leur variante **non GPL** :

| Composant | Licence |
|---|---|
| mpv / libmpv 0.41.0 (compilé `-Dgpl=false`) | LGPL-2.1+ |
| FFmpeg n8.1.2 (sans `--enable-gpl` ni `--enable-nonfree`) | LGPL-2.1+ |
| libplacebo, fribidi, gnutls, libbluray | LGPL-2.1+ |
| gmp, nettle/hogweed | LGPL-3.0+ (ou GPL-2.0+) |
| MPVKit (scripts de build) | LGPL-3.0 |
| libass | ISC · harfbuzz, lcms2, libdovi : MIT · freetype : FTL · libunibreak : zlib |
| MoltenVK, shaderc, OpenSSL 3 | Apache-2.0 |
| dav1d, uavs3d | BSD · uchardet : MPL-1.1 |

Ce que nous faisons pour respecter la LGPL :

1. **Liaison dynamique** : libmpv + FFmpeg sont dans `Huwa.app/Frameworks/Libmpv.framework`,
   un binaire séparé que l'on peut remplacer par sa propre compilation exportant la même API
   `mpv_*` (puis re-signer l'IPA, ce que font de toute façon SideStore/AltStore). L'app ne contient
   aucune copie statique de code LGPL.
2. **Mention** dans l'app (Réglages → Lecture → Moteur de lecture) avec lien vers les sources.
3. **Sources correspondantes** : MPVKit `1.0.0` (<https://github.com/mpvkit/MPVKit/tree/1.0.0>,
   scripts de build et versions exactes de chaque dépendance dans `Package.swift`), mpv
   (<https://github.com/mpv-player/mpv/tree/v0.41.0>), FFmpeg (<https://github.com/FFmpeg/FFmpeg/tree/n8.1.2>).
   Notre étape de liaison est entièrement décrite par `scripts/fetch-mpvkit.sh`.
4. Aucune restriction contractuelle à la modification ou à l'ingénierie inverse de ces bibliothèques.

Point d'attention : gmp et nettle sont LGPL-3.0 ; la LGPLv3 demande de pouvoir installer une
version modifiée sur l'appareil (« Installation Information »). C'est compatible avec la
distribution sideload (IPA re-signable) ; pour une version App Store, construire MPVKit sans
gnutls/gmp/nettle (FFmpeg utilise alors OpenSSL, Apache-2.0) ou ne pas embarquer mpv
(`HUWA_LITE=1` le coupe déjà).

## Android (non branché — plan précis)

Aujourd'hui : le module Android compile, `isAvailable()` renvoie `false`, la vue est un
rectangle noir jamais affiché ; la politique garde ExoPlayer, qui lit déjà MKV/WebM/TS/AVI/FLV.
Le besoin résiduel est donc plus faible que sur iOS : WMV/RM, style ASS complet (ExoPlayer ne rend
qu'un sous-ensemble SSA), codecs que MediaCodec refuse, et le repli sur erreur.

Pour le brancher :

1. **libmpv** : compiler avec les `buildscripts/` de [mpv-android](https://github.com/mpv-android/mpv-android)
   (MIT pour l'app et les scripts) en **désactivant le GPL** : mpv `-Dgpl=false`, FFmpeg sans
   `--enable-gpl`, sans x264/x265/rubberband/libsmbclient. Vérifier dans le log de configuration
   que `gpl` est `false` et que FFmpeg annonce « LGPL version 2.1 or later ». Livrer
   `libmpv.so`, `libavcodec.so`… par ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`) dans
   `modules/huwa-mpv/android/dist/jniLibs/` (git-ignoré), ajoutés à `jniLibs.srcDirs` par
   `build.gradle` quand `huwa.mpv=1` (même schéma que `modules/huwa-torrent`). Les `.so` séparés
   satisfont la liaison dynamique LGPL.
2. **JNI** : reprendre `MPVLib.java` + `jni/*.cpp` de mpv-android (MIT) : `create`, `setOptionString`,
   `init`, `attachSurface(Surface)`, `command`, `setPropertyString`, `observeProperty`, callbacks
   `eventProperty`/`event`.
3. **Vue** : `HuwaMpvView : ExpoView` contenant une `SurfaceView` ; `surfaceCreated` →
   `attachSurface` + `vo=gpu` `gpu-context=android` ; `surfaceDestroyed` → `vid=no` puis
   `detachSurface`. Options : `hwdec=mediacodec,mediacodec-copy` (zéro copie quand possible),
   `profile=fast`, mêmes bornes de cache qu'iOS, `ao=audiotrack,opensles`. Pause dans `onHostPause`.
4. **API** : mêmes noms qu'iOS (`load`, `setPaused`, `seek`, `setSpeed`, `setVolume`,
   `setAudioTrack`, `setSubtitleTrack`, `stop` ; événements `onLoaded`, `onProgress`,
   `onStateChange`, `onTracks`, `onEnd`, `onMpvError`) : le JS (`engines/`) n'a rien à changer.
   `hardwareDecoders()` : `MediaCodecList(REGULAR_CODECS)` en filtrant `isHardwareAccelerated`.
5. Taille : compter ~20–30 Mo par ABI ; publier en AAB ou APK par ABI (`splits.abi`).
