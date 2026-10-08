# Huwa 1.0.0 : demande de classement « grand public »

*Note jointe à la déclaration (rubrique « Tout autre document que vous jugez utile »). Elle demande que le moyen soit reconnu comme relevant de la **catégorie 3 de l'annexe 2 du décret n° 2007-663 du 2 mai 2007**, et justifie les trois conditions de ce point.*

Fournisseur : Tahar Touzi (particulier, France). Moyen : **Huwa**, version 1.0.0, logiciel, `com.amintt2.huwa`.

## Contexte

Huwa est distribué gratuitement et partout dans le monde par des magasins d'applications (App Store d'Apple, place de marché AltStore PAL dans l'Union européenne) et par téléchargement direct (IPA, APK). Le fournisseur demande donc :

- le récépissé ou l'attestation de déclaration de **fourniture** en France (article 3, 1°, du décret) ;
- dans la mesure où la même déclaration couvre le **transfert vers les États membres de l'Union européenne** et l'**exportation** (annexe 2, A, catégorie 1), la reconnaissance du statut « grand public » (annexe 2, B, catégorie 3), au vu des éléments ci-dessous.

## Condition a) Couramment à la disposition du public, sans restriction, par transaction électronique

- L'application est publiée sans restriction d'accès sur l'App Store d'Apple, sur la place de marché alternative AltStore PAL, et sous forme de paquets téléchargeables (IPA, APK publiés sur GitHub).
- Elle est gratuite, sans achat intégré ni abonnement. N'importe qui peut l'installer, sans contrat, sans licence et sans vérification d'identité.
- Elle vise le grand public (loisir : bibliothèque d'anime et de manhwa). Elle n'est pas conçue pour des administrations, des opérateurs ou des clients professionnels.

## Condition b) La fonctionnalité cryptographique ne peut pas être modifiée facilement par l'utilisateur

- Les algorithmes, les tailles de clés et les protocoles sont figés dans le code compilé. Aucun réglage, fichier de configuration ou interface de programmation ne permet de les changer.
- L'utilisateur peut seulement activer ou désactiver certaines fonctions (sauvegarde dans le Trousseau iCloud, clé d'accès, relais, moteur BitTorrent dans les versions hors App Store). Il ne peut pas toucher aux mécanismes cryptographiques.
- Les extensions qu'il ajoute sont des sources de contenu (catalogues, liens). Elles n'ont pas accès aux fonctions cryptographiques.
- L'application ne permet pas de chiffrer des fichiers ou des données arbitraires.
- Sur iOS, le binaire est signé, et sa modification invalide la signature. Sur l'App Store et AltStore PAL, il est aussi soumis au contrôle d'Apple.

## Condition c) Installation par l'utilisateur sans assistance ultérieure importante du fournisseur

- L'installation est celle de n'importe quelle application mobile : un geste dans le magasin d'applications, ou l'ouverture du paquet téléchargé.
- La configuration se fait dans l'application : un pseudonyme, puis la sauvegarde facultative de la phrase de récupération. Il n'y a ni serveur à installer, ni clé à injecter, ni activation par le fournisseur.
- Le fournisseur n'apporte aucune assistance d'installation et n'exploite aucun service indispensable au fonctionnement cryptographique. Les clés sont générées sur l'appareil.

## Référence

Algorithmes et bibliothèques : voir la description technique jointe. Résumé : X25519 / Ed25519, ChaCha20-Poly1305, XSalsa20-Poly1305, AES-256-GCM, BLAKE2b, SHA-2, HKDF, PBKDF2, TLS 1.2 / 1.3. Aucun algorithme propriétaire.
