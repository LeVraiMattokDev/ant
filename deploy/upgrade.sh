#!/usr/bin/env bash
# Met Ant à jour en gardant un point de retour. Usage, en root depuis /opt/ant : ./deploy/upgrade.sh
#   --depuis COMMIT : version qui tournait avant (si tu as déjà fait « git pull » toi-même, par exemple
#                     pour récupérer ce script la première fois) ; elle sert au retour arrière.
#   1. vérifie le dépôt (branche, aucune modification locale) et note la version actuelle ;
#   2. git pull, puis reconstruit les images en récupérant les correctifs des images de base (--pull) ;
#   3. sauvegarde vérifiée de la base (ant-avant-maj-…) : les migrations s'appliquent au redémarrage ;
#   4. récupère la dernière image PostgreSQL 17, redémarre et attend que web soit en bonne santé ;
#   5. supprime les anciennes images, puis affiche la commande de retour arrière.
# Le service web applique les migrations au démarrage : sans ce dump, une version ratée ne
# pourrait pas être annulée sans perdre jusqu'à 24 h de données.
#
# Point de retour d'une mise à jour inachevée, dans .git/ant-upgrade (hors des fichiers versionnés) :
#   depuis=COMMIT   version qui tournait avant, notée avant « git pull » ;
#   sauvegarde=NOM  dump d'avant mise à jour, noté juste avant le redémarrage (ensuite, la base peut
#                   porter les migrations de la nouvelle version : seul ce dump va avec l'ancienne).
# Après un échec, une simple relance reprend ce point de retour, au lieu de la version que git vient
# de récupérer. Le fichier est supprimé quand la mise à jour réussit. Un retour arrière fait avec
# deploy/restore.sh --sans-redemarrage oublie le dump noté : la base est revenue à l'ancienne version.
set -euo pipefail
cd "$(dirname "$0")/.."

HEALTH_TIMEOUT="${ANT_HEALTH_TIMEOUT:-300}"
HEALTH_POLL="${ANT_HEALTH_POLL:-5}"

say() { printf '\n==> %s\n' "$*"; }
die() {
  printf 'upgrade : %s\n' "$*" >&2
  exit 1
}

since=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --depuis)
      [ "$#" -ge 2 ] || die "--depuis attend un commit"
      since="$2"
      shift 2
      ;;
    *) die "option inconnue : $1 (usage : deploy/upgrade.sh [--depuis COMMIT])" ;;
  esac
done

[ -f .env ] || die ".env introuvable : lance d'abord deploy/generate-env.sh (voir README)."
branch="$(git symbolic-ref -q --short HEAD)" \
  || die "version figée (HEAD détachée, après un retour arrière ?) : reviens sur la branche avec « git checkout main », puis relance."
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "modifications locales dans le dépôt (voir « git status ») : annule-les ou enregistre-les ailleurs avant la mise à jour."
fi

state="$(git rev-parse --git-path ant-upgrade)"
state_get() {
  if [ -f "$state" ]; then sed -n "s/^$1=//p" "$state" | tail -n 1; fi
}
pending="$(state_get depuis)"
rollback_dump="$(state_get sauvegarde)"
if [ -n "$since" ]; then
  old="$(git rev-parse --verify -q "$since^{commit}")" || die "commit inconnu : $since"
  # Version donnée explicitement : la base actuelle est la sienne, le dump noté ne s'applique plus.
  [ "$old" = "$pending" ] || rollback_dump=""
elif [ -n "$pending" ] && git merge-base --is-ancestor "$pending" HEAD 2>/dev/null; then
  old="$pending"
  echo "Mise à jour précédente inachevée : le retour arrière vise toujours la version $(git rev-parse --short "$old")."
  echo "(Si une autre version tourne désormais, relance avec --depuis COMMIT.)"
else
  if [ -n "$pending" ]; then
    echo "upgrade : point de retour noté ($pending) absent de la branche $branch : ignoré." >&2
  fi
  old="$(git rev-parse HEAD)"
  rollback_dump=""
fi
old_short="$(git rev-parse --short "$old")"
head_before="$(git rev-parse HEAD)"

# Dossier des sauvegardes vu de la machine (même défaut que docker-compose.yml).
backup_dir="$(sed -n 's/^BACKUP_DIR=//p' .env | tail -n 1 | tr -d "\"'")"
backup_dir="${backup_dir:-/var/backups/ant}"

# TRUST_PROXY=true (ancienne valeur de .env.example) laissait n'importe quel client choisir son
# adresse IP à travers Nginx Proxy Manager (limitation des tentatives de connexion contournable).
if grep -Eq "^TRUST_PROXY=[\"']?true[\"']?[[:space:]]*$" .env; then
  sed -i -E 's/^TRUST_PROXY=.*/TRUST_PROXY=loopback,linklocal,uniquelocal/' .env
  echo "TRUST_PROXY=true remplacé dans .env par loopback,linklocal,uniquelocal (réseaux privés seulement, voir README § 7)."
fi

# Restauration d'abord, avec le restore.sh de cette version (les anciennes ne l'ont pas forcément), en laissant
# les services arrêtés : la nouvelle version ne redémarre jamais sur la base restaurée (elle y réappliquerait
# ses migrations). L'ancienne version est ensuite reconstruite puis démarrée.
rollback_help() {
  echo "Pour revenir à la version $old_short avec les données d'avant la mise à jour :"
  echo "  ./deploy/restore.sh $backup_dir/$rollback_dump.dump --sans-redemarrage"
  echo "  git checkout $old"
  echo "  docker compose build && docker compose up -d"
  echo "Puis, quand une version corrigée est publiée : git checkout $branch && ./deploy/upgrade.sh"
}

# Étape atteinte, pour le message d'échec : code (git pull fait, images en cours de construction ou
# sauvegarde), redemarrage (nouvelle version lancée sur la base), vide (rien de modifié, ou terminé).
phase=""
new_short=""
on_exit() {
  local rc=$?
  [ "$rc" -ne 0 ] && [ -n "$phase" ] || return 0
  {
    echo
    if [ "$phase" = code ] && [ -z "$rollback_dump" ]; then
      echo "Ant tourne toujours sur la version $old_short, la base n'a pas été modifiée."
      if [ "$new_short" != "$old_short" ]; then
        echo "Mais le code est déjà en version $new_short et les images ont pu être reconstruites : ne lance pas"
        echo "« docker compose up » d'ici là, il démarrerait cette version sans sauvegarde préalable."
      fi
      echo "Une fois le problème réglé, relance ./deploy/upgrade.sh : le retour arrière visera toujours la version $old_short."
      if [ "$new_short" != "$old_short" ]; then
        echo "Pour renoncer et garder la version $old_short : git checkout $old && docker compose build"
      fi
    else
      rollback_help
      echo "Ou, si tu corriges le problème sans revenir en arrière, relance ./deploy/upgrade.sh :"
      echo "$rollback_dump.dump restera la sauvegarde de retour vers la version $old_short."
    fi
  } >&2
}
trap on_exit EXIT

# Point de retour noté avant « git pull » : après un échec, une relance ne le confond pas avec le nouveau code.
{
  echo "depuis=$old"
  if [ -n "$rollback_dump" ]; then echo "sauvegarde=$rollback_dump"; fi
} >"$state"

say "Récupération du code (branche $branch, version actuelle $old_short)"
git pull --ff-only
new_short="$(git rev-parse --short HEAD)"
phase=code
if [ "$new_short" = "$old_short" ]; then
  echo "Code déjà à jour : les images sont tout de même reconstruites pour les correctifs de sécurité."
fi

say "Construction des images (correctifs des images de base compris)"
docker compose build --pull

say "Sauvegarde de la base avant mise à jour"
# Nommée d'après la version dont la base porte les migrations : celle d'avant la mise à jour, sauf si une
# tentative précédente a déjà redémarré Ant sur le code alors récupéré.
db_version="$old_short"
if [ -n "$rollback_dump" ]; then db_version="$(git rev-parse --short "$head_before")"; fi
dump="ant-avant-maj-$(date +%F-%H%M%S)-$db_version"
docker compose run --rm -T backup --once "$dump" \
  || die "la sauvegarde a échoué : mise à jour interrompue avant le redémarrage."

say "Mise à jour de l'image PostgreSQL 17 et redémarrage"
docker compose pull postgres backup \
  || echo "upgrade : image PostgreSQL non mise à jour (Docker Hub injoignable ou limite atteinte ?), on garde l'image locale." >&2
# À partir d'ici, la base peut recevoir les migrations de la nouvelle version : seul le dump d'avant
# la première tentative correspond encore à l'ancienne.
rollback_dump="${rollback_dump:-$dump}"
printf 'depuis=%s\nsauvegarde=%s\n' "$old" "$rollback_dump" >"$state"
phase=redemarrage
docker compose up -d --remove-orphans

container_status() {
  local id
  id="$(docker compose ps -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$id" ] || {
    echo absent
    return
  }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo absent
}

say "Attente du démarrage de web (migrations comprises, ${HEALTH_TIMEOUT} s au plus)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  status="$(container_status web)"
  [ "$status" = healthy ] && break
  if [ "$status" = unhealthy ] || [ "$status" = absent ] || [ "$SECONDS" -ge "$deadline" ]; then
    echo >&2
    echo "upgrade : web ne démarre pas correctement (état : $status)." >&2
    echo "Journaux : docker compose logs --tail 100 web worker" >&2
    exit 1
  fi
  sleep "$HEALTH_POLL"
done
worker="$(container_status worker)"
if [ "$worker" != running ]; then
  echo "upgrade : le worker n'est pas démarré (état : $worker). Journaux : docker compose logs --tail 100 worker" >&2
  exit 1
fi

# Mise à jour réussie : plus de point de retour en attente.
rm -f "$state"
phase=""

say "Nettoyage des anciennes images et du cache de construction de plus de 7 jours"
docker image prune -f >/dev/null || echo "upgrade : nettoyage des anciennes images impossible (docker image prune -f)." >&2
docker builder prune -f --filter until=168h >/dev/null || true

echo
echo "Ant est à jour : $old_short → $new_short."
echo "Sauvegarde d'avant mise à jour : $backup_dir/$rollback_dump.dump"
if [ "$rollback_dump" != "$dump" ]; then
  echo "(prise avant la première tentative ; état de la base juste avant cette relance : $backup_dir/$dump.dump)"
fi
echo "Elle est supprimée automatiquement avec les sauvegardes de plus de BACKUP_KEEP_DAYS jours."
rollback_help
