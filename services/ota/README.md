# OTA — mises à jour JavaScript auto-hébergées (expo-updates)

Livre les mises à jour JS/assets aux builds sideload, Ad Hoc, AltStore et magasin sans passer par EAS Update. Le natif (Bare, libtorrent, nouvelle version d'Expo) exige toujours un nouvel APK/IPA : le `runtimeVersion` (empreinte native) change et le serveur ne propose l'update qu'aux binaires compatibles.

## Ce qui a été vérifié à la source

| Point | Source |
|---|---|
| `expo-open-ota` a été renommé **xprem** (`mercuretechnologies/xprem`, v3.2.5, MIT + `ee/` commercial) | `gh repo view axelmarciano/expo-open-ota` redirige |
| Image `ghcr.io/mercuretechnologies/xprem:latest`, port 3000, uid 100 / gid 101, `LOCAL_BUCKET_BASE_PATH` défaut `./updates` | `Dockerfile` du dépôt, docs « Docker image » |
| Variables : `BASE_URL`, `JWT_SECRET`, `DB_URL`, `DB_KEYS_MASTER_KEY_B64`, `STORAGE_MODE`, `LOCAL_BUCKET_BASE_PATH`, `CACHE_MODE`, `USE_DASHBOARD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `KEYS_STORAGE_TYPE`, `PRIVATE_LOCAL_EXPO_KEY_PATH`, `PUBLIC_LOCAL_EXPO_KEY_PATH` | `config/config.go`, docs « Environment variables », « Local key store », « Stateless mode » |
| `updates.url` = `${BASE_URL}/manifest` ; en-têtes `expo-channel-name`, `expo-app-id`, `xprem-branch` ; `codeSigningMetadata { keyid: 'main', alg: 'rsa-v1_5-sha256' }` | `eoas/dist/commands/init.js` (eoas 3.2.5) |
| Publication : `EOO_TOKEN=… RELEASE_CHANNEL=production npx eoas publish --branch production --nonInteractive` | docs « Publish an update » |
| Commandes de signature `npx expo-updates codesigning:generate` / `codesigning:configure` et leurs options | `npx expo-updates codesigning:generate --help` (expo-updates 57.0.24) |
| Serveur de référence Expo : `expo/custom-expo-updates-server` (`/api/manifest`, `/api/assets`, `PRIVATE_KEY_PATH`, arborescence `updates/<runtimeVersion>/<timestamp>/`) | README du dépôt |

## Choix : xprem en mode base de données

Un seul VPS (~5 €, 1 vCPU / 2 Go suffisent : le benchmark officiel tient 230 req/s sur un `c6g.medium`), deux conteneurs (xprem + Postgres), stockage local des bundles, tableau de bord pour les canaux, rollouts progressifs et rollback. Le mode « stateless » existe mais dépend d'un compte Expo (`EXPO_ACCESS_TOKEN`), ce qu'on évite.

Alternative minimale sans tableau de bord : le serveur de référence `expo/custom-expo-updates-server` (Next.js) avec les clés produites par `scripts/generate-keys.sh`.

## Mise en place (à faire par vous)

1. VPS Debian/Ubuntu avec Docker, un nom DNS `ota.example.org`, Caddy ou Traefik pour le TLS.
2. `cp .env.example .env`, remplir `BASE_URL`, `JWT_SECRET` (`openssl rand -hex 32`), `DB_KEYS_MASTER_KEY_B64` (`openssl rand -base64 32`), `POSTGRES_PASSWORD`, `ADMIN_*`.
3. `mkdir -p data/updates && sudo chown -R 100:101 data/updates && docker compose up -d`.
4. Tableau de bord `https://ota.example.org/dashboard` → créer l'app **Huwa** → page de l'app : télécharger le certificat (`app-<id>-certificate.txt`) → le copier dans `certs/certificate.pem` du projet et le **commiter**. Noter l'**ID de l'app** et créer une **clé d'API** (`EOO_TOKEN`).
5. Créer le canal `production` et la branche `production`, les associer.
6. Dans `app.json`, remplacer `https://OTA_HOST_A_RENSEIGNER/manifest` par `https://ota.example.org/manifest` et ajouter l'en-tête `"expo-app-id": "<id>"` à côté de `expo-channel-name` (`npx eoas init` le fait aussi, mais il réécrit la config sous forme d'expressions JS ; à la main c'est plus lisible).
7. **Nouveau build natif** (l'URL, le certificat et les en-têtes sont figés dans le binaire).
8. Publier : `EOO_TOKEN=… RELEASE_CHANNEL=production npx eoas publish --branch production --nonInteractive`. Le serveur signe le manifeste ; l'app refuse tout manifeste dont la signature ne correspond pas au certificat embarqué.

## Sauvegardes et rotation

- Sauvegarder `data/postgres` (contient les clés scellées) **et** `DB_KEYS_MASTER_KEY_B64` hors ligne. Sans la clé maîtresse, la base est illisible.
- Rotation du certificat = nouveau certificat dans `certs/`, nouveau build natif, ancienne clé conservée tant que d'anciens binaires circulent (ils ne pourront recevoir que des updates signées avec l'ancienne clé). Prévoir la rotation avant l'expiration (10 ans par défaut dans le script).
- Le `runtimeVersion` est calculé par `@expo/fingerprint` (`npx expo-updates fingerprint:generate --platform android|ios`). Un build local et un build CI doivent produire la même empreinte : mêmes versions de dépendances (`npm ci`), même `app.json`.

## Côté app

- `src/updates/` : vérification au lancement (`checkForUpdateAsync`), téléchargement en tâche de fond, écran « Mise à jour disponible » avec redémarrage à la demande. `checkAutomatically: ON_ERROR_RECOVERY` laisse ce contrôle à l'app plutôt qu'au chargement natif.
- Le serveur ne voit que : plate-forme, `runtimeVersion`, canal, ID d'update courant, adresse IP. Aucun identifiant utilisateur.
- Les builds magasin (« Lite ») utilisent le même serveur : l'OTA HTTPS signé est autorisé par la règle 3.3.2 d'Apple tant que l'app ne change pas de nature. L'OTA P2P (Hyperdrive) évoqué dans PLAN.md reste réservé aux builds sideload et n'est pas implémenté ici.
