# services/ — les quatre services optionnels de Huwa

Huwa fonctionne sans aucun serveur (catalogue AniList en direct, données locales, P2P via nœuds publics). Ces services sont **optionnels, minuscules, sans état utile et remplaçables** ; chacun tient sur un VPS à ~5 €/mois (1 vCPU, 1–2 Go, Debian + Docker). Ils sont la réponse à la « Décision à trancher » de PLAN.md : proposés comme options, mode « Discret » par défaut, et chaque utilisateur peut pointer l'app vers ses propres relais.

| Dossier | Rôle | Sans lui | Voit | Ne voit jamais |
|---|---|---|---|---|
| `ota/` | Mises à jour JS signées (expo-updates, serveur xprem) | Pas de mise à jour sans réinstaller | plate-forme, runtimeVersion, canal, IP | identité, données utilisateur |
| `bootstrap/` | Nœud d'amorçage HyperDHT | Nœuds publics Holepunch | IP:port des pairs, hashes de sujets | contenu, clés |
| `blind-peer/` | Boîte aux lettres chiffrée pour les MP hors-ligne | MP livrés seulement si les deux sont en ligne | clés publiques, IP, clés de découverte des cores, tailles/fréquences | contenu des blocs (chiffrés), clés d'écriture |
| `push-gateway/` | Relais de pings opaques vers APNs/FCM (via Firebase) | Mode « Discret » (vérification périodique) | jeton push, horodatages | contenu, expéditeur |

Tous partagent le même principe : **métadonnées, jamais le contenu**. Aucun ne stocke de compte, de mot de passe ni de journal nominatif. Aucun n'est un point de passage obligé : l'app fonctionne si l'un tombe (dégradation : découverte plus lente, MP différés, notifications différées, pas d'OTA).

## Comment l'app les configure

- **OTA** : figé dans le binaire (`app.json` → `updates.url`, certificat, en-têtes). Non modifiable par l'utilisateur, par conception (règle magasin + sécurité).
- **bootstrap / blind-peer / push-gateway** : Réglages → Réseau / Messages / Notifications. Chaque champ accepte plusieurs entrées ; les valeurs par défaut (celles que vous hébergez) sont dans la config de l'app et remplaçables. Les clés se saisissent en z32 ou hex (`hypercore-id-encoding`), les bootstrap en `ip:port`.

## Ordre de déploiement conseillé

1. `ota/` dès la première version distribuée (indispensable pour corriger vite un bug JS chez des utilisateurs sideload).
2. `bootstrap/` avec le spike Bare (phase 1).
3. `blind-peer/` avec les MP (phase 5).
4. `push-gateway/` en dernier, seulement si le mode « Discret » ne suffit pas.

## Secrets

Aucun secret n'est commité : `.env` (git-ignoré, `.env.example` fourni), `services/ota/keys/`, `services/*/secrets/`, `services/*/data/`. Voir `.gitignore` à la racine.
