# Huwa : présentation du produit

*Document joint à la déclaration de fourniture d'un moyen de cryptologie. Il tient lieu de plaquette commerciale : le produit est gratuit et n'a pas de brochure.*

## Identification

| Rubrique | Valeur |
|---|---|
| Nom commercial | **Huwa** |
| Version déclarée | 1.0.0 |
| Identifiant d'application | `com.amintt2.huwa` (iOS et Android) |
| Type de produit | Application mobile (logiciel), grand public |
| Plateformes | iOS / iPadOS 16.4 et ultérieur ; Android |
| Fournisseur | Tahar Touzi, développeur indépendant, personne physique établie en France |
| Prix | Gratuit, sans achat intégré, sans abonnement, sans publicité |
| Site | https://huwa.mciut.fr |

## Fonction de l'application

Huwa est une **bibliothèque personnelle d'anime et de manhwa** (bandes dessinées coréennes). Elle permet à l'utilisateur :

- de parcourir un catalogue public de **métadonnées** (titres, visuels, synopsis, calendrier de diffusion) fourni par le service tiers AniList ;
- de tenir des **listes** et de suivre sa **progression** (épisode vu, chapitre lu), et de faire le lien entre un épisode d'anime et le chapitre correspondant de l'œuvre d'origine ;
- de lire des vidéos ou des pages à partir de **sources que l'utilisateur ajoute lui-même** (extensions au format ouvert « addon », adresses de flux). L'application n'embarque aucune source, n'en propose pas de liste et n'héberge aucun contenu ;
- d'échanger avec d'autres utilisateurs : **commentaires** publics par œuvre et **messages privés** entre deux utilisateurs ;
- de **synchroniser** ses données entre ses propres appareils et de **récupérer son compte** sur un nouvel appareil.

Huwa ne fournit aucun contenu audiovisuel ni éditorial. L'éditeur n'exploite aucun serveur central de comptes. Il n'y a ni inscription, ni adresse e-mail, ni mot de passe, ni télémétrie.

## Architecture en bref

- **Identité sans serveur** : chaque utilisateur possède une paire de clés générée sur son appareil. Une phrase de récupération de 24 mots (standard BIP-39) permet de la reconstituer.
- **Couche sociale pair à pair** : commentaires, messages, listes et progression sont des journaux signés, répliqués directement entre les appareils des utilisateurs (pile logicielle libre « Holepunch » : Hypercore, Hyperswarm, Autobase).
- **Relais optionnel** : un ou plusieurs relais (« blind peers ») peuvent conserver une copie des journaux pour qu'ils restent disponibles quand les appareils sont hors ligne. Le contenu des messages privés y est chiffré de bout en bout.
- **Sauvegarde de la phrase de récupération** (iOS) : dans le Trousseau iCloud et, au choix de l'utilisateur, dans une clé d'accès (passkey) de son gestionnaire de mots de passe.
- **Lecteur** : lecteurs vidéo du système (AVPlayer, ExoPlayer) et, dans les versions distribuées hors App Store, un lecteur de secours (libmpv) et un moteur BitTorrent optionnel, désactivé par défaut, sans index ni source intégrés.

## Usage de la cryptographie (résumé)

La cryptographie sert uniquement à :

1. protéger la **confidentialité** des communications entre appareils (chiffrement du transport pair à pair) ;
2. protéger la **confidentialité** des messages privés entre utilisateurs et des sauvegardes de la phrase de récupération ;
3. garantir l'**authenticité et l'intégrité** des journaux signés (identité, commentaires, progression) ;
4. sécuriser les **connexions HTTPS** vers les services web (TLS).

Tous les algorithmes sont publics et standard (X25519/Ed25519, ChaCha20-Poly1305, XSalsa20-Poly1305, AES-256-GCM, BLAKE2b, SHA-2, HKDF, PBKDF2, TLS 1.2/1.3). Ils sont fournis par des bibliothèques libres reconnues (libsodium, rustls, GnuTLS) ou par le système d'exploitation (CryptoKit, Trousseau iOS, Android Keystore). Il n'y a **aucun algorithme propriétaire**. L'utilisateur **ne peut ni choisir, ni modifier, ni ajouter** d'algorithme, et il ne peut pas utiliser l'application pour chiffrer des fichiers ou des données arbitraires. Le détail figure dans la description technique jointe.

## Distribution

| Canal | Version | Contenu |
|---|---|---|
| App Store (Apple), dont la France | build « store » | Sans lecteur libmpv ni moteur BitTorrent |
| AltStore PAL (place de marché alternative, Union européenne) | build « complet » | Avec lecteur libmpv et moteur BitTorrent optionnel |
| Paquet IPA à installer soi-même (sideload) | build « complet » | Idem |
| Paquet APK Android (publié sur GitHub) | build « complet » | Moteur BitTorrent optionnel ; pas de libmpv sur Android |

La distribution est mondiale et gratuite. Aucun matériel n'est fourni.

## Public visé

Grand public, à partir de 16 ans. Usage personnel de loisir.
