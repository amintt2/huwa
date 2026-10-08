#!/usr/bin/env bash
# Crée la clé de signature Android de Huwa (une seule, à vie) et la met dans les secrets GitHub
# du dépôt, sans jamais afficher le mot de passe.
#
#   bash scripts/android-keystore.sh
#
# - Keystore PKCS12 (RSA 4096, alias "huwa", 100 ans) écrit dans ~/Documents/huwa-keys/ (hors du dépôt).
# - Mot de passe aléatoire rangé dans le Trousseau macOS (service "huwa-android-keystore").
# - Secrets GitHub : HUWA_KEYSTORE_B64, HUWA_KEYSTORE_PASSWORD, HUWA_KEY_ALIAS, HUWA_KEY_PASSWORD.
# - Affiche l'empreinte SHA-256 du certificat (publique, à mettre dans le README).
#
# Ensuite : sauvegarde le dossier ~/Documents/huwa-keys/ hors ligne (clé USB, gestionnaire de
# mots de passe). Perdre la clé = plus aucune mise à jour possible par-dessus l'app installée.
set -euo pipefail

REPO="amintt2/huwa"
DIR="$HOME/Documents/huwa-keys"
KS="$DIR/huwa-release.keystore"
ALIAS="huwa"
SERVICE="huwa-android-keystore"

command -v openssl >/dev/null || { echo "openssl introuvable"; exit 1; }
command -v gh >/dev/null || { echo "gh (GitHub CLI) introuvable"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Connecte-toi d'abord : gh auth login"; exit 1; }

if [ -e "$KS" ]; then
  echo "Une clé existe déjà : $KS — rien n'est écrasé."
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PW="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"

openssl req -x509 -newkey rsa:4096 -sha256 -days 36500 -nodes \
  -subj "/CN=Huwa/O=Huwa" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null

# Même mot de passe pour le magasin et la clé (PKCS12).
openssl pkcs12 -export -name "$ALIAS" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$KS" -passout fd:3 3<<<"$PW"
chmod 600 "$KS"

security add-generic-password -U -s "$SERVICE" -a "$ALIAS" -w "$PW" >/dev/null
echo "Mot de passe rangé dans le Trousseau (service « $SERVICE »)."

base64 -i "$KS" | gh secret set HUWA_KEYSTORE_B64 -R "$REPO"
printf '%s' "$PW" | gh secret set HUWA_KEYSTORE_PASSWORD -R "$REPO"
printf '%s' "$PW" | gh secret set HUWA_KEY_PASSWORD -R "$REPO"
printf '%s' "$ALIAS" | gh secret set HUWA_KEY_ALIAS -R "$REPO"
echo "Secrets GitHub définis sur $REPO."

echo
echo "Empreinte SHA-256 du certificat (publique) :"
openssl x509 -in "$TMP/cert.pem" -noout -fingerprint -sha256 | sed 's/^.*=//'
echo
echo "Clé : $KS"
echo "Sauvegarde ce dossier hors ligne maintenant."
