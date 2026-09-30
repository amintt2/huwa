# Architecture de Huwa

Huwa est une app Expo 57 / React Native 0.86 (Expo Router, React Compiler, expo-video) pour regarder des anime et lire les manhwa correspondants, avec un pont épisode ↔ chapitre. Règle fondatrice : **aucun serveur obligatoire, aucun contenu fourni**. Ce document décrit l'app, la couche P2P prévue, les services optionnels, les flux et la distribution. Le plan détaillé par phases est dans `PLAN.md`.

## 1. Vue d'ensemble

```
┌──────────────────────────── Appareil ────────────────────────────┐
│  UI (Expo Router, src/app)                                       │
│   ├─ data/      catalogue AniList (GraphQL public), pont, sorties │
│   ├─ store/     progression, commentaires (AsyncStorage)         │
│   ├─ addons/    protocole Stremio (ressource `stream`, HTTPS)    │
│   ├─ updates/   OTA signé : vérif. au lancement, écran           │
│   └─ p2p/       contrat P2P (interface `P2P`)                    │
│         │ RPC (bare-rpc sur worklet.IPC)                         │
│  Worklet Bare (react-native-bare-kit) — phase 1+                 │
│   Hypercore · Hyperswarm · Corestore · Autobase · Hyperbee       │
│   identité (clé racine + clés d'appareil), commentaires par      │
│   œuvre, MP chiffrés, journal signé                              │
└───────────┬───────────────────────────┬───────────────┬──────────┘
            │ HTTPS                     │ UDP (DHT)     │ HTTPS
   AniList, addons tiers,      pairs + services       serveur OTA
   débrid (clé de l'utilisateur)   optionnels          (xprem)
```

Deux implémentations du contrat `P2P` (`src/p2p/contract.ts`) : `local` (AsyncStorage, un appareil) aujourd'hui, `bare` (Holepunch) après le spike de la phase 1. L'UI ne touche jamais aux cores.

## 2. Application

| Module | Rôle | État |
|---|---|---|
| `src/app/` | Écrans (onglets, fiche anime/manhwa, lecteur, liseuse, commentaires en feuille) | livré |
| `src/data/anilist.ts` | Catalogue AniList, cache local | livré |
| `src/data/bridge.ts` | Estimation épisode ↔ chapitre (remplacée plus tard par un mapping communautaire signé) | livré |
| `src/addons/` | Addons Stremio saisis par l'utilisateur : `stream` HTTP/HLS uniquement | livré |
| `src/store/` | Progression et commentaires locaux | livré |
| `src/updates/` | OTA : `useUpdateCheck` + `UpdateAvailable` (voir §5) | livré, à monter dans `_layout.tsx` |
| `src/p2p/` | Contrat ; implémentation Bare | contrat livré |
| Torrent natif (`librqbit` + serveur Range loopback) | phase 7c, flag de build `HUWA_TORRENT` | à venir |

**Flags de build** (variables d'environnement lues au bundle, définies dans `eas.json`) :

- `HUWA_LITE=1` : version magasin, sans torrent ni addons préinstallés (il n'y en a de toute façon aucun).
- `HUWA_TORRENT=1` : moteur torrent compilé et activable (désactivé par défaut à l'exécution). Toujours `0` pour le profil `store`.

## 3. Couche P2P (cible)

- **Identité** : clé racine (phrase 24 mots) → clés d'appareil attestées ; sauvegarde système chiffrée, appairage par QR, révocation signée, pré-rotation à la KERI.
- **Commentaires** : un Autobase par œuvre (sujet = hash de l'ID AniList), `apply` déterministe, preuve de travail invisible, débit par writer, promotion writer automatique.
- **Modération** : labelers à la Bluesky ; le masquage est un filtre local, jamais une suppression dans `apply` ; listes de blocage signées empilables ; liste de l'éditeur abonnée par défaut (obligation UGC, voir `distribution/LEGAL.md`).
- **MP** : Noise en transport, X3DH + Double Ratchet, enveloppe à clé éphémère ; livraison hors-ligne via blind peer.
- **Rang** : journal signé rejoué localement ; EigenTrust à deux sauts ; pas de classement global.

Limites incompressibles : pas de socket P2P en arrière-plan iOS, pas de livraison garantie sans nœud toujours allumé, pas de notification iOS instantanée sans service détenant une clé APNs.

## 4. Services optionnels (`services/`)

Réponse à la « Décision à trancher » de `PLAN.md` : trois services minuscules **en option**, mode « Discret » par défaut, chaque utilisateur pouvant saisir ses propres relais. Un quatrième (OTA) sert la distribution.

| Service | Paquet vérifié | Ce qu'il voit | Sans lui |
|---|---|---|---|
| `bootstrap/` | `hyperdht@6.34.0` (`hyperdht --bootstrap --host <ip> --port 49737`) | IP:port des pairs, hashes de sujets | nœuds publics Holepunch |
| `blind-peer/` | `blind-peer-cli@1.15.1` (`blind-peer --storage --port --max-storage --push-gateway-key --trusted-peer`) | clés publiques, clés de découverte, tailles ; blocs chiffrés illisibles | MP seulement si les deux sont en ligne |
| `push-gateway/` | `blind-push-gateway-cli@0.2.0` (POC ; `run --config --storage`, **FCM uniquement** via `firebase-admin`, APNs via Firebase) | jeton push, horodatages | mode « Discret » |
| `ota/` | xprem (ex expo-open-ota) `ghcr.io/mercuretechnologies/xprem`, Postgres | plate-forme, runtimeVersion, canal, IP | pas d'OTA |

Chaque dossier : `docker-compose.yml`, `Dockerfile` ou image, `.env.example`, `README.md` (ce que le service voit, comment l'app le configure). Aucun secret commité.

## 5. Flux

### 5.1 Lecture d'un épisode

1. Fiche anime (AniList) → l'utilisateur choisit un addon (`src/addons/registry.ts`).
2. L'app interroge `/stream/series/<id>.json` de l'addon (HTTPS, timeout) et filtre les flux HTTP/HLS.
3. `expo-video` lit l'URL ; progression enregistrée localement puis, en P2P, dans le journal signé.
4. Plus tard : résolution débrid (clé API de l'utilisateur en SecureStore) et torrent natif (serveur loopback 127.0.0.1, 206 Partial Content).

### 5.2 Commentaire (P2P)

1. Saisie → PoW calculée en arrière-plan → message CBOR signé par la clé d'appareil.
2. Append dans l'Autobase de l'œuvre ; réplication via Hyperswarm (bootstrap public ou personnalisé).
3. Chaque pair rejoue `apply` ; les labels/blocs auxquels il est abonné filtrent l'affichage.

### 5.3 Message privé hors-ligne

Expéditeur → blocs chiffrés → blind peer (réplication) → ping opaque → passerelle push → FCM/APNs → « Nouveau message » → ouverture de l'app → synchro réelle depuis le blind peer.

### 5.4 Mise à jour OTA

1. Au lancement (`useUpdateCheck`, après les interactions initiales, au plus une fois par 6 h) : `checkForUpdateAsync()` → en-têtes `expo-runtime-version`, `expo-platform`, `expo-channel-name`, `expo-app-id`.
2. Le serveur choisit l'update du canal pour ce `runtimeVersion` (empreinte native calculée par `@expo/fingerprint`) et signe le manifeste avec la clé privée qu'il détient.
3. L'app vérifie la signature avec `certs/certificate.pem` embarqué (`codeSigningMetadata { keyid: main, alg: rsa-v1_5-sha256 }`), télécharge, puis affiche `UpdateAvailable` ; redémarrage à la demande, jamais forcé.
4. Changement natif → nouvelle empreinte → nouveau binaire obligatoire ; l'ancienne empreinte ne reçoit plus d'update incompatible.

Configuration figée dans le binaire (`app.json`) : `runtimeVersion.policy = fingerprint`, `updates.url = https://<hôte>/manifest`, `checkAutomatically = ON_ERROR_RECOVERY` (le contrôle est côté JS), certificat, en-têtes. `src/updates/config.ts` reflète l'hôte pour l'affichage et court-circuite la vérification tant qu'il n'est pas renseigné.

## 6. Distribution (`distribution/`, `eas.json`, `.github/workflows/`)

| Cible | Profil EAS | Artefact | Canal |
|---|---|---|---|
| Développement | `development` | dev client (APK debug, simulateur iOS), signature OTA désactivée | — |
| Android sideload (priorité) | `sideload-android` | APK, `credentialsSource: local` | GitHub Releases + Obtainium (+ IzzyOnDroid) ; `release-android.yml` construit par `expo prebuild` + Gradle, sans serveur EAS |
| iOS cercle proche | `adhoc-ios` | IPA Ad Hoc (`eas device:create`, 100 appareils/an) | lien EAS ou IPA |
| iOS UE/JP/BR | `altstore-ios` | build « store » notarisé | AltStore PAL (`altstore-source.json`, `marketplaceID`, ADP hébergé) |
| iOS ailleurs | `adhoc-ios` / IPA | IPA re-signé par SideStore/Sideloadly | `altstore-source.json` (Classic) |
| Magasins (option Lite) | `store` | AAB / IPA, `HUWA_LITE=1 HUWA_TORRENT=0`, `autoIncrement` | Play / App Store, sans en dépendre |

Contraintes vérifiées : vérification développeur Google obligatoire (régionale dès le 30/09/2026, mondiale 2027 ; enregistrer package + clé de signature), même clé de signature Android à vie, AltStore PAL 0 % + commission Apple 5 % uniquement sur ventes numériques (app gratuite : 0), comptes Apple gratuits limités à 3 apps / 7 jours pour le sideload.

CI (`ci.yml`) : `tsc --noEmit`, `expo lint`, `expo config --type public`, tests si un script `test` existe, empreinte runtime informative.

## 7. Sécurité et confidentialité

- Toute donnée venant d'un pair est non fiable : taille, schéma, signature vérifiés avant usage.
- Addons en HTTPS avec timeouts ; aucune exécution de code distant hors OTA signé.
- Pas de télémétrie, pas de compte ; journal local exportable.
- Secrets hors dépôt : clé privée OTA (`services/ota/keys/`), keystore Android, compte de service Firebase, `.env` des services. Le certificat public OTA est le seul fichier `.pem` commité (`.gitignore`).
- Clé OTA compromise = capacité de pousser du code : rotation prévue (nouveau certificat + nouveau binaire), clé maîtresse Postgres sauvegardée hors ligne.

## 8. Ce qui n'est pas encore décidé ou fait

- Spike Bare sur Expo 57 / RN 0.86 (phase 1) : non vérifié.
- OTA en P2P (Hyperdrive) pour les builds sideload : non implémenté ; HTTPS signé pour tous.
- Choix définitif entre xprem (tableau de bord, Postgres) et le serveur de référence Expo (plus simple, sans interface) : compose fourni pour xprem, script de clés compatible avec les deux.
- Torrent natif (`librqbit`) : mini-spike iOS/Android à faire avant engagement.
