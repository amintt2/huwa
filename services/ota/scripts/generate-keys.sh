#!/usr/bin/env bash
# Génère la paire de clés expo-updates + le certificat auto-signé, puis configure app.json.
#
# Commande réelle vérifiée (expo-updates 57) : `npx expo-updates codesigning:generate`
#   --key-output-directory, --certificate-output-directory,
#   --certificate-validity-duration-years, --certificate-common-name
# puis `npx expo-updates codesigning:configure` qui écrit
#   updates.codeSigningCertificate = ./certs/certificate.pem
#   updates.codeSigningMetadata   = { keyid: "main", alg: "rsa-v1_5-sha256" }
#
# Quand l'utiliser :
#   - serveur de référence expo/custom-expo-updates-server (PRIVATE_KEY_PATH), ou
#   - xprem en mode « stateless » / clés locales (KEYS_STORAGE_TYPE=local,
#     PRIVATE_LOCAL_EXPO_KEY_PATH, PUBLIC_LOCAL_EXPO_KEY_PATH).
#   En mode base de données (docker-compose.yml de ce dossier), xprem génère lui-même la
#   paire à la création de l'app : télécharger le certificat depuis le tableau de bord et
#   le copier dans certs/certificate.pem à la place de ce script.
#
# Résultat :
#   services/ota/keys/private-key.pem  -> JAMAIS commité (.gitignore), à sauvegarder hors ligne
#   services/ota/keys/public-key.pem
#   certs/certificate.pem              -> commité, embarqué dans le binaire
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
KEYS="$ROOT/services/ota/keys"
CERTS="$ROOT/certs"
COMMON_NAME="${HUWA_OTA_COMMON_NAME:-Huwa}"
YEARS="${HUWA_OTA_CERT_YEARS:-10}"

if [ -f "$KEYS/private-key.pem" ]; then
  echo "Une clé privée existe déjà dans $KEYS — refus d'écraser." >&2
  echo "Supprimez-la volontairement si vous voulez faire une rotation (nouveau binaire obligatoire)." >&2
  exit 1
fi

mkdir -p "$KEYS" "$CERTS"
chmod 700 "$KEYS"

cd "$ROOT"
npx expo-updates codesigning:generate \
  --key-output-directory "$KEYS" \
  --certificate-output-directory "$CERTS" \
  --certificate-validity-duration-years "$YEARS" \
  --certificate-common-name "$COMMON_NAME"

npx expo-updates codesigning:configure \
  --certificate-input-directory "$CERTS" \
  --key-input-directory "$KEYS"

chmod 600 "$KEYS"/*.pem

cat <<EOF

Clés générées.
  Clé privée : $KEYS/private-key.pem   (git-ignorée — sauvegarde hors ligne, chiffrée)
  Certificat : $CERTS/certificate.pem  (à commiter)

Vérification que rien de sensible n'est suivi par git :
EOF
git -C "$ROOT" status --short --ignored -- services/ota/keys certs || true
echo
echo "Un nouveau build natif est nécessaire pour embarquer le certificat (le runtimeVersion change)."
