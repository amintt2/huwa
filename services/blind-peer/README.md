# blind-peer — boîte aux lettres chiffrée toujours allumée

Livre les messages privés quand le destinataire est hors-ligne : l'expéditeur pousse les blocs (chiffrés de bout en bout, voir PLAN.md phase 5) vers le blind peer, qui les réplique au destinataire à sa prochaine connexion. Il ne possède ni la clé de déchiffrement ni la clé d'écriture des cores.

## Vérifié à la source

- npm : `blind-peer@3.15.1` (bibliothèque), `blind-peer-cli@1.15.1` (binaires `blind-peer`, `blind-peer-bare`), `blind-peering@2.10.0` (client côté app, « Request blind peers to keep hypercores and autobases available »). Dépôts `holepunchto/*`.
- `bin.js` du CLI : options listées dans `docker-compose.yml`. Notables : `--push-gateway-key` (relais des notifications vers `services/push-gateway`), `--trusted-peer`, `--max-storage`, `--control-socket` + sous-commande `readiness-probe` (sonde de santé).
- Au démarrage il journalise `publicKey` et `encryptionPublicKey` (pino/ndjson) : c'est la clé à saisir dans l'app.

## Déploiement

```sh
cp .env.example .env
docker compose up -d --build
sudo ufw allow 49738/udp
docker compose logs blind-peer | grep '"Listening"'   # → publicKey à donner aux utilisateurs
```

Sauvegarder `./data` : la paire de clés du service en dérive ; la perdre change la clé publique que les apps ont enregistrée.

## Ce que ce service voit

- Clé publique Hyperswarm de chaque pair qui se connecte, son IP, les clés de découverte des cores qu'il demande de garder, la taille et la fréquence des blocs.
- Il **ne peut pas lire** les blocs (chiffrement Hypercore + enveloppe X3DH/Double Ratchet côté app) ni forger des blocs (signature du writer).
- Il peut déduire *qui écrit à qui* en corrélant les cores : c'est pourquoi l'enveloppe côté app utilise une clé éphémère par message (gift wrap) et pourquoi chacun peut choisir ses propres blind peers.

## Côté app

Réglages → Messages → « Relais hors-ligne » : coller la `publicKey`. L'app utilise `blind-peering` pour demander la réplication de son core de messages et de ceux de ses conversations. Sans blind peer : les MP ne partent que si les deux appareils sont en ligne simultanément.
