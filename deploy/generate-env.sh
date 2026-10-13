#!/usr/bin/env bash
# Crée le fichier .env avec des secrets aléatoires (à lancer une seule fois, depuis la racine du dépôt).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  echo ".env existe déjà : rien n'est écrasé." >&2
  exit 1
fi
rand() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
cp .env.example .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 48 40)|" .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(rand 64 64)|" .env
sed -i "s|^COMPUTER_RPC_TOKEN=.*|COMPUTER_RPC_TOKEN=$(rand 48 48)|" .env
sed -i "s|^SETUP_TOKEN=.*|SETUP_TOKEN=$(rand 24 24)|" .env
chmod 600 .env
echo ".env créé (droits 600). Complète PUBLIC_ORIGIN, les identifiants Claude et les clés VAPID (voir README)."
echo "Garde une copie de .env hors de la machine (au minimum ENCRYPTION_KEY) : elle est nécessaire pour restaurer une sauvegarde."
