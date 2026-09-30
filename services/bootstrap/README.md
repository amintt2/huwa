# bootstrap — nœud d'amorçage HyperDHT

Point d'entrée dans la DHT Hyperswarm pour les pairs Huwa. Sans lui l'app utilise les nœuds publics Holepunch ; avec lui, une liste communautaire configurable (`bootstrap: [...]` dans le worklet Bare, voir PLAN.md phase 1).

## Vérifié à la source

`hyperdht@6.34.0`, fichier `bin.js` :

- `--bootstrap` sans valeur → mode bootstrap ; `--host <ip>` **obligatoire** (sinon `You need to specify --host <node ip>`) ; `--port` défaut **49737**.
- Le nœud appelle `HyperDHT.bootstrapper(port, host)` : c'est un nœud DHT persistant, sans stockage, sans état à sauvegarder.
- Le CLI est installé via `npm i -g hyperdht` (champ `bin` du paquet).

## Déploiement

```sh
cp .env.example .env      # PUBLIC_IP, PORT
docker compose up -d --build
sudo ufw allow 49737/udp
```

`network_mode: host` est nécessaire : la DHT annonce l'adresse `host:port` réelle et fait du hole-punching UDP ; un NAT Docker fausserait les deux.

## Ce que ce service voit

- Adresses IP:port des pairs qui s'y connectent et les identifiants de sujets (hash) qu'ils annoncent ou cherchent.
- **Jamais** : contenu des messages, commentaires, clés privées, ce que regarde l'utilisateur (les sujets sont des hashes d'ID AniList, donc *déductibles* par qui connaît le catalogue — c'est une limite connue de Hyperswarm, pas de ce service).

## Côté app

Adresse à saisir dans Réglages → Réseau → « Nœuds bootstrap » : `203.0.113.10:49737`. Plusieurs nœuds possibles ; les nœuds publics Holepunch restent en repli si aucun nœud personnalisé ne répond. Un seul nœud bootstrap = point de défaillance unique pour la *découverte* uniquement : les connexions déjà établies survivent à sa panne.
