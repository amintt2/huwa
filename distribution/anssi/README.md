# Dossier ANSSI : déclaration de fourniture d'un moyen de cryptologie (Huwa 1.0.0)

**Pourquoi ce dossier.** Apple a refusé la déclaration de chiffrement de l'app pour la France (« App encryption declaration was not approved »). Dans App Store Connect, la déclaration actuelle porte sur des « algorithmes standard, cryptographie tierce, disponible sur le store français » (identifiant `befadf95-5e80-458a-a784-dcec3421048a`, état `CREATED` au 08/10/2026). Pour une app qui utilise de la cryptographie standard **non fournie par le système** (ici libsodium, rustls, GnuTLS), Apple demande de téléverser la déclaration française, c'est-à-dire le document délivré par l'ANSSI.

> **Changement important.** Depuis le **31 mars 2026**, la déclaration **ne s'envoie plus par e-mail** à controle@ssi.gouv.fr. Elle se dépose **en ligne** sur demarche.numerique.gouv.fr (notice ANSSI V3 ; la page « les formulaires » de cyber.gouv.fr ne renvoie plus qu'à cette plateforme). L'ancien formulaire PDF (« Annexe I », au format XFA) n'est plus en ligne. Il est conservé ici pour mémoire. `email.txt` contient donc un message à poster dans la messagerie du dossier, et un e-mail de secours.

---

## Contenu du dossier

| Fichier | Rôle | À déposer ? |
|---|---|---|
| `README.md` | Ce guide | Non |
| `formulaire-rempli.md` (+ `.pdf`) | Réponses à saisir, champ par champ, dans le formulaire en ligne | Non, à recopier dans le formulaire (le PDF ne sert qu'avec l'e-mail de secours) |
| `description-technique.md` / **`.pdf`** | Brochure technique (« datasheet ») : algorithmes, clés, bibliothèques, flux | **Oui** : « Brochure technique » (obligatoire) |
| `presentation-produit.md` / **`.pdf`** | Brochure commerciale (présentation du produit) | **Oui** : « Brochure commerciale » (obligatoire) |
| `note-grand-public.md` / **`.pdf`** | Demande de classement « grand public » (annexe 2, catégorie 3) pour la diffusion dans l'UE et le monde | **Oui** : « Tout autre document » (recommandé) |
| `attestation-brouillon.md` | Contenu attendu de l'attestation. **Le modèle officiel se télécharge sur la plateforme** | Non. Déposez le modèle officiel, rempli et signé |
| `email.txt` | (A) message pour la messagerie du dossier ; (B) e-mail de secours | Selon le cas |
| `officiel/dossier_vide.pdf` | Formulaire officiel vierge (export PDF de la démarche en ligne) | Non |
| `officiel/260331_Notice_V3.pdf` | Notice officielle ANSSI du formulaire (31/03/2026) | Non |
| `officiel/decret-2007-663-JORF.pdf` | Décret n° 2007-663, version publiée au JO du 4 mai 2007 | Non |
| `officiel/ancien-formulaire-remplace/…annexe1_v2.pdf` | Ancien formulaire (XFA, à ouvrir avec Adobe Acrobat), **remplacé** | Non |

---

## Liste des étapes

### 1. Compléter les données personnelles (je ne les ai pas inventées)

Dans `formulaire-rempli.md` et dans l'attestation :

- [ ] Adresse e-mail (compte de la plateforme et contact du formulaire)
- [ ] Prénoms d'état civil complets
- [ ] Nationalité
- [ ] Adresse postale complète
- [ ] Numéro de téléphone
- [ ] **Date de mise sur le marché** : la source AltStore indique la 1.0.0 au 30/09/2026. Mettez la date réelle de première mise à disposition du public, ou la date prévue
- [ ] **Statut** : particulier (hypothèse de ce brouillon) ou entrepreneur individuel avec un SIRET. Dans le second cas, choisissez « personne morale » si l'activité est déclarée en entreprise : un SIRET et peut-être un document de présentation seront demandés
- [ ] Ville, date et **signature manuscrite** de l'attestation

Le formulaire ne demande pas de date de naissance.

Les trois PDF à déposer (`description-technique.pdf`, `presentation-produit.pdf`, `note-grand-public.pdf`) ne contiennent **aucun champ à compléter**.

### 2. Relire les pièces techniques

Relisez `description-technique.md`, en particulier le § 8 « Points d'attention ». Deux constats faits dans le code diffèrent de l'hypothèse de départ :

- **Les relais (blind peers) ne stockent du chiffré que pour les messages privés.** Le profil, les listes, la progression et les commentaires y sont **signés mais en clair** : le chiffrement au repos d'Hypercore / Autobase n'est pas activé.
- **Le lecteur libmpv embarque GnuTLS 3.8.11** (et le déchiffrement HLS AES-128 de FFmpeg), en plus de rustls. Ces deux composants ne sont présents que dans les versions hors App Store.

Si le code change avant le dépôt (par exemple si vous activez le chiffrement des journaux sur les relais), mettez la description à jour.

### 3. Remplir la démarche en ligne

1. Ouvrez https://demarche.numerique.gouv.fr/commencer/declaration-relative-a-un-moyen-de-cryptologie et connectez-vous avec **FranceConnect** ou un compte de la plateforme. Durée estimée : 28 minutes.
2. Choisissez **« Pour vous »**.
3. Recopiez les réponses de `formulaire-rempli.md`, section par section :
   - « Le bénéficiaire est un particulier » ;
   - Logiciel ;
   - les 4 fonctions cryptographiques ;
   - SSL/TLS + Autre(s) ;
   - 20 blocs « Algorithme » (cliquez sur « Ajouter un élément » entre chaque bloc).
4. Section **Pièces à joindre** :
   - Brochure commerciale → `presentation-produit.pdf`
   - Brochure technique → `description-technique.pdf`
   - Tout autre document → `note-grand-public.pdf`
   - Attestation → **téléchargez le modèle proposé à cet endroit**, remplissez-le (aidez-vous de `attestation-brouillon.md`), datez-le, signez-le, numérisez-le en PDF et déposez-le. C'est la seule pièce à signer.
5. Déposez le dossier. Ensuite, dans la **messagerie du dossier**, envoyez le message (A) de `email.txt`. Il demande l'attestation pour Apple et le classement « grand public ».

Ne déposez **pas** le code source. L'ANSSI peut le demander plus tard (article 7 du décret : dans un délai d'un an, avec deux exemplaires du produit).

### 4. Ce qui se passe ensuite

| Étape | Document reçu (par e-mail et sur la plateforme) |
|---|---|
| Dépôt | 1er e-mail : **accusé de réception** avec une **attestation de dépôt** en pièce jointe |
| Instruction | Questions éventuelles de l'ANSSI dans la messagerie du dossier. Si le dossier est incomplet, le délai repart à la réception des compléments |
| Acceptation | 2e e-mail : lien vers l'**attestation de déclaration délivrée par l'ANSSI**, avec un **numéro de dossier**. C'est le document à donner à Apple |

**Délais (décret 2007-663) :**

- La déclaration doit être déposée **au moins un mois avant** la fourniture (article 4).
- Sans réponse au bout d'un mois, le déclarant peut fournir librement le moyen (article 5). L'ANSSI peut délivrer l'attestation avant la fin de ce délai.
- Le délai passe à **deux mois** pour une exportation hors de l'UE (article 8).

À noter : la version 1.0.0 semble déjà distribuée par AltStore PAL depuis le 30/09/2026. La règle est une déclaration **préalable**. Déposez donc sans attendre, sans antidater quoi que ce soit, et indiquez la date réelle.

### 5. Téléverser le document dans App Store Connect

Téléversez l'**attestation de déclaration** (le 2e document). L'attestation de dépôt seule ne prouve pas que la déclaration a été acceptée : Apple risque de la refuser.

**En ligne de commande (`asc`) :**

```sh
# Vérifier l'état de la déclaration actuelle (ou retrouver un nouvel identifiant)
asc encryption declarations view --id befadf95-5e80-458a-a784-dcec3421048a --pretty
asc encryption declarations list --app "<APP_ID>"

# Téléverser l'attestation ANSSI (PDF)
asc encryption documents upload \
  --declaration befadf95-5e80-458a-a784-dcec3421048a \
  --file ./attestation-declaration-anssi.pdf
```

Si Apple impose une **nouvelle** déclaration (la précédente ayant été refusée), créez-la avec les mêmes réponses, puis utilisez son identifiant :

```sh
asc encryption declarations create --app "<APP_ID>" \
  --app-description "…" \
  --contains-proprietary-cryptography=false \
  --contains-third-party-cryptography=true \
  --available-on-french-store=true
asc encryption documents upload --declaration "<NOUVEL_ID>" --file ./attestation-declaration-anssi.pdf
asc encryption declarations assign-builds --id "<NOUVEL_ID>" --build-id "<BUILD_ID>"
```

**Dans l'interface web** (aide Apple, « Determine and upload app encryption documentation ») :

1. Apps → Huwa → **App Information**.
2. À côté de **App Encryption Documentation**, cliquez sur « + ».
3. Répondez aux questions, puis **Choose File** → l'attestation ANSSI → **Save**.

**Après la validation par Apple :**

- Apple indique traiter un dossier complet en environ deux jours ouvrés.
- Apple fournit une **clé** (export compliance code), affichée à côté de la documentation approuvée. Ajoutez-la à l'`Info.plist` (`ITSEncryptionExportComplianceCode`, via `ios.infoPlist` dans `app.json`) pour que les builds suivants n'exigent plus de réponse.

> Remarque sur `appDescription` (déclaration Apple actuelle) : ce texte mentionne « TLS via rustls », alors que rustls est absent de la version App Store (`HUWA_TORRENT=0`). Ce n'est pas faux pour les versions complètes, mais si vous recréez une déclaration, vous pouvez préciser : « libsodium (Noise, XChaCha20-Poly1305, X25519/Ed25519) pour le pair à pair chiffré de bout en bout ; AES-256-GCM (CryptoKit) pour la sauvegarde ; TLS du système ».

---

## Analyse : faut-il déclarer, et une dispense s'applique-t-elle ?

- **Déclaration requise pour la fourniture en France.** L'article 3, 1°, du décret soumet à déclaration préalable la fourniture des moyens « n'assurant pas exclusivement des fonctions d'authentification ou de contrôle d'intégrité ». Huwa chiffre pour la **confidentialité** (transport, messages privés, sauvegarde) : la déclaration est nécessaire.
- **Aucune dispense de l'annexe 1 ne semble s'appliquer.** C'est ma lecture du texte, pas une position de l'ANSSI.
  - Les catégories 1 à 7 visent des **équipements** grand public précis : cartes à puce, récepteurs TV, terminaux bancaires, téléphones dont seul l'opérateur chiffre, protection contre la copie, lecteurs audio-vidéo sans capacité de chiffrement.
  - La catégorie 10 vise le Wi-Fi et le Bluetooth (IEEE).
  - La catégorie 11 vise l'administration d'un système d'information.
  - La catégorie 12 vise l'importation ou le transfert pour usage personnel, pas la fourniture.
  - La catégorie 13 vise l'exportation avec des clés de 56 bits au plus (Huwa utilise 256 bits).
  - Il n'existe **pas de dispense générale pour les logiciels grand public**.
- **Tout est-il fourni par le système ?** Non : libsodium, rustls / aws-lc-rs et GnuTLS sont embarqués. Si l'app n'utilisait que la cryptographie d'iOS (HTTPS, Trousseau, CryptoKit), Apple dispenserait probablement de ce document. Ce n'est pas le cas ici.
- **Les intermédiaires sont couverts.** D'après l'article 6, la déclaration du fournisseur vaut pour les intermédiaires qui diffusent le moyen (App Store, AltStore PAL).
- **Diffusion dans l'UE et à l'étranger** (point moins certain) :
  - Le transfert vers l'UE et l'exportation vers les 7 pays de l'EU001 (Australie, Canada, États-Unis, Japon, Nouvelle-Zélande, Norvège, Suisse) relèvent aussi de la déclaration (annexe 2, A).
  - L'exportation vers les autres pays demande une autorisation, **sauf** si le moyen est classé « **grand public** » (annexe 2, catégorie 3). Dans ce cas, d'après cyber.gouv.fr, il « s'export[e] librement », mais le classement doit être demandé au moment de la déclaration et validé par l'ANSSI.
  - Le nouveau formulaire en ligne n'a plus de case pour ce classement (l'ancienne section C a disparu). D'où la note jointe et le message (A).
  - Pour les biens à double usage (règlement UE 2021/821, catégorie 5, partie 2), c'est le SBDU qui délivre les licences d'exportation. D'après cyber.gouv.fr, le numéro d'attestation ANSSI « est nécessaire et suffisant » pour la demande au SBDU. Je n'ai pas vérifié si une formalité SBDU est nécessaire pour une app gratuite distribuée par des magasins. À demander à l'ANSSI dans la messagerie, si besoin.

## Points incertains

1. **Modèle d'attestation** : on ne le télécharge qu'une fois connecté à la plateforme. Le brouillon reprend l'ancienne formulation.
2. **Formulaire en ligne « en cours de développement »** : la plateforme l'annonce elle-même, les champs peuvent changer. La correspondance champ par champ repose sur `dossier_vide.pdf` d'octobre 2026.
3. **Catégorie de la fonction principale** : j'ai choisi « Envoi, stockage, réception d'informations ». C'est un jugement, pas une consigne de l'ANSSI.
4. **Particulier ou entreprise** : à trancher par vous (voir l'étape 1).
5. **Classement « grand public » et exportation** : rien ne dit sur le site comment le demander dans le nouveau formulaire.
6. **Document accepté par Apple** : Apple demande la « French encryption declaration » sans nommer précisément le document. L'attestation de déclaration ANSSI est ce que fournissent les autres développeurs, mais ce n'est pas écrit par Apple.
7. **Format de l'objet de l'e-mail** (« [formalités] marque – nom du produit ») : vient de l'ancienne page des formulaires. Il n'est plus confirmé, et l'e-mail n'est plus le canal normal.

## Sources officielles consultées

- ANSSI, Contrôle relatif à un moyen de cryptologie : https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-moyen-de-cryptologie/
- ANSSI, Contrôle réglementaire sur la cryptographie : les formulaires : https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-moyen-de-cryptologie/controle-reglementaire-cryptographie-formulaires/
- ANSSI, Démarches à accomplir (tableau, statut « grand public ») : https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-moyen-de-cryptologie/controle-rglementaire-cryptographie-demarches/
- ANSSI, FAQ, demande d'autorisation (en partie dépassée : mentionne encore l'e-mail) : https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-moyen-de-cryptologie/faq-demande-dautorisation/
- ANSSI, Contrôle export : https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-export/
- ANSSI, Notice V3 du formulaire (31/03/2026) : https://cyber.gouv.fr/documents/823/260331_Notice_V3.pdf
- Démarche en ligne : https://demarche.numerique.gouv.fr/commencer/declaration-relative-a-un-moyen-de-cryptologie (formulaire vierge : `…/dossier_vide`)
- Décret n° 2007-663 (version consolidée) : https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000646995. Articles cités : art. 3 [LEGIARTI000006428308](https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000006428308), art. 4 [LEGIARTI000021544660](https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000021544660), art. 5 [LEGIARTI000020879065](https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000020879065), annexe 1 [LEGIARTI000006428332](https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000006428332), annexe 2 [LEGIARTI000006428333](https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000006428333)
- Texte publié au JO (copie ARCEP) : https://www.arcep.fr/fileadmin/reprise/textes/decrets/d2007-663.pdf
- Apple, Export compliance documentation for encryption : https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/
- Apple, Determine and upload app encryption documentation : https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/
- Apple, Overview of export compliance : https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/
