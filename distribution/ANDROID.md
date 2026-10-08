# Distribution Android — APK sideload

Priorité de Huwa (PLAN.md phase 9). Aucun magasin obligatoire : un APK signé sur GitHub Releases, suivi par Obtainium ; IzzyOnDroid en bonus si le code reste open source.

## 1. Clé de signature : une seule, à vie

Android identifie une app par `package` **+** clé de signature. Changer de clé = impossible de mettre à jour par-dessus l'ancienne installation (les utilisateurs doivent désinstaller et perdent leurs données locales : progression, commentaires, addons).

```sh
keytool -genkeypair -v -storetype PKCS12 \
  -keystore huwa-release.keystore -alias huwa \
  -keyalg RSA -keysize 4096 -validity 36500
```

- Conserver `huwa-release.keystore` + les deux mots de passe dans un gestionnaire de secrets **et** une sauvegarde hors ligne. Jamais dans le dépôt (`*.keystore`, `credentials.json` sont git-ignorés).
- `credentials.json` (local, pour `eas build --local` avec `credentialsSource: local`) :

```json
{
  "android": {
    "keystore": {
      "keystorePath": "huwa-release.keystore",
      "keystorePassword": "…",
      "keyAlias": "huwa",
      "keyPassword": "…"
    }
  }
}
```

(format vérifié : docs Expo « Local credentials »)

- Publier l'empreinte SHA-256 du certificat (`keytool -list -v -keystore …`) dans le README : les utilisateurs et IzzyOnDroid peuvent vérifier l'APK (`apksigner verify --print-certs`).

## 2. Vérification développeur Google (obligatoire)

Source : developer.android.com/developer-verification (consulté septembre 2026).

- Google impose la **vérification d'identité de tous les développeurs** dont les apps s'installent sur des appareils Android certifiés, *y compris hors Play Store*. Calendrier : APIs et comptes « distribution limitée » en août 2026 ; **application dès le 30 septembre 2026 au Brésil, Indonésie, Singapour, Thaïlande** ; **mondial à partir de 2027**.
- Deux guichets : Play Console (si un jour une version Lite y va) ou **Android Developer Console** (`android.google.com/developerconsole`) pour la distribution hors Play uniquement. Il faut enregistrer le **nom de package** `com.amintt2.huwa` et la **clé de signature** (d'où l'importance du point 1), avec pièce d'identité. Frais annoncés « selon le type de compte » (le montant de 25 $ correspond à Play Console ; la page ne le fixe pas pour l'Android Developer Console — vérifier au moment de l'inscription).
- Le compte « distribution limitée » (sans pièce d'identité ni frais) est plafonné à **20 appareils** : suffisant pour tester, pas pour distribuer.
- Un « flux avancé » permettra aux utilisateurs expérimentés d'installer des apps non vérifiées, avec avertissements. Ne pas compter dessus.

À faire maintenant, avant la première release publique : créer le compte, enregistrer le package et la clé.

## 3. Publier sur GitHub Releases

Le workflow `.github/workflows/release-android.yml` construit les APK sur un tag `v*` et les attache à la release. Clé : `bash scripts/android-keystore.sh` (secrets `HUWA_KEYSTORE_*`).

- Jobs : `torrent` (moteur Rust, `cargo ndk`, un job par ABI, en cache) → `apk` (prebuild + Gradle `assembleRelease`, signature depuis l'environnement) → `smoke` (émulateur x86_64, informatif, ne bloque pas la release).
- Sorties : `Huwa-<version>.apk` (universel : arm64-v8a, armeabi-v7a, x86_64), `Huwa-<version>-<abi>.apk`, `.sha256` et `fingerprint-android.json`.
- Tag sans secrets : échec. `workflow_dispatch` sans secrets : clé jetable, fichiers suffixés `-unsigned-test`, jamais publiés (ils ne peuvent pas être mis à jour par une vraie release : désinstaller avant).
- Réglages Gradle (minSdk 29 imposé par react-native-bare-kit, ABI, splits, signature) : `plugins/with-android-release.js`.
- OTA : désactivées tant que `certs/certificate.pem` et l'URL du serveur manquent (`app.config.js`), le build n'en dépend pas.

Localement (JDK 17, SDK + NDK 27.1.12297006) :

```sh
scripts/build-torrent.sh android                      # optionnel : moteur torrent
HUWA_TORRENT=1 npx expo prebuild --platform android --clean
cd android && HUWA_KEYSTORE_FILE=… HUWA_KEYSTORE_PASSWORD=… HUWA_KEY_ALIAS=huwa HUWA_KEY_PASSWORD=… ./gradlew :app:assembleRelease
```

Sans `HUWA_KEYSTORE_FILE`, l'APK de release est signé avec la clé de debug (test local uniquement).

Rédiger les notes de version en français, mentionner le SHA-256 et rappeler que l'app ne contient aucun contenu.

## 4. Obtainium

Obtainium suit directement les releases GitHub (source vérifiée : README ImranR98/Obtainium).

- L'utilisateur ajoute l'URL du dépôt `https://github.com/ORG/huwa` ; Obtainium détecte l'APK dans les assets.
- Fournir un lien d'import direct dans le README :

  `obtainium://add/https://github.com/ORG/huwa`

- Plusieurs APK par release (universel + un par ABI) : Obtainium choisit selon l'ABI de l'appareil ; filtre conseillé `Huwa-[0-9.]+(-arm64-v8a)?\.apk$` pour s'en tenir à l'universel ou à arm64.
- Optionnel : proposer la configuration sur `apps.obtainium.imranr.dev` (dépôt communautaire, par pull request).

## 5. IzzyOnDroid (si open source)

Dépôt F-Droid tiers qui republie les APK des releases GitHub/GitLab/Codeberg tels quels (signés par vous). Conditions générales connues : code source public sous licence libre, APK dans les releases, taille raisonnable (limite historique de 30 Mo par APK — un build Bare + libtorrent peut la dépasser : vérifier au moment de la demande), pas de trackers propriétaires. Demande d'inclusion par ticket sur le dépôt IzzyOnDroid (`gitlab.com/IzzyOnDroid/repo`, la procédure exacte est dans leur wiki ; la page README consultée est archivée). Les scanners IzzyOnDroid signalent les bibliothèques de tracking : Huwa n'en a pas (pas de télémétrie).

## 6. Côté utilisateur

1. Autoriser l'installation depuis « sources inconnues » pour Obtainium ou le navigateur.
2. Installer l'APK, comparer le SHA-256 si souhaité.
3. Les mises à jour JS arrivent par OTA signé ; les mises à jour natives via Obtainium (notification) ou la release GitHub.

## Risques

- Durcissement 2027 : sans vérification développeur, l'APK ne s'installera plus sur les appareils certifiés.
- Perte de la clé de signature : voir point 1.
- Promotion d'addons illégaux dans le README ou les releases : jamais (voir LEGAL.md).
