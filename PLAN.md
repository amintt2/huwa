# Huwa — plan consolidé (v2)

État actuel : Expo 57 / RN 0.86, catalogue AniList, pont épisode↔chapitre, lecteur (expo-video), commentaires et progression **locaux**, addons de flux Stremio (HTTP/HLS uniquement, ressource `stream`).

Ce plan intègre six recherches (MP, modération/rang, identité, torrent, distribution, faisabilité Bare). Les affirmations viennent des rapports des sous-agents ; celles marquées ⚠ sont à vérifier pendant le spike.

## 0. Principes et décisions d'architecture

| Sujet | Choix | Note |
|---|---|---|
| P2P | Modules Holepunch (Hypercore, Hyperswarm, Corestore, Autobase, Hyperbee) dans un **worklet Bare** via `react-native-bare-kit` | La CLI `pear` est desktop ; on réutilise ses briques |
| Frontière UI ↔ P2P | RPC `bare-rpc` sur `worklet.IPC`. L'UI ne touche jamais aux cores | Un crash non capturé du worklet tue l'app : handlers `uncaughtException` / `unhandledRejection` dès le démarrage |
| Identité | Clé racine (`keet-identity-key`) + **clés d'appareil attestées** + sauvegardes superposées | §Phase 2 |
| Flux | HTTP direct → **débrid** (rapide) → **libtorrent natif** (plus tard) | Débrid d'abord, il règle la majorité des cas sans code natif |
| Distribution | Sideload / marketplaces alternatifs d'abord, magasins en option « Lite » | §Phase 9 |
| Règle « zéro serveur » | **Assouplie de façon explicite et optionnelle** pour trois services minuscules, remplaçables et sans état : nœud bootstrap DHT, *blind peer*, passerelle push | Sans eux : pas de MP hors-ligne fiables ni de notifs iOS instantanées. Voir « Décision à trancher » |

### Limites incompressibles
- Pas de livraison garantie sans au moins un nœud toujours allumé.
- Pas de notification iOS instantanée sans service détenant la clé APNs.
- Pas de socket P2P en arrière-plan sur iOS (Bare : `suspend`/`wakeup`).
- Pas de preuve qu'un épisode a été vu, pas d'éradication d'un faux compte patient, pas de classement global fiable.
- Clé perdue sans aucune sauvegarde ni autre appareil = compte perdu.
- Torrent : illégal pour du contenu protégé dans de nombreux pays. L'app ne fournit aucune source.

## Phase 1 — Spike Bare (1–2 jours, sur une copie du projet)
Verdict de recherche : faisable, risque modéré. `react-native-bare-kit@0.15.6` est un TurboModule sans config plugin (autolinking + `pod install`). L'exemple officiel `bare-expo` tourne sur Expo 55 / RN 0.83 ; **Expo 57 / RN 0.86 est non vérifié** ⚠.

```sh
cp -R app /tmp/huwa-spike && cd /tmp/huwa-spike
npm i react-native-bare-kit bare-rpc b4a hyperswarm corestore autobase hyperbee
npm i -D bare-pack
npx bare-pack --preset ios --linked --out src/p2p/worklet.bundle.js src/p2p/worklet.js
cd ios && pod install && cd .. && npx expo run:ios --configuration Release
```
Les dépendances P2P doivent être dans le `package.json` de l'app (le linking natif les parcourt). Un bundle de test de 2 Mo a déjà été produit dans le scratchpad de l'agent.

**Critères de réussite :** build Release OK ; démarrage worklet < 500 ms ; put/get Hyperbee via RPC ; sync Autobase entre 2 appareils < 10 s (Wi-Fi et 4G) ; erreur volontaire sans crash de l'app ; RSS worklet < 80 Mo ; 20 cycles arrière/avant-plan sans crash ; surcoût IPA < 25 Mo (estimation : +40 Mo installé, 15–20 Mo téléchargé) ; fonctionne avec un bootstrap auto-hébergé seul.

**Risques connus :** holepunch qui échoue souvent derrière CGNAT / NAT symétrique (prévoir un relais) ; pic mémoire RocksDB pouvant déclencher jetsam (`memoryLimit`).
**Plan B si le spike échoue :** Nostr comme repli asynchrone (relais publics ou auto-hébergés) ; js-libp2p ; Yjs + WebRTC. À écarter : nodejs-mobile (Node 18 en fin de vie, incompatible nouvelle archi), `@hyperswarm/dht-relay` (déconseillé en production).
**Bootstrap DHT :** 3 nœuds publics par défaut ; option `bootstrap: [...]` pour une liste communautaire configurable ; nœud persistant via `hyperdht --bootstrap` (petit VPS).

## Phase 2 — Identité, profil, récupération
Modèle : **clé racine** (phrase 24 mots, `keet-identity-key`) → **clés d'appareil attestées** (`IdentityKey.bootstrap`, `attestDevice`). Les pairs vérifient la chaîne d'attestation jusqu'à l'ID public. La racine peut être effacée de l'appareil après enrôlement.

**Récupération, de la moins gênante à la plus robuste :**
1. Sauvegarde système chiffrée, par défaut : trousseau iCloud (`kSecAttrSynchronizable`, petit module natif car `expo-secure-store` ne l'expose pas) / Android Block Store. Option : passkey avec extension PRF pour chiffrer la graine.
2. Phrase de récupération, proposée après les premiers usages avec vérification de 3 mots (pas à l'inscription).
3. Appairage d'un autre appareil par QR (`blind-pairing`) → devient writer du journal personnel.
4. Récupération sociale (Shamir/SLIP-39, 3–5 amis) : **v2**, l'UX est difficile.

**Indice de compte iCloud :** à côté de la phrase, un item synchronisable `account-hint` (`{ name, fingerprint, savedAt, passkeyAt? }`, aucun secret) permet à l'accueil d'un nouvel iPhone d'afficher « Continuer en tant que <pseudo> ». Écrit avec la phrase, rafraîchi quand le pseudo change.

**Clé d'accès (passkey) qui transporte le compte** (`modules/huwa-passkey`, `src/p2p/passkey-core.ts`) : sans serveur, la passkey ne sert pas à s'authentifier mais protège un *largeBlob* (iOS 17+) contenant la phrase. Avec PRF (iOS 18+, si le gestionnaire le gère) la phrase est chiffrée en AES-256-GCM (clé = HKDF-SHA256 de la sortie PRF, sel PRF = sha256("huwa-passkey-v1"), `enc: "prf-aes256gcm"`) ; sinon elle est stockée telle quelle (`enc: "none"`), le blob étant chiffré de bout en bout par le gestionnaire et libéré seulement après Face ID. Création : 1 enregistrement + 1 assertion d'écriture (+1 assertion si PRF non évalué à la création). Connexion : 1 assertion (lecture + PRF) puis restauration par phrase.
- Domaine (relying party) `huwa.mciut.fr` : `site/.well-known/apple-app-site-association` (`webcredentials`) servi en `application/json` sans redirection (`site/nginx.conf`, `site/Dockerfile`) ; entitlement `webcredentials:huwa.mciut.fr` ajouté par `plugins/with-passkeys.js` (`HUWA_PASSKEYS=0` pour le retirer). L'App ID doit avoir la capacité Associated Domains.
- Android : pas encore (module absent → « Bientôt disponible »). `site/.well-known/assetlinks.json` est prêt mais son empreinte `TODO_ANDROID_RELEASE_CERT_SHA256` doit être remplacée par le SHA-256 du certificat de signature release (`keytool -list -v -keystore …` ou Play Console → Intégrité de l'app) avant d'utiliser Credential Manager.

**UX :** « J'ai déjà un compte » → restauration iCloud/Google en un tap → scanner depuis l'autre appareil → phrase → amis. Réglages → Sécurité : état des sauvegardes, appareils liés, « révoquer ».
**Vol / compromission :** `remove-device` signé dans le journal d'identité ; si la racine est compromise, rotation via journal de succession chaîné, avec **pré-rotation** à la KERI (engagement sur le hash de la prochaine clé).
**Homonymes :** affichage `pseudo · empreinte courte`, surnoms locaux (petnames) prioritaires, lien `huwa://u/<clé>` et QR.
**Journal d'identité :** Hyperbee/Autobase personnel avec événements `inception`, `add-device`, `remove-device`, `rotate`, `profile`.
**Migration :** la paire locale actuelle devient la première clé d'appareil ; commentaires et historique locaux rattachés via la preuve.
Profil public signé : pseudo, avatar, bio, badges, ancienneté. Suivre / bloquer / signaler.

## Phase 3 — Commentaires P2P (Autobase par œuvre)
Un Autobase par œuvre (topic = hash de l'ID AniList) ; cibles `ep:`, `ch:`, `series:` déjà modélisées dans `store.ts`.

**Idée centrale :** `apply` est le seul « serveur » : réducteur pur et déterministe (pas d'horloge, réseau ni global). Toutes les règles ci-dessous n'utilisent que le contenu des nœuds, leur ordre linéarisé et l'état de la vue.

**Anti-spam sans captcha :**
- Preuve de travail invisible : `nonce` tel que `blake2b(message)` ait N bits nuls, calculée en arrière-plan pendant la saisie (≈ 0,3–1 s sur mobile). Éviter Argon2 (trop de RAM).
- Difficulté dégressive : forte pour une clé inconnue, plus faible après ~5 messages acceptés, réduite avec un `vouch` d'un writer établi (invitation par QR/lien).
- Débit déterministe : `ts` déclaré croissant par writer ; rejet si trop de messages par heure ou intervalle < 15 s.
- Promotion writer automatique au premier message valide (`optimistic`) ; indexers = quelques nœuds volontaires par œuvre.
**Format unifié (CBOR) :** `{ v, t: comment|label|block|vouch|xp, work, target?, body?, ts, prev, nonce }`. La signature Hypercore authentifie l'auteur.
Réponses, likes (un par clé), spoilers, ancrage temporel : le type `Comment` actuel migre presque tel quel. Import des commentaires locaux existants.

## Phase 4 — Modération décentralisée
Modèle des *labelers* Bluesky : chacun publie dans son core des enregistrements `label` et `block` ; l'utilisateur **s'abonne** aux listes de son choix et elles s'empilent (comme les policy lists Matrix).
- Règle par défaut : si 2 de mes abonnements bloquent A et que je ne suis pas A, A est masqué.
- Le masquage est un **filtre local**, jamais une suppression dans `apply` (reste déterministe et non censurant).
- Filtres de mots locaux, signalement, blocage d'utilisateur.
- **Option semi-autorité (opt-in par œuvre)** si le spam explose : indexers de confiance qui appellent `removeWriter` dans `apply` selon une règle publique.
- Conformité UGC pour les magasins : signalement/blocage, CGU, procédure DMCA, traitement sous 24 h via liste de blocage signée.

## Phase 5 — Messages privés
- **Transport :** Noise (`@hyperswarm/secret-stream`). **Messages hors-ligne :** X3DH + **Double Ratchet** ; minimum acceptable : boîte scellée X25519 par message. Enveloppe façon gift wrap Nostr (clé éphémère par message : le relais ignore l'expéditeur). MLS : trop lourd.
- Un Autobase par paire de contacts, topic dérivé des deux clés publiques.
- **Livraison hors-ligne : blind peers Holepunch** (`blind-peering`, `blind-peer`) : nœuds toujours allumés qui répliquent des blocs qu'ils ne peuvent pas lire. Aucun blind peer public documenté : héberger le nôtre (petit VPS) et permettre d'en ajouter dans les réglages.
- **Notifications :**
  - *Instantané (option)* : `blind-push-gateway` (Keet l'utilise en prod) relaie un ping opaque vers APNs/FCM. Sur iOS, une Notification Service Extension affiche un texte générique ; la synchro complète se fait à l'ouverture.
  - *Discret (par défaut recommandé si l'on veut zéro service push)* : `BGAppRefreshTask` iOS + notification locale ; Android WorkManager (~15 min) ou UnifiedPush/ntfy (optionnel).
  - Écran de réglage clair : ce que voit chaque relais (jeton, IP, fréquence ; métadonnées côté blind peer, jamais le contenu).
- UI : conversations, non-lus, demandes de message (opt-in), blocage.
- Ce qui reste impossible : socket Hyperswarm ouvert en arrière-plan iOS ; worklet complet dans la NSE.

## Phase 6 — Rang, historique, réputation
- **Journal signé** dans le core personnel : `{type: ep|ch|comment|streak, work, unit, ts, prev}` chaîné par hash. Chaque pair rejoue le journal avec les mêmes règles : le rang affiché est celui **recalculé par le lecteur**.
- Anti-triche réaliste : plafonds de plausibilité (écart ≥ 20 min entre épisodes, ≤ 30/jour), XP quotidienne plafonnée, bonus d'ancienneté de clé, PoW par entrée.
- **Réputation :** EigenTrust local à 2 sauts depuis soi + abonnements ; les votes de clés non reliées pèsent ~0 (les faux comptes deviennent invisibles hors de leur cercle).
- **Succès :** fonction pure `badges(journal)`.
- **Classements :** « top de mes abonnements », « top des pairs vus sur cette œuvre », et attestations optionnelles d'un service de classement auquel on s'abonne. Pas de top global.
- Historique : visionnage/lecture (local aujourd'hui) + timeline de profil ; synchro multi-appareils via le core privé.

## Phase 7 — Flux : addons, débrid, torrent
**7a. Addons complets (rapide)** : ressources `catalog`, `meta`, `subtitles`, `addon_catalog` ; page Découvrir multi-sources ; **mapping d'IDs AniList ↔ Kitsu/MAL/IMDb** (indispensable : la plupart des addons anime attendent `kitsu:`) ; ordre de priorité, source par défaut, fallback automatique, qualité préférée ; configuration d'addon ; addons publiables en `pear://` (Hyperdrive).
**7b. Débrid (livrable rapide, aucun code natif)** : écran « Résolveur », clé API TorBox / AllDebrid / Premiumize / Real-Debrid dans SecureStore, injectée dans la config d'addon (style Torrentio) ou résolution côté app (`addMagnet` → `selectFiles` → `unrestrict/link`). Résultat : les flux « cached » deviennent des URL HTTPS lisibles par expo-video sur iOS et Android. Coût pour l'utilisateur ≈ 3–10 €/mois. Real-Debrid est devenu moins fiable pour les addons Stremio ; les trois autres sont plus sûrs.
**7c. Moteur torrent natif (après le débrid)** : audit du dépôt `stream-server` (Rust, MIT) fait sur le code.
- **Verdict : ne pas l'embarquer tel quel.** Son seul backend fonctionnel est libtorrent (le mode `librqbit` ne compile pas seul). Android est déjà couvert par son JNI, mais **iOS n'existe pas** (pas de cible iOS, `build.rs` desktop, dépendances desktop non isolées) et son HLS/transcodage lance `ffmpeg`, impossible sur iOS. Un seul mainteneur, releases v0.1.x, issue de sécurité ouverte (SSRF du proxy). On réutilise seulement sa **politique de priorités de pièces** (`priorities.rs`, MIT) comme référence : fenêtre de démarrage ~4 Mo, fenêtres de seek, lecture des métadonnées de fin de conteneur.
- **Choix retenu : `librqbit` (Rust, Apache-2.0) + petit serveur Range maison**, un seul code pour iOS et Android, exposé par un module Expo (uniffi ou C-ABI, Swift/Kotlin). `FileStream` fournit lecture + seek avec lookahead de 32 Mo. Pure Rust (rustls), cross-compilation simple (`cargo build --target aarch64-apple-ios`, `cargo ndk`). Limite : pas de « deadlines » de pièces, à compenser avec la politique de priorités ci-dessus. Effort estimé : 3–4 semaines.
- **Repli Android** si besoin : le JNI de `stream-server` est éprouvé, mais deux moteurs différents = double dette.
- Serveur loopback 127.0.0.1 (206 Partial Content) → expo-video. API : `addMagnet`, `listFiles`, `selectFile`, `getStreamUrl`, événements `status`, `pause/resume/remove`. Sous-titres sidecar servis par le même serveur. Lecture directe uniquement : pas de transcodage.
- Réglages : Wi-Fi seulement, quota disque, cache de pièces borné (64–128 Mo), purge LRU, seeding désactivé. Écran Téléchargements. iOS : suspension en arrière-plan sauf lecture active.
- Activé par un **flag de build** : absent des builds magasin.
- **Écarté :** WebTorrent/WebRTC, Hyperswarm, nodejs-mobile, `server.js` officiel (fermé), `stremio-service` (GPL-2.0), stremiox (GPL-3), libtorrent direct (deux implémentations de priorités à écrire, LibtorrentKit trop jeune), Skein (licence non commerciale). Aucune compilation croisée n'a été testée : à valider par un mini-spike `librqbit` sur iOS et Android avant de s'engager.
**Mitigation légale :** aucun contenu, index ni addon pré-rempli ; rappel de responsabilité à l'installation d'un addon et à la première lecture torrent ; torrent désactivé par défaut ; signalement/blocage d'addon ; procédure DMCA documentée.

## Phase 8 — Lecteur, manga, produit
- Lecteur : sous-titres (SRT/VTT, taille, langue), pistes audio, vitesse, saut d'intro/outro, épisode suivant auto, PiP, AirPlay/Cast.
- Manhwa via addons (pages), lecture verticale continue, téléchargement hors-ligne, reprise précise.
- **Fait** : sources manhwa/manga via les **extensions Paperback 0.8 et 0.9** (dépôts ajoutés par l'utilisateur, exécutées dans une WebView cachée, une iframe isolée par source). Voir `docs/PAPERBACK.md`.
- Pont épisode↔chapitre : mapping exact communautaire, signé et voté par les pairs (remplace l'estimation).
- Recherche et filtres, calendrier de sorties, notifications locales de nouveaux épisodes, listes perso, synchro AniList/MAL optionnelle, paramètres (langue, Wi-Fi seulement, cache, confidentialité, export/import), accessibilité, i18n FR/EN, onboarding, écrans d'erreur/hors-ligne.

## Packs d'extensions (format `huwaPack` v1)
Un pack est une liste d'extensions **créée et partagée par un utilisateur** (Extensions → « Partager mes extensions »), installée après un écran de confirmation. **Huwa ne fournit, n'héberge, ne liste ni ne recommande aucun pack.** Code : `src/packs/format.ts` (format, validation, liens — testé), `src/packs/secrets.ts` (détection des liens personnels — testé), `src/packs/install.ts`, écrans `src/app/pack.tsx` et `src/app/pack-create.tsx`, site `site/pack.html` + `site/pack-lib.js` (mêmes règles en JS).

```json
{
  "huwaPack": 1,
  "name": "Mon pack",
  "description": "facultatif, 500 caractères max",
  "author": "facultatif, 60 caractères max",
  "video": [{ "manifest": "https://exemple.org/manifest.json", "name": "facultatif" }],
  "manga": [{ "repo": "https://exemple.org/extensions/versioning.json", "sources": ["SourceId"], "name": "facultatif" }]
}
```
- `huwaPack` : version du format (entier). Une version plus grande que celle connue est refusée avec « mets l'app à jour ».
- `video[].manifest` : manifest Stremio ; `manga[].repo` : dépôt Paperback (base ou `versioning.json`), `sources` = ids à installer (absent = ajouter le dépôt seul).
- **Validation stricte** : `http(s)` uniquement, pas d'hôte local (`localhost`, `127.*`, link-local) ni d'identifiants dans l'URL, URL ≤ 2048 caractères, 50 extensions max, 50 sources max par dépôt, ids de source `[A-Za-z0-9_.-]{1,64}`, textes nettoyés (caractères de contrôle et de direction) et tronqués (nom 80), champs inconnus ignorés, doublons fusionnés (URL canonique), JSON ≤ 64 Ko, pack vide refusé.
- **Lien qui contient le pack** (aucun serveur) : `d` = base64url du JSON minifié, ou `z` + base64url de son DEFLATE brut (`fflate` côté app, `CompressionStream('deflate-raw')` côté site) si plus court ; ≤ 48 Ko ; décompression bornée (anti-bombe).
  - App : `huwa://pack?d=<d>` ; web : `https://huwa.mciut.fr/pack.html#<d>` (fragment : jamais envoyé au serveur).
  - Pack hébergé : `huwa://pack?url=<URL du JSON encodée>` ou `https://huwa.mciut.fr/pack.html#url=<…>`.
- **Installation** : écran de confirmation obligatoire (nom, auteur, description, lignes cochables avec hôte et « déjà installé », rappel « Huwa ne fournit ni ne vérifie ces extensions… »), puis installation une par une avec résultat par ligne (installé, déjà installé, échec + raison) via les chemins habituels (`previewAddon`/`installAddon`, `addRepo`/`installSource`). Un addon déjà installé avec une autre URL (même id) n'est pas remplacé : la configuration de l'utilisateur est conservée.
- **Création** : addons installés (hors démo) et dépôts avec leurs sources installées. Les liens qui semblent personnels (clé débrid, `token`/`apikey`, JWT, UUID, config encodée en base64, long segment opaque, identifiants) sont **décochés par défaut** avec un avertissement. Partage : feuille de partage native (lien https), QR code si le lien fait ≤ 1200 caractères, lien `huwa://`, fichier JSON à héberger soi-même.
- **Onboarding (variante complète uniquement)** : « Tu as un pack ou un lien ? » (coller ou scanner un QR) ; le lien est ouvert sur son écran de confirmation à la fin de l'introduction. Build App Store : pas d'invite, mais les liens `huwa://pack` fonctionnent partout.

## Phase 9 — Distribution et mises à jour
Modèle suivi : Stremio (retiré de l'App Store iOS en janvier 2026, distribué depuis en IPA à installer soi-même). **Cœur sans contenu, addons saisis par l'utilisateur.**
- **Android (priorité)** : APK signé sur GitHub Releases, suivi par **Obtainium** ; IzzyOnDroid si le code est open source. Faire la **vérification développeur Google (25 $)** dès maintenant (obligatoire mondialement en 2027). **Même clé de signature à vie.**
- **iOS UE (et JP/BR)** : **AltStore PAL** (gratuit pour l'utilisateur ; compte Apple Developer payant + notarisation, qui porte sur la sécurité, pas le contenu). Une app gratuite sans achats n'est pas concernée par la commission de 5 %.
- **iOS ailleurs** : IPA publique pour SideStore / Sideloadly (3 apps max, renouvellement 7 jours ; SideStore renouvelle sur l'appareil) avec un fichier source AltStore ; Ad Hoc (100 appareils/an) pour le cercle proche. Exclure les comptes entreprise.
- **Magasins** : uniquement une version « Lite » (lecteur + commentaires, sans torrent ni addons préinstallés), sans en dépendre.
- **EAS** : profils `sideload-android` (APK), `adhoc-ios` (`distribution: internal`, `eas device:create`), `store` (AAB/IPA).
- **Mises à jour** : `expo-updates` auto-hébergé (expo-open-ota / xavia-ota) avec **manifestes signés** (`codeSigningCertificate`), `runtimeVersion: {policy: "fingerprint"}`. Le natif (libtorrent, Bare) exige un nouvel APK/IPA. OTA en P2P (Hyperdrive) : possible **uniquement pour les builds sideload**, avec signature obligatoire et repli HTTPS ; à exclure des builds magasin (règle 2.5.2 d'Apple). Clés OTA hors ligne, rotation prévue.
- Risques : notarisation refusée/révoquée, renouvellement sideload, durcissement Android 2027, responsabilité si promotion d'addons illégaux.

## Phase 10 — Qualité
Tests unitaires (protocole addons, réducteurs Autobase, calcul de rang, PoW), tests d'intégration P2P à 2–3 nœuds, e2e simulateur ; validation stricte de toute donnée pair (taille, schéma, signature) ; addons en HTTPS avec timeouts, aucune exécution de code distant hors OTA signé ; journal local exportable, pas de télémétrie.

## Ordre d'exécution
1. **Phase 1** (spike Bare) : décide si la stack P2P tient.
2. **7a + 7b** (mapping d'IDs, catalogues, débrid) : rend l'app réellement utilisable, sans dépendre du P2P.
3. **Phases 2 → 3 → 4** (identité, commentaires, modération).
4. **Phase 9** (APK + AltStore) en parallèle dès qu'il y a une version à distribuer.
5. **Phases 5, 6, 8**, puis **7c** (torrent natif) et **10** en continu.

## Décision à trancher : assouplir « zéro serveur » ?
| Composant | Sans lui | Avec lui |
|---|---|---|
| Bootstrap DHT | Nœuds publics Holepunch | Liste communautaire configurable |
| Blind peer | MP livrés seulement si les deux sont en ligne | MP hors-ligne chiffrés |
| Passerelle push | Mode « Discret » (vérification périodique) | Notifications iOS/Android instantanées |
Les trois sont minuscules, sans état, remplaçables et n'accèdent jamais au contenu. Recommandation : les proposer comme **options** avec le mode « Discret » par défaut, et laisser chacun ajouter ses propres relais.
