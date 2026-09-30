# Cadre juridique de la distribution — modèles à faire relire

Ce document est un **modèle** rédigé pour un éditeur individuel établi en France ; il ne remplace pas l'avis d'un avocat. Il couvre : les conditions générales d'utilisation (CGU), la procédure de notification (DMCA / LCEN), la politique de contenu généré par les utilisateurs (UGC) exigée par les magasins et AltStore, et les rappels à afficher dans l'app.

## Principe directeur : Huwa ne fournit aucun contenu

- Huwa lit un **catalogue public de métadonnées** (AniList : titres, visuels, synopsis). Aucune vidéo, aucune page de manhwa n'est hébergée, indexée, mise en cache côté serveur ni recommandée par l'éditeur.
- Les **addons de flux** (protocole Stremio) sont saisis par l'utilisateur. L'app n'en embarque aucun et n'en propose pas de liste.
- Le **moteur torrent** (si activé par un build sideload) est désactivé par défaut, ne contient aucun index, et affiche un rappel de responsabilité à la première activation. Il est absent des builds magasin.
- Les **commentaires et messages** sont produits par les utilisateurs et, à terme, distribués en pair-à-pair : l'éditeur n'a pas la capacité technique de supprimer un contenu chez tous les pairs, mais dispose d'outils de masquage (listes de blocage signées) qu'il s'engage à utiliser.

## 1. CGU — modèle

**Éditeur** : NOM, adresse, contact (`legal@HOST_A_RENSEIGNER`). Hébergeur des services optionnels : NOM DU VPS.

**Objet.** Huwa est un lecteur et un carnet de progression pour anime et manhwa. Il donne accès à des métadonnées publiques et permet à l'utilisateur d'ajouter ses propres sources.

**Responsabilité de l'utilisateur.** L'utilisateur est seul responsable des sources (addons, liens, torrents) qu'il configure et des contenus auxquels il accède. Il s'engage à n'utiliser que des sources qu'il a le droit d'utiliser dans son pays. Le téléchargement ou le partage d'œuvres protégées sans autorisation est illégal dans de nombreux pays.

**Contenus des utilisateurs.** En publiant un commentaire ou un message, l'utilisateur garantit qu'il en détient les droits et qu'il ne contient ni contenu illicite, ni harcèlement, ni données personnelles de tiers, ni spoiler non signalé. Les contenus sont signés par sa clé et peuvent être répliqués par d'autres appareils.

**Modération.** L'utilisateur peut signaler, masquer et bloquer. L'éditeur publie une liste de blocage à laquelle l'app est abonnée par défaut ; il traite les signalements sous 24 heures (voir §3). L'éditeur ne peut pas garantir la suppression d'un contenu chez tous les pairs.

**Données.** Aucun compte, aucune télémétrie. Les données (progression, commentaires, clés) sont stockées sur l'appareil ; les services optionnels ne voient que des métadonnées techniques (voir `services/README.md`). Aucune donnée n'est vendue.

**Âge.** Service réservé aux personnes de 16 ans et plus ; les titres classés adultes par le catalogue sont masqués par défaut.

**Propriété intellectuelle.** Les marques et visuels des œuvres appartiennent à leurs ayants droit ; les métadonnées proviennent d'AniList sous ses conditions. Le code de Huwa est publié sous la licence du dépôt.

**Suspension.** L'éditeur peut inscrire une clé sur sa liste de blocage en cas de violation. Il peut retirer un addon de toute mention et refuser sa promotion.

**Droit applicable.** Droit français ; médiation de la consommation avant tout recours.

## 2. Procédure de notification et retrait (DMCA / LCEN)

Deux régimes, une seule adresse : `abuse@HOST_A_RENSEIGNER` (et un formulaire dans l'app : Réglages → Aide → Signaler un contenu).

**États-Unis — DMCA (17 U.S.C. §512).** Désigner un agent auprès du Copyright Office (formulaire en ligne, ~6 $), publier ses coordonnées. Une notification valable contient : identification de l'œuvre, identification du contenu litigieux et de sa localisation (clé/ID de commentaire, URL d'addon mentionnée), coordonnées, déclaration de bonne foi, déclaration sous peine de parjure, signature. Traitement : retrait/masquage, information de l'auteur, possibilité de contre-notification (10–14 jours ouvrés avant rétablissement). Politique de récidive : blocage définitif de la clé.

**France / UE — LCEN (art. 6-I-5) et DSA.** La notification doit comporter : date, identité du notifiant, description et localisation précise des faits, motifs légaux, copie de la correspondance adressée à l'auteur (ou justification de l'impossibilité). Le DSA (règlement 2022/2065) impose un mécanisme de notification facile d'accès, un accusé de réception, une décision motivée et un point de contact ; l'éditeur, s'il reste sous les seuils, n'est pas « très grande plateforme » mais doit tenir ces obligations de base.

**Ce que l'éditeur peut techniquement faire** : ajouter la clé ou l'ID de contenu à sa liste de blocage signée (masquage chez tous les utilisateurs abonnés, par défaut), retirer toute mention d'un addon, supprimer les données des services qu'il héberge (blind peer : `delete-core` par pair de confiance). **Ce qu'il ne peut pas faire** : effacer un contenu déjà répliqué chez des pairs qui n'appliquent pas la liste, ni couper un addon tiers hébergé ailleurs — le notifiant est alors renvoyé vers l'hébergeur de l'addon.

Journal : conserver chaque notification, décision et délai (registre interne, un an).

## 3. Politique UGC (exigée par Apple 1.2, Google et AltStore « app guidelines »)

| Exigence | Mise en œuvre dans Huwa |
|---|---|
| Filtrer les contenus inappropriés | Filtre de mots local, PoW anti-spam, marquage spoiler obligatoire, titres adultes masqués |
| Signaler | Bouton « Signaler » sur chaque commentaire/message/addon → label signé + e-mail à l'éditeur |
| Bloquer | « Bloquer l'utilisateur » immédiat et local ; listes de blocage partagées |
| **Traitement sous 24 h** | Engagement de l'éditeur : toute notification reçue est instruite et, le cas échéant, la clé/le contenu est ajouté à la liste de blocage signée dans les 24 h ; réponse au notifiant |
| Contact | `abuse@HOST_A_RENSEIGNER` publié dans l'app et dans les sources de distribution |
| Conditions acceptées | CGU affichées à la première ouverture et à chaque changement majeur ; acceptation requise avant les commentaires |

## 4. Rappels à afficher dans l'app

- Première ouverture : « Huwa ne fournit aucun contenu. Vous êtes responsable des sources que vous ajoutez. » + lien CGU.
- Ajout d'un addon : « Cet addon est fourni par un tiers. Vérifiez que vous avez le droit de l'utiliser dans votre pays. »
- Première activation torrent (builds sideload) : rappel de légalité, désactivé par défaut, Wi-Fi seulement, seeding désactivé.
- Réglages → Confidentialité : liste des relais utilisés et ce qu'ils voient.

## 5. Ce qui reste à faire par l'éditeur

1. Choisir la structure (personne physique, micro-entreprise, association) et faire relire ce modèle.
2. Enregistrer l'agent DMCA ; créer les adresses `legal@` et `abuse@`.
3. Publier CGU + procédure sur `https://HOST_A_RENSEIGNER/legal` (URL référencée par `altstore-source.json` et la fiche Android).
4. Décider du pays d'hébergement des services optionnels (le droit de l'hébergeur s'applique aux notifications).
