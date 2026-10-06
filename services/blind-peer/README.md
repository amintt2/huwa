# Relais Huwa (blind peer)

Pair Holepunch toujours allumé. L'app lui demande (bibliothèque `blind-peering`, voir `src/p2p/worklet/relay.js`) de garder :

| Priorité | Quoi | Pourquoi |
|---|---|---|
| 2 | core pointeur (possédé par la racine de la phrase) + base perso (tous ses writers + vue) | **restaurer un compte depuis la phrase quand le seul téléphone a été effacé** |
| 1 | bases de MP où l'on écrit | livrer un message en attente quand les deux ne sont jamais en ligne en même temps |
| 0 | salons publics ouverts (commentaires, correspondances, signalements), 48 par session max | garder les salons vivants quand peu de pairs sont en ligne |

Le relais ne s'annonce pas sur les sujets Hyperswarm : l'app s'y connecte directement par sa clé publique (HyperDHT). À la restauration, l'app lui demande le core pointeur pendant la même fenêtre que la recherche des appareils, avant de déclarer `RESTORE_NOT_FOUND`.

## Fichiers

- `server.js` : démarre `blind-peer@3.15.1` (bibliothèque, pas le CLI), applique la politique, sonde `GET /health` (port 8080, interne), écrit la clé publique dans `/data/public-key.txt` et dans les logs (`"msg":"Listening","publicKey":"…"`).
- `policy.js` : politique de stockage Huwa (ci-dessous).
- `Dockerfile`, `docker-compose.yaml`, `.env.example`.

## Stockage : ce que fait la bibliothèque, ce qu'ajoute Huwa

Vérifié dans `node_modules/blind-peer/index.js` et `lib/db.js` :

- **Natif** : un budget total (`MAX_STORAGE_MB`, 20 Go par défaut). Au-delà, le GC vide les blocs des cores dans l'ordre (priorité, dernière activité) ; l'entrée reste (un client qui revient renvoie les blocs). Priorités 0–2 demandables par n'importe quel client. Limite optionnelle de requêtes par base (`REFERRER_RATE_*`). Pas de quota par client, pas d'expiration.
- **Ajouté (`policy.js`)** :
  - quota par groupe (`GROUP_QUOTA_MB`, 50 Mo) : un groupe = la base (clé `referrer` : clé de l'Autobase ; l'app range aussi le pointeur sous sa base perso) ou le core seul. Au-delà, les cores du groupe sont vidés dans le même ordre que le GC natif ;
  - expiration (`MAX_IDLE_DAYS`, 120 j) : un core ni demandé ni répliqué depuis 120 jours est supprimé (blocs + entrée) ;
  - chaque requête d'un client rafraîchit la date d'activité (la bibliothèque ne le fait qu'en cas de transfert : un compte à jour qui se connecte serait sinon vu comme inactif).
- Limite connue : le quota est par base, pas par personne (une clé Hyperswarm est gratuite). Le budget total + le GC natif restent la borne dure.

## Déploiement sur Coolify (après fusion dans la branche déployée)

1. Coolify → projet → **+ New → Application → Public/Private repository** `amintt2/huwa`, branche fusionnée.
2. Build pack **Docker Compose**, *Base directory* `/services/blind-peer`, *Docker Compose location* `/docker-compose.yaml`.
3. Variables d'environnement : celles de `.env.example` (les défauts conviennent). Aucun secret.
4. Pas de domaine : le service ne sert pas de HTTP public. Le port `49738/udp` est publié par le compose.
5. **Pare-feu du serveur** : ouvrir `49738/udp` (`ufw allow 49738/udp` et la règle équivalente du fournisseur cloud). Sans ça, le relais reste joignable par hole-punching mais moins bien.
6. Persistance : `./data` (monté sur `/data`). Il contient la **paire de clés** : le sauvegarder ; le perdre change la clé publique des apps.
7. Déployer, puis lire la clé : logs `"msg":"Listening"` → `publicKey`, ou `cat data/public-key.txt` dans le dossier de l'application.
8. Santé : statut Docker *healthy* (sonde interne `GET http://127.0.0.1:8080/health` : clé, nombre de cores, octets, connexions).

Sans Coolify : `cp .env.example .env && docker compose up -d --build`. Sans Docker : `npm ci && STORAGE=./data node server.js`.

## Brancher l'app

- Clé par défaut : `HUWA_RELAY_KEYS=<publicKey>` au build (variable d'environnement EAS ou `eas.json` → `env`), ou `app.json` → `expo.extra.relayKeys: ["<publicKey>"]`. Lue par `src/p2p/relays.ts` via `extra.relayKeys` (`app.config.js`). Vide par défaut : sans clé, pas de relais.
- Utilisateur : Réglages → Sécurité → **Relais Huwa** (activer/désactiver, désactiver le relais par défaut, ajouter ses propres relais).

## Ce que voit le relais

- **Lisible** (comme par n'importe quel pair qui connaît la clé de la base, ce sont des données publiques du réseau Huwa) : profil (pseudo, bio, avatar), journal de progression (œuvre, épisode/chapitre, date), abonnements/blocages/signalements publics, liste des appareils liés et révocations, commentaires, correspondances, signalements. Aucun core Huwa n'est chiffré au niveau Hypercore : la base perso est lue par les autres utilisateurs (profil, journal, listes de blocage), la chiffrer casserait ces fonctions et les comptes existants.
- **Métadonnées seulement** pour les MP : le texte est scellé (X25519) pour le destinataire et l'expéditeur ; le relais voit qui écrit à qui (identités de la paire), les horodatages, la taille et les accusés de lecture.
- **Réseau** : IP et clé Hyperswarm de chaque appareil qui se connecte (en mémoire pour les compteurs anti-abus, pas journalisées), clés des cores demandés, tailles.
- **Jamais** : la phrase, la clé racine, les clés de signature des appareils, la clé de boîte (MP).
- Rétention : tant que le compte est actif ; 120 jours sans activité → supprimé. Quota 50 Mo par base, 20 Go au total.
