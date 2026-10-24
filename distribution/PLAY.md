# Distribution Android — Google Play

Compte développeur **personnel** (Tahar Amin Touzi, ID 4740102815330853560). Version publiée : la
**complète** (moteur torrent compris), comme l'APK, avec une seule différence : `HUWA_PLAY=1`
coupe la proposition d'APK GitHub (Play interdit qu'une app se mette à jour en dehors de Play).

## Build

Job `play` de `.github/workflows/release-android.yml` (tag `v*` ou lancement manuel) : artefact
`huwa-aab-<version>` → `Huwa-<version>-play.aab`. Jamais attaché à la Release GitHub.

- **Play App Signing, clé gérée par Google.** Notre clé de release (`scripts/android-keystore.sh`)
  ne sert que de clé d'importation. Conséquence : l'app Play et l'APK GitHub ont des signatures
  différentes ; passer de l'un à l'autre demande de désinstaller (la phrase de récupération P2P
  restaure le compte).
- `versionCode` : chaque AAB envoyé doit avoir un code plus grand que le précédent (`app.json`).

## Avant la production (compte personnel créé après novembre 2023)

1. Vérifications du compte : identité, appareil Android (appli Play Console sur un téléphone),
   numéro de téléphone.
2. **Test fermé** : au moins **12 testeurs inscrits pendant 14 jours d'affilée** (liste d'e-mails
   ou Google Group, lien d'inscription partagé sur le Discord).
3. Demande d'accès à la production depuis le tableau de bord (questionnaire sur le test).

## Fiche (fr-FR)

**Nom** : Huwa

**Description courte** (80 max) :
Anime et manhwa reliés : reprends l'histoire au bon chapitre, sans compte.

**Description complète** :

Fini l'anime ? Huwa te dit à quel chapitre reprendre le manhwa, et inversement.

Chaque épisode sait quels chapitres il adapte. Tu reprends l'histoire dans l'autre format au bon endroit, sans chercher.

TES SOURCES, TES RÈGLES
Huwa lit les vidéos depuis les addons que tu ajoutes toi-même (format d'addons ouvert, comme Stremio). Il lance la première source qui marche et passe à une meilleure qualité dès qu'elle arrive. L'épisode suivant est préchargé.

UN VRAI LECTEUR
Plein écran, sous-titres, pistes audio VO ou VF en un geste, vitesse, gestes volume et luminosité, commentaires horodatés par-dessus la vidéo.

LECTURE DE MANHWA
Défilement vertical ou page par page, zoom, reprise à la page près, chapitres hors ligne.

UNE COMMUNAUTÉ SANS SERVEUR
Commentaires, messages privés chiffrés et profil signés par ta clé, échangés directement entre fans.

CATALOGUE ET CALENDRIER
Saisons, tendances, recherche et sorties de la semaine, avec rappel pour les nouveaux épisodes.

PAS DE COMPTE, PAS DE PUB
Rien n'est collecté par défaut : les statistiques de lecture restent sur ton appareil, sauf si tu choisis d'en partager un résumé anonyme.

Huwa n'héberge, n'indexe ni ne recommande aucun contenu : les vidéos viennent uniquement des addons que tu installes, sous ta responsabilité.

**Catégorie** : Divertissement · **Coordonnées** : site https://huwa.mciut.fr
**Règles de confidentialité** : https://huwa.mciut.fr/privacy

## Questionnaires (Contenu de l'application)

- **Accès à l'app** : tout est accessible sans identifiant.
- **Annonces** : non.
- **Sécurité des données** : aucune donnée collectée ni partagée par défaut. Données chiffrées en
  transit : oui. Suppression : pas de compte (données locales, effacées avec l'app). Le résumé
  anonyme de statistiques est facultatif (activé par l'utilisateur) : à déclarer comme
  « Infos et performances de l'appli », non associé à l'utilisateur, finalité fonctionnalité et
  analyse, si l'option est proposée dans le build.
- **Public cible** : 13 ans et plus (contenus tiers et messages entre utilisateurs).
- **Classification (IARC)** : app de streaming / réseau social ; interactions entre utilisateurs
  oui ; partage de position non ; achats non ; contenu fourni par des tiers (addons).
- **Appli d'actualités / santé / finance / gouvernement** : non.
