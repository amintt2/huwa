# push-gateway — notifications instantanées (option)

Relaie un ping **opaque** (« quelque chose t'attend ») vers APNs/FCM quand le blind peer reçoit un bloc pour un utilisateur hors-ligne. Le texte affiché est générique (« Nouveau message ») ; la synchro réelle se fait à l'ouverture de l'app. Sans ce service : mode « Discret » (rafraîchissement en arrière-plan périodique + notification locale).

## Vérifié à la source

- npm : `blind-push-gateway@1.0.0` et `blind-push-gateway-cli@0.2.0` (binaire `blind-push-gateway`), dépôts `holepunchto/*`. Les deux README portent la mention **POC** ; c'est pourtant ce que Keet utilise (`apnsTopic` par défaut `io.keet.app`).
- `bin.js` : sous-commande `run`, options `--config|-c`, `--storage|-s`, `--dry-run`, `--bootstrap <json>`, `--trusted-peer|-t`, `--dangerously-enable-inspector`, `--scraper-*`. Fichier de config : `certPath` (relatif au fichier de config), `notification { title, body }`, `apnsTopic`.
- `lib/fcm.js` : **firebase-admin uniquement** (`initializeApp({ credential: cert(certPath) })`, `getMessaging().send(message)`). Il n'y a pas de client APNs direct : **les notifications iOS transitent par FCM**, qui parle à APNs avec la clé `.p8` téléversée dans la console Firebase. Le dossier `secrets/` ne contient donc que `service-account.json`.
- Le service journalise `Public key: <z32>` au démarrage ; le blind peer le référence avec `--push-gateway-key`.

Correction par rapport au plan : il n'y a pas de « clé APNs montée en secret » côté conteneur ; la clé APNs vit dans Firebase.

## Déploiement

1. Projet Firebase gratuit (Spark) → Paramètres → Comptes de service → **Générer une clé privée** → `secrets/service-account.json` (git-ignoré, `chmod 600`).
2. Même console → Cloud Messaging → Apple : téléverser la clé APNs `.p8` (Apple Developer → Keys), Key ID, Team ID. Bundle `com.huwa.app`.
3. `docker compose up -d --build`, puis `docker compose logs push-gateway | grep 'Public key'`.
4. Donner cette clé au blind peer (`PUSH_GATEWAY_KEY` dans `services/blind-peer/.env`) et à l'app (Réglages → Notifications → « Passerelle push »).
5. Tester sans Firebase : `--dry-run` journalise les payloads au lieu de les envoyer.

Sauvegarder `./data` (la paire de clés du service en dérive).

## Ce que ce service voit

- Jeton push de l'appareil (APNs/FCM), plate-forme, horodatage et fréquence des pings, IP du blind peer émetteur.
- **Jamais** : contenu, expéditeur, clé de l'utilisateur. Google (FCM) et Apple (APNs) voient le jeton et la charge générique.
- Limites iOS : la Notification Service Extension ne peut pas faire tourner le worklet ; elle affiche un texte fixe. Le débit est plafonné côté blind peer (`--push-notifications-rate-limit-*`).

## Côté app

Écran de réglage explicite (PLAN.md phase 5) : « Instantané (passerelle) » vs « Discret (défaut) ». En mode instantané l'app enregistre son jeton push auprès du blind peer, chiffré pour la passerelle.
