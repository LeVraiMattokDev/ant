#!/bin/sh
# Sauvegardes de la base (pg_dump compressé), vérifiées, avec rotation. Script du service « backup ».
#   sh /backup.sh               boucle : une sauvegarde par jour à partir de BACKUP_HOUR
#   sh /backup.sh --once NOM    une sauvegarde vérifiée immédiate dans NOM.dump (deploy/upgrade.sh)
#   sh /backup.sh --check       état pour le healthcheck Docker (0 = sain)
# Connexion : PGHOST, PGUSER, PGPASSWORD, PGDATABASE. Réglages : BACKUP_KEEP_DAYS (14), BACKUP_HOUR (3),
# BACKUP_MAX_ATTEMPTS (6 tentatives par jour au plus), BACKUP_INTERVAL (600 s entre deux tentatives),
# BACKUP_MAX_AGE_HOURS (36 : au-delà sans sauvegarde réussie, le conteneur est « unhealthy »).
set -eu
# Les dumps contiennent le hash du mot de passe, le secret TOTP chiffré et les conversations : root seulement.
umask 077

DIR="${BACKUP_PATH:-/backups}"
STATE="${BACKUP_STATE_DIR:-/tmp}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-3}"
MAX_ATTEMPTS="${BACKUP_MAX_ATTEMPTS:-6}"
INTERVAL="${BACKUP_INTERVAL:-600}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"
ERROR_FILE="$STATE/ant-backup.error"
STARTED_FILE="$STATE/ant-backup.started"

log() { echo "[backup] $*"; }
err() { echo "[backup] $*" >&2; }

child=""
tmp=""
last_error=""
stop_code=0
# docker compose stop/down : on arrête proprement (sans laisser de fichier temporaire), tout de suite.
stop() {
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [ -n "$tmp" ]; then rm -f "$tmp"; fi
  exit "$stop_code"
}
trap stop TERM INT

# Lance la commande en arrière-plan puis l'attend : un signal est ainsi traité immédiatement, même
# pendant un pg_dump ou l'attente entre deux passages, y compris quand ce script est le PID 1.
# À appeler dans une condition (if, ||) : son code de retour est celui de la commande.
run() {
  "$@" &
  child=$!
  rc=0
  wait "$child" || rc=$?
  child=""
  return "$rc"
}

# Vérifie une archive : table des matières lisible, table des migrations présente (bonne base, schéma
# appliqué), puis lecture complète des données (détecte une archive tronquée ou corrompue).
check_archive() {
  toc="$STATE/ant-backup.$$.toc"
  if ! run pg_restore --list --file="$toc" "$1"; then
    rm -f "$toc"
    err "archive illisible (pg_restore --list a échoué)"
    return 1
  fi
  if ! grep -q ' TABLE drizzle __drizzle_migrations ' "$toc"; then
    rm -f "$toc"
    err "archive incomplète : pas de table des migrations (mauvaise base, ou schéma jamais créé ?)"
    return 1
  fi
  rm -f "$toc"
  if ! run pg_restore --file=/dev/null "$1"; then
    err "archive corrompue : les données ne se relisent pas (pg_restore)"
    return 1
  fi
}

# Écrit une sauvegarde vérifiée dans $DIR/NOM.dump. Rien n'est créé sous ce nom en cas d'échec.
dump() {
  name="$1"
  final="$DIR/$name.dump"
  tmp="$DIR/.$name.dump.tmp"
  started=$(date +%s)
  if ! run pg_dump --format=custom --compress=9 --file="$tmp"; then
    rm -f "$tmp"
    tmp=""
    err "ÉCHEC du pg_dump ($name)"
    last_error="pg_dump a échoué"
    return 1
  fi
  if ! check_archive "$tmp"; then
    rm -f "$tmp"
    tmp=""
    err "ÉCHEC de la vérification ($name) : sauvegarde écartée"
    last_error="archive invalide"
    return 1
  fi
  mv "$tmp" "$final"
  tmp=""
  log "OK : $name.dump ($(du -h "$final" | cut -f1), $(($(date +%s) - started)) s, archive vérifiée)"
}

check_health() {
  if [ -f "$ERROR_FILE" ]; then
    echo "dernière tentative en échec : $(cat "$ERROR_FILE")"
    return 1
  fi
  minutes=$((MAX_AGE_HOURS * 60))
  if [ -n "$(find "$DIR" -maxdepth 1 -name 'ant-*.dump' -mmin -"$minutes" 2>/dev/null | head -n 1)" ]; then
    echo "sauvegarde de moins de ${MAX_AGE_HOURS} h présente"
    return 0
  fi
  if [ -f "$STARTED_FILE" ] && [ -n "$(find "$STARTED_FILE" -mmin -"$minutes" 2>/dev/null)" ]; then
    echo "service démarré récemment : première sauvegarde à partir de ${HOUR} h"
    return 0
  fi
  echo "aucune sauvegarde réussie depuis plus de ${MAX_AGE_HOURS} h dans $DIR"
  return 1
}

once() {
  stop_code=143
  case "$1" in
    '' | */* | .*)
      err "nom de sauvegarde invalide : « $1 »"
      exit 2
      ;;
  esac
  if [ ! -d "$DIR" ]; then
    err "dossier de sauvegarde absent : $DIR"
    exit 1
  fi
  if [ -e "$DIR/$1.dump" ]; then
    err "$DIR/$1.dump existe déjà"
    exit 1
  fi
  dump "$1" || exit 1
}

loop() {
  log "sauvegarde quotidienne à partir de ${HOUR} h, conservation ${KEEP} jours, dans $DIR (${MAX_ATTEMPTS} tentatives par jour au plus)"
  chmod 700 "$DIR" 2>/dev/null || true
  # Sauvegardes créées avant le passage en 0600, et restes d'un dump interrompu.
  find "$DIR" -maxdepth 1 -name 'ant-*.dump' -type f -exec chmod 600 {} \; 2>/dev/null || true
  find "$DIR" -maxdepth 1 -name '.ant-*.dump.tmp' -type f -exec rm -f {} \; 2>/dev/null || true
  rm -f "$ERROR_FILE"
  touch "$STARTED_FILE"
  day=""
  attempts=0
  while :; do
    today="$(date +%F)"
    if [ "$today" != "$day" ]; then
      day="$today"
      attempts=0
    fi
    hour="$(date +%H)"
    hour="${hour#0}"
    if [ "$hour" -ge "$HOUR" ] && [ ! -f "$DIR/ant-$today.dump" ] && [ "$attempts" -lt "$MAX_ATTEMPTS" ]; then
      attempts=$((attempts + 1))
      if dump "ant-$today"; then
        rm -f "$ERROR_FILE"
        find "$DIR" -maxdepth 1 -name 'ant-*.dump' -type f -mtime +"$KEEP" -exec rm -f {} \; || err "rotation des anciennes sauvegardes impossible"
      else
        printf '%s : %s (tentative %s/%s)\n' "$(date '+%F %H:%M')" "$last_error" "$attempts" "$MAX_ATTEMPTS" >"$ERROR_FILE"
        if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
          err "ABANDON pour aujourd'hui après $attempts échecs : vérifie la base (docker compose ps postgres) et l'espace disque. Prochain essai demain à partir de ${HOUR} h."
        else
          err "nouvelle tentative dans ${INTERVAL} s (tentative $attempts/$MAX_ATTEMPTS)"
        fi
      fi
    fi
    run sleep "$INTERVAL" || true
  done
}

case "${1:-}" in
  --check)
    check_health
    ;;
  --once)
    once "${2:-}"
    ;;
  '')
    loop
    ;;
  *)
    err "usage : backup.sh [--once NOM | --check]"
    exit 2
    ;;
esac
