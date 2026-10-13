#!/usr/bin/env bash
# Restaure la base d'Ant depuis une sauvegarde (dump du service « backup » ou de deploy/upgrade.sh).
# Usage, en root depuis /opt/ant :  ./deploy/restore.sh /var/backups/ant/ant-AAAA-MM-JJ.dump [--oui] [--sans-redemarrage]
#   --oui               sans demande de confirmation
#   --sans-redemarrage  laisse web, worker et backup arrêtés (retour à une version précédente : la reconstruire d'abord)
#
# Sans risque pour la base actuelle :
#   1. l'archive est vérifiée (table des matières, table des migrations, lecture complète) ;
#   2. web, worker et backup sont arrêtés ;
#   3. l'archive est restaurée dans une base neuve (ant_restauration), d'un bloc (--single-transaction) ;
#   4. seulement si tout a réussi, les bases sont échangées en une transaction : la base actuelle est
#      conservée sous le nom ant_precedente (l'éventuelle précédente copie est supprimée) ;
#   5. les services redémarrent (docker compose up -d) et appliquent les migrations du code présent,
#      sauf avec --sans-redemarrage.
# En cas d'échec avant l'échange, la base actuelle n'est pas modifiée et les services redémarrent.
# Avec --sans-redemarrage (retour arrière après une mise à jour ratée), le dump d'avant mise à jour noté
# par deploy/upgrade.sh est oublié : la base est revenue à l'ancienne version, la prochaine mise à jour
# fera sa propre sauvegarde.
set -euo pipefail

DB="${ANT_DB:-ant}"
DB_USER="${ANT_DB_USER:-ant}"
TMP_DB="${DB}_restauration"
OLD_DB="${DB}_precedente"

die() {
  printf 'restore : %s\n' "$*" >&2
  exit 1
}
pg() { docker compose exec -T postgres "$@"; }
psql_admin() { pg psql -X -q -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 "$@"; }

usage="usage : deploy/restore.sh FICHIER.dump [--oui] [--sans-redemarrage]"
file=""
yes=0
restart=1
for arg in "$@"; do
  case "$arg" in
    --oui | --yes) yes=1 ;;
    --sans-redemarrage | --no-start) restart=0 ;;
    -*) die "option inconnue : $arg ($usage)" ;;
    *) [ -z "$file" ] || die "un seul fichier à la fois"; file="$arg" ;;
  esac
done
[ -n "$file" ] || die "$usage"
case "$file" in /*) ;; *) file="$PWD/$file" ;; esac
cd "$(dirname "$0")/.."
[ -f "$file" ] || die "fichier introuvable : $file"
[ -r "$file" ] || die "fichier illisible : $file (les sauvegardes sont réservées à root : lance la commande en root)"

pg pg_isready -q -U "$DB_USER" -d postgres \
  || die "PostgreSQL ne répond pas : démarre-le avec « docker compose up -d postgres », puis relance."

echo "==> Vérification de l'archive $file"
toc="$(mktemp)"
# check : rien n'est modifié ; stopped : services arrêtés, base actuelle intacte ; done : échange fait.
stage=check
on_exit() {
  local rc=$?
  rm -f "$toc"
  if [ "$rc" -ne 0 ] && [ "$stage" = stopped ]; then
    pg dropdb -U "$DB_USER" --if-exists --force "$TMP_DB" >/dev/null 2>&1 || true
    echo "restore : ÉCHEC, la base « $DB » n'a pas été modifiée. Redémarrage des services." >&2
    docker compose up -d || true
  fi
}
trap on_exit EXIT
pg pg_restore --list <"$file" >"$toc" || die "archive illisible : ce n'est pas une sauvegarde pg_dump valide."
grep -q ' TABLE drizzle __drizzle_migrations ' "$toc" \
  || die "l'archive ne contient pas la table des migrations d'Ant : mauvaise base ou sauvegarde incomplète."
pg pg_restore --file=/dev/null <"$file" || die "archive corrompue : ses données ne se relisent pas entièrement."
echo "    archive valide ($(grep -c ' TABLE DATA ' "$toc") tables avec données)."

if [ "$yes" -ne 1 ]; then
  [ -t 0 ] || die "confirmation impossible sans terminal : ajoute --oui pour confirmer."
  echo
  echo "La base « $DB » va être remplacée par le contenu de cette sauvegarde. Les services web, worker et"
  echo "backup seront arrêtés pendant l'opération. La base actuelle sera conservée sous « $OLD_DB »."
  read -r -p "Tape OUI pour continuer : " answer
  [ "$answer" = "OUI" ] || die "annulé, rien n'a été modifié."
fi

echo "==> Arrêt de web, worker et backup"
stage=stopped
docker compose stop web worker backup

echo "==> Restauration dans la base temporaire « $TMP_DB »"
pg dropdb -U "$DB_USER" --if-exists --force "$TMP_DB"
pg createdb -U "$DB_USER" -O "$DB_USER" "$TMP_DB"
pg pg_restore -U "$DB_USER" -d "$TMP_DB" --exit-on-error --single-transaction <"$file"

echo "==> Échange : « $DB » devient « $OLD_DB », la sauvegarde restaurée devient « $DB »"
psql_admin -c "DROP DATABASE IF EXISTS \"$OLD_DB\" WITH (FORCE)"
psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB', '$TMP_DB') AND pid <> pg_backend_pid()" >/dev/null
psql_admin <<SQL
BEGIN;
ALTER DATABASE "$DB" RENAME TO "$OLD_DB";
ALTER DATABASE "$TMP_DB" RENAME TO "$DB";
COMMIT;
SQL
stage=done

echo
if [ "$restart" -eq 1 ]; then
  echo "==> Redémarrage des services"
  docker compose up -d
  echo
  echo "Restauration terminée. Les migrations du code présent s'appliquent au démarrage de web et worker."
  echo "Vérifie avec « docker compose ps » et « docker compose logs --tail 50 web worker »."
else
  # Point de retour d'une mise à jour inachevée (voir deploy/upgrade.sh) : la version d'avant reste notée.
  upgrade_state="$(git rev-parse --git-path ant-upgrade 2>/dev/null || true)"
  if [ -n "$upgrade_state" ] && [ -f "$upgrade_state" ]; then
    sed -i '/^sauvegarde=/d' "$upgrade_state" || true
  fi
  echo "Restauration terminée. web, worker et backup restent arrêtés : reconstruis la version voulue"
  echo "(git checkout …, docker compose build), puis démarre-les avec « docker compose up -d »."
fi
echo "L'ancienne base est conservée sous « $OLD_DB ». Une fois sûr de toi, supprime-la :"
echo "  docker compose exec -T postgres dropdb -U $DB_USER $OLD_DB"
