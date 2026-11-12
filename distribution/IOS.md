# Distribution iOS — AltStore PAL, sideload, Ad Hoc

Modèle : Stremio, retiré de l'App Store en janvier 2026 et distribué depuis en IPA. Trois canaux, du plus large au plus restreint. Tous exigent un **compte Apple Developer Program** (99 $/an) sauf le sideload d'IPA non signé.

## État réel et règles (mis à jour le 2026-11-12)

À lire avant tout build ou toute soumission iOS. Ces points ont été oubliés une fois et ont coûté trois semaines.

- **Canal principal : AltStore PAL après notarisation Apple.** Pas l'App Store. La version App Store (`HUWA_LITE=1`) est une piste pour plus tard.
- **Type de vérification = Notarisation**, appelé **« Certification »** dans App Store Connect en français (Distribution → version → Vérification de l'app → Type de vérification). Il est déjà réglé sur la version ; le vérifier avant chaque soumission. Avec ce réglage, `asc review submit` envoie une demande de notarisation.
- **Disponibilité App Store : 0 pays**, case « futurs pays » décochée (réglé le 2026-11-12).
- **AltStore PAL est déjà ajouté comme place de marché** depuis le 2026-09-30 (Utilisateurs et accès → Intégrations → Place de marché en ligne, Huwa coché, notifications activées). Ne pas refaire l'inscription.
- **Build envoyé = version complète** : `HUWA_TORRENT=1 HUWA_MPV=1`, sans `HUWA_LITE`. EAS n'est pas connecté sur le Mac : archive locale avec `xcodebuild`, export et envoi avec `asc xcode export` puis `asc builds upload --app 6817880554`. Penser à rattacher le build à la déclaration de chiffrement existante (`asc encryption declarations assign-builds`).
- **Réponse 2.5.19** (« code obscurci ») : `apple-review-reply-2.5.19.md`, à coller dans les notes pour le vérificateur à chaque nouvelle soumission.
- **Erreur PAL « couldn't be read because it isn't in the correct format »** : `site/altstore-source.json` pointe vers `https://huwa.mciut.fr/adp/1.0.0/manifest.json`, qui n'existe pas (le site renvoie `index.html`). Il n'y a pas d'ADP tant que l'app n'est pas notarisée. Après notarisation : récupérer l'ADP ID, le faire traiter par AltStore (`POST api.altstore.io/adps`), le télécharger, l'héberger **sans le modifier** sous `site/adp/<version>/`, puis mettre à jour l'entrée de version de la source (`version`, `buildVersion`, `downloadURL`, `size`).
- Historique : la 1.0.2 (build 5) est restée en attente de notarisation du 2026-10-26 au 2026-11-12 malgré une demande accélérée ; soumission annulée le 2026-11-12 pour renvoyer la 1.0.3 (build 6).

## A. AltStore PAL (UE, Japon, Brésil) — canal principal

Source vérifiée : `faq.altstore.io/developers/distribute-with-altstore-pal`, `/fees`, `/updating-apps`, `/make-a-source` (septembre 2026).

Ce qu'il faut savoir :

- AltStore PAL est une **place de marché alternative** au sens du DMA. Disponible pour les utilisateurs situés dans **l'UE, au Japon et au Brésil** ; le développeur peut être n'importe où.
- **Frais** : AltStore prend 0 %. Apple applique sa « Core Technology Commission » de **5 %** sur les *biens et services numériques* vendus ; une app **gratuite sans achats intégrés ne doit rien**, mais reste soumise aux obligations de déclaration Apple.
- L'app est **notarisée** par Apple (contrôle de sécurité/malware/intégrité, **pas** de revue éditoriale comme l'App Store). Une app sans contenu et sans addon préinstallé n'a pas de raison d'être refusée ; un moteur torrent embarqué n'est pas interdit par la notarisation mais fragilise la position (voir LEGAL.md) — le garder derrière le flag `HUWA_TORRENT` et absent des builds `store`.

Étapes réelles :

1. **App Store Connect** : créer l'app (bundle `com.amintt2.huwa`), remplir la fiche minimale (nom, confidentialité, âge).
2. **Enregistrer votre Developer ID auprès d'AltStore** via leur REST API (`faq.altstore.io/developers/rest-api`) : l'ID se trouve dans App Store Connect → *Edit Profile*. Vous recevez un **jeton de sécurité**.
3. App Store Connect → *Users and Access → Integrations → Marketplace* : ajouter le jeton AltStore et cocher l'app. Choisir **« Yes, send notifications »** pour qu'AltStore PAL traite automatiquement chaque build.
4. Construire avec `npx eas-cli build --platform ios --profile altstore-ios` (distribution `store`, signature App Store) puis **téléverser** le build (`eas submit -p ios --profile store` ou Transporter).
5. Soumettre le build à la **notarisation** dans App Store Connect (onglet de distribution alternative). Si l'app est aussi sur l'App Store, l'approbation vaut notarisation.
6. Récupérer l'**Alternative Distribution Package (ADP)** via la REST API AltStore et l'héberger **sans modifier `manifest.json`** ni l'arborescence, sur HTTPS (le même hôte que la source).
7. Dans `altstore-source.json` : renseigner `marketplaceID` (obligatoire pour PAL) et, dans la version, `downloadURL` = URL du `manifest.json` de l'ADP. Ajouter chaque nouvelle version **en tête** du tableau `versions` (AltStore compare `version`/`buildVersion`, pas la date).
8. Facultatif : fédérer la source (`fediUsername`) pour apparaître dans le catalogue AltStore.

## B. Sideload d'IPA (reste du monde) — SideStore / Sideloadly / AltStore Classic

- Exporter un IPA **signé développement ou non signé** : `npx eas-cli build --platform ios --profile adhoc-ios` produit un IPA Ad Hoc ; pour SideStore/Sideloadly, tout IPA convient car l'outil **re-signe** avec l'identifiant Apple de l'utilisateur (compte gratuit : **3 apps max, re-signature tous les 7 jours** ; SideStore renouvelle sur l'appareil, AltStore Classic via le Mac/PC, Sideloadly manuellement).
- Publier `Huwa-<version>.ipa` sur GitHub Releases et le référencer dans `altstore-source.json` (`downloadURL` = IPA, `size` en octets, `version`/`buildVersion` = `CFBundleShortVersionString`/`CFBundleVersion`).
- `appPermissions.entitlements` et `.privacy` doivent lister **tous** les entitlements et clés `NS*UsageDescription` de l'Info.plist (exigence AltStore) ; mettre à jour à chaque ajout natif (Bare, notifications…).
- Une seule source JSON sert PAL et Classic : les champs PAL (`marketplaceID`, `downloadURL` vers `manifest.json`) sont ignorés par Classic, et inversement. En pratique, faire **deux entrées de version** ou deux sources si les URL diffèrent.

## C. Ad Hoc (cercle proche, 100 appareils/an)

Source vérifiée : docs Expo « Internal distribution ».

1. `npx eas-cli device:create` → lien/QR à envoyer aux testeurs ; ils enregistrent leur UDID (profil de configuration).
2. `npx eas-cli build --platform ios --profile adhoc-ios` (profil `distribution: internal` d'`eas.json`) → EAS crée le profil de provisionnement Ad Hoc avec la liste des UDID **au moment du build** ; ajouter un appareil = rebuild (ou `--refresh-ad-hoc-provisioning-profile`).
3. Lien d'installation EAS ou IPA à distribuer. Limite Apple : 100 iPhone/an par compte.

Exclu : programme Enterprise (usage interne uniquement, révocations fréquentes).

## OTA sur iOS

Les trois canaux reçoivent les mises à jour JS signées du serveur `services/ota/`. Les changements natifs impliquent : nouveau build, nouvelle notarisation (PAL) ou nouvelle re-signature (sideload). Le `runtimeVersion` (empreinte) protège contre l'application d'une update incompatible.

## Risques

- Notarisation refusée ou **révoquée** a posteriori (Apple peut retirer une app pour raisons légales) : garder le canal B comme repli.
- Contrainte des 7 jours pour les comptes gratuits : documenter SideStore.
- Vérification d'âge / DSA : la source déclare `nsfw: false` ; le catalogue AniList filtre les titres adultes côté app (voir LEGAL.md).
