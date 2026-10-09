# Déclaration relative à un moyen de cryptologie : réponses prêtes à saisir

Brouillon des réponses au formulaire en ligne **« Déclaration relative à un moyen de cryptologie »** (ANSSI, Bureau Contrôles Réglementaires), sur la plateforme demarche.numerique.gouv.fr.

- L'ordre et les intitulés des champs suivent le formulaire vierge officiel joint, `officiel/dossier_vide.pdf`, et sa notice, `officiel/260331_Notice_V3.pdf`.
- Les champs marqués **\*** sont obligatoires sur la plateforme.
- `[À RENSEIGNER : …]` signale une donnée personnelle que seul le déclarant peut fournir. Rien n'a été inventé.
- Le texte entre guillemets ou en bloc est à copier tel quel.

---

## Page d'accueil de la démarche

| Champ | Réponse |
|---|---|
| Pour qui faites-vous cette démarche ? | **Pour vous** (vous êtes le bénéficiaire de la déclaration) |

## Identité du demandeur (compte de la plateforme)

| Champ | Réponse |
|---|---|
| Email | [À RENSEIGNER : adresse e-mail du compte. C'est là qu'arriveront l'accusé de réception et l'attestation] |
| Civilité | M. |
| Nom | TOUZI |
| Prénom | Tahar |

---

## 1. Bénéficiaire

### Nature du bénéficiaire

- [ ] Le bénéficiaire est une personne morale (société, administration, association, etc.)
- [x] **Le bénéficiaire est un particulier**

### Personne morale

*Sans objet : ne pas remplir.* Pas de SIRET, de Kbis ni de document général présentant la société.

> **À vérifier par le déclarant** : si vous exercez sous un statut d'entrepreneur individuel (micro-entreprise avec un SIRET), l'ANSSI peut attendre une déclaration au nom de l'entreprise. Le projet n'en mentionne aucune (`distribution/LEGAL.md` § 5 laisse le choix ouvert) : ce brouillon part donc du cas « particulier ».

### Personne physique (le bénéficiaire est un particulier)

| Champ | Réponse |
|---|---|
| Civilité | M. |
| Nom | TOUZI |
| Prénoms | Tahar [À COMPLÉTER : tous les prénoms d'état civil, s'il y en a plusieurs] |
| Nationalité | [À RENSEIGNER] |
| Adresse | [À RENSEIGNER : numéro, rue, code postal, ville, France] |
| Numéro de téléphone | [À RENSEIGNER] |
| Adresse électronique | [À RENSEIGNER : de préférence la même que celle du compte] |

### Personne chargée des éléments techniques

Si le formulaire affiche cette question pour un particulier :

| Champ | Réponse |
|---|---|
| La personne chargée du dossier administratif est-elle également en charge des éléments techniques ? | **Oui** |

---

## 2. Moyen de cryptologie auquel s'applique la déclaration

### 2.1 Informations générales sur le moyen

| Champ | Réponse |
|---|---|
| Marque de distribution | Huwa |
| Dénomination du moyen \* | **Huwa** |
| Version | 1.0.0 |
| Référence commerciale | com.amintt2.huwa |
| Date de mise sur le marché | [À CONFIRMER : la version 1.0.0 figure dans la source AltStore datée du 30/09/2026 (`distribution/altstore-source.json`). Indiquez la date réelle de première mise à disposition du public ou, à défaut, la date prévue] |
| Le bénéficiaire est-il le fabricant du moyen de cryptologie ? | **Oui** |
| Dénomination d'origine / Nom du fabricant | *Sans objet* |

> La dénomination « Huwa » est celle qui figurera sur l'attestation. Elle doit correspondre au nom affiché sur l'App Store et dans App Store Connect.

### 2.2 Description fonctionnelle du moyen

**Classez le moyen dans la ou les catégories correspondantes**

- [ ] Matériel
- [x] **Logiciel**

**Description générale du moyen** (à copier) :

> Huwa est une application mobile grand public et gratuite pour iOS/iPadOS et Android (identifiant com.amintt2.huwa), éditée par un développeur indépendant. C'est une bibliothèque personnelle d'anime et de manhwa : consultation d'un catalogue public de métadonnées (AniList), listes et suivi de progression (épisodes vus, chapitres lus), lecture de vidéos et de pages à partir de sources que l'utilisateur ajoute lui-même (l'application ne fournit et n'héberge aucun contenu), commentaires publics par œuvre et messages privés entre utilisateurs, synchronisation entre les appareils d'un même utilisateur. Il n'y a ni compte sur un serveur central, ni mot de passe, ni télémétrie : l'identité est une paire de clés générée sur l'appareil, et les données sociales sont répliquées en pair à pair. L'application est distribuée sur l'App Store, sur la place de marché alternative AltStore PAL (Union européenne), en paquet IPA et en paquet APK.

**Catégorie de la fonction principale du moyen** (une seule valeur) :

- [ ] Sécurité de l'information
- [ ] Ordinateur
- [x] **Envoi, stockage, réception d'informations (terminal de communication, logiciel de gestion, etc.)**
- [ ] Réseau

> Choix recommandé. La fonction principale est une application de gestion de bibliothèque personnelle, avec échanges entre utilisateurs. Si la plateforme propose « Entrer une autre option » et que vous la jugez plus juste, utilisez : « Application mobile grand public de loisir (bibliothèque multimédia et suivi de lecture), avec messagerie entre utilisateurs ».

### 2.3 Description technique des services de cryptologie fournis

**Description des fonctionnalités cryptographiques du moyen** (à copier) :

> La cryptographie de Huwa sert uniquement à protéger les communications et les données de l'application ; elle ne permet pas à l'utilisateur de chiffrer des fichiers ou des données arbitraires, et ses algorithmes ne sont ni paramétrables ni modifiables.
> 1) Transport pair à pair : chiffrement de toutes les connexions entre appareils et avec les relais par le protocole Noise (motifs IK/XX, Diffie-Hellman sur Curve25519, ChaCha20-Poly1305, BLAKE2b), puis flux XChaCha20-Poly1305 (libsodium secretstream), clés de 256 bits.
> 2) Messages privés entre utilisateurs : chiffrement de bout en bout par « sealed box » libsodium (X25519 éphémère + XSalsa20-Poly1305, 256 bits) ; les relais ne stockent que du chiffré. Appairage d'un nouvel appareil : XChaCha20-Poly1305 et signatures Ed25519.
> 3) Authenticité et intégrité : journaux répliqués (Hypercore/Autobase) signés en Ed25519 avec arbres de Merkle BLAKE2b ; chaîne d'attestation identité → appareils en Ed25519.
> 4) Sauvegarde de la phrase de récupération : sur iOS 18 et ultérieur, dans une clé d'accès (passkey), chiffrée en AES-256-GCM (CryptoKit, système) avec une clé dérivée par HKDF-SHA-256 de la sortie PRF de WebAuthn ; copie dans le Trousseau iCloud et stockage local dans le Trousseau iOS / Android Keystore (chiffrement du système). Dérivation des clés depuis la phrase BIP-39 : PBKDF2-HMAC-SHA-512 et HMAC-SHA-512.
> 5) HTTPS : TLS 1.2/1.3 du système ; dans les versions distribuées hors App Store, clients TLS embarqués rustls/aws-lc-rs (moteur BitTorrent optionnel, sans chiffrement de protocole BitTorrent MSE/RC4) et GnuTLS (lecteur vidéo libmpv, iOS).
> Bibliothèques : libsodium 1.0.21, @noble/hashes 2.4.0, rustls 0.23.45 + aws-lc-rs 1.18.1, GnuTLS 3.8.11, et les services cryptographiques d'iOS et d'Android. Aucun algorithme propriétaire. Détail : description technique jointe.

**Catégories des fonctions cryptographiques** (plusieurs valeurs) :

- [x] **Authentification**
- [x] **Intégrité**
- [x] **Confidentialité**
- [x] **Signature**

**Protocoles sécurisés utilisés** (plusieurs valeurs) :

- [ ] IPsec
- [ ] SSH
- [ ] Protocoles liés à la VoIP (SIP/RTP)
- [x] **SSL/TLS**
- [x] **Autre(s)**

**Autres protocoles, à préciser** (à copier) :

> Noise Protocol Framework (Noise_IK et Noise_XX, Ed25519/Curve25519, ChaChaPoly, BLAKE2b) pour le transport pair à pair (bibliothèques Holepunch : HyperDHT, Hyperswarm, secret-stream), suivi du flux libsodium crypto_secretstream_xchacha20poly1305 ; libsodium crypto_box_seal pour les messages privés ; WebAuthn / FIDO2 (clés d'accès, extensions PRF et largeBlob) pour la sauvegarde de la phrase de récupération. Le protocole BitTorrent est utilisé sans chiffrement (MSE/PE non implémenté).

### 2.4 Les algorithmes cryptographiques utilisés

Un bloc « Algorithme cryptographique » par ligne. Cliquez sur « Ajouter un élément pour "Algorithme cryptographique" » entre chaque ligne. Pour une taille de clé sans objet, la plateforme demande « NA ».

| # | Algorithme | Mode | Taille de clé associée | Fonction |
|---|---|---|---|---|
| 1 | XChaCha20-Poly1305 | AEAD, flux (libsodium secretstream) | 256 | Chiffrement du transport pair à pair |
| 2 | ChaCha20-Poly1305 | AEAD IETF | 256 | Chiffrement de la poignée de main Noise |
| 3 | XChaCha20-Poly1305 | AEAD IETF | 256 | Chiffrement des échanges d'appairage d'appareils |
| 4 | XSalsa20-Poly1305 | AEAD (crypto_box_seal) | 256 | Chiffrement de bout en bout des messages privés |
| 5 | X25519 (ECDH Curve25519) | Clé éphémère par message | 256 | Accord de clé pour les messages privés et le partage de clés entre appareils |
| 6 | ECDH Edwards25519 | Noise IK / XX | 256 | Accord de clé de session du transport pair à pair |
| 7 | Ed25519 | EdDSA | 256 | Signature des journaux, attestation d'identité et d'appareils, appairage |
| 8 | AES | GCM (nonce 96 bits, tag 128 bits) | 256 | Chiffrement de la sauvegarde de la phrase de récupération dans la clé d'accès (CryptoKit, système) |
| 9 | HKDF-SHA-256 | NA | 256 | Dérivation de la clé AES depuis la sortie PRF WebAuthn |
| 10 | PBKDF2-HMAC-SHA-512 | 2 048 itérations (BIP-39) | NA | Dérivation de la graine depuis la phrase de récupération |
| 11 | HMAC-SHA-512 | Dérivation hiérarchique | NA | Dérivation des clés d'identité et des clés de chiffrement des messages |
| 12 | BLAKE2b | Hachage (256/512 bits), HMAC | NA | Intégrité (arbres de Merkle), dérivation Noise, identifiants, preuve de travail anti-spam |
| 13 | AES | GCM | 128 / 256 | Chiffrement HTTPS (TLS 1.2/1.3 : système, rustls/aws-lc-rs, GnuTLS) |
| 14 | ChaCha20-Poly1305 | AEAD | 256 | Chiffrement HTTPS (TLS 1.2/1.3) |
| 15 | ECDHE (X25519, P-256, P-384) | NA | 256 / 384 | Accord de clé TLS |
| 16 | RSA | PKCS#1 v1.5 / PSS | 2048 et plus (selon le serveur) | Vérification des certificats et signatures serveur TLS ; vérification des mises à jour (désactivée en 1.0.0) |
| 17 | ECDSA (P-256, P-384) | NA | 256 / 384 | Vérification des certificats TLS ; signature des clés d'accès (gestionnaire de mots de passe, système) |
| 18 | SHA-256 / SHA-384 | Hachage | NA | TLS, sel PRF, identifiants |
| 19 | AES | CBC | 128 | Déchiffrement des segments vidéo HLS chiffrés (lecteur libmpv, iOS, versions hors App Store) |
| 20 | SHA-1 | Hachage | NA | Contrôle d'intégrité des morceaux BitTorrent (non sécuritaire ; versions hors App Store) |

> Si la plateforme limite le nombre de blocs, gardez les lignes 1 à 8 et 13 à 15, et indiquez dans le dernier bloc « Voir la description technique jointe, § 4 ».

---

## 3. Pièces à joindre

| Pièce | Fichier à déposer | Statut |
|---|---|---|
| Document général présentant la société | *Sans objet (particulier)* | — |
| Extrait Kbis | *Sans objet (particulier)* | — |
| **Brochure commerciale du moyen de cryptologie** | `presentation-produit.pdf` | Obligatoire |
| **Brochure technique du moyen de cryptologie** (datasheet) | `description-technique.pdf` | Obligatoire |
| Manuel utilisateur | Rien, ou une capture du guide de l'app si vous en avez un | Facultatif |
| Guide administrateur | *Sans objet* | Facultatif |
| **Attestation relative aux informations fournies dans le formulaire** | Modèle officiel téléchargé **sur la plateforme**, rempli, daté et signé, puis numérisé en PDF (voir `attestation-brouillon.md` pour le contenu attendu) | Obligatoire |
| Tout autre document utile | `note-grand-public.pdf` (demande de classement « grand public », annexe 2, catégorie 3, pour la diffusion mondiale). Ne déposez pas de code source sans demande de l'ANSSI (article 7 du décret) | Recommandé |

Taille maximale par pièce : 200 Mo (notice V3).

---

## Données encore à fournir par le déclarant

1. Adresse e-mail du compte et du formulaire
2. Nationalité
3. Adresse postale complète
4. Numéro de téléphone
5. Prénoms d'état civil complets
6. Date de mise sur le marché (à confirmer)
7. Statut : particulier ou entrepreneur individuel avec SIRET (à confirmer)
8. Attestation signée (modèle de la plateforme)
