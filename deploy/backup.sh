#!/bin/sh
# Sauvegarde quotidienne de la base (pg_dump compressé) avec rotation.
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-3}"
echo "[backup] sauvegarde quotidienne à ${HOUR}h, conservation ${KEEP} jours, dans /backups"
last=""
while true; do
  today="$(date +%F)"
  if [ "$(date +%H)" -ge "$HOUR" ] && [ "$last" != "$today" ] && [ ! -f "/backups/ant-${today}.dump" ]; then
    tmp="/backups/.ant-${today}.dump.tmp"
    if pg_dump --format=custom --compress=9 --file="$tmp"; then
      mv "$tmp" "/backups/ant-${today}.dump"
      echo "[backup] OK : ant-${today}.dump ($(du -h "/backups/ant-${today}.dump" | cut -f1))"
      find /backups -name 'ant-*.dump' -mtime +"$KEEP" -delete
    else
      rm -f "$tmp"
      echo "[backup] ÉCHEC du pg_dump" >&2
    fi
    last="$today"
  fi
  sleep 600
done
