#!/usr/bin/env bash
# Démarre l'écran virtuel (Xvfb + openbox), le serveur VNC local, puis le service Node.
# Xvfb, openbox et x11vnc sont relancés automatiquement s'ils s'arrêtent.
# Sourcé (tests), le script définit seulement ses fonctions sans rien lancer.
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
# Socket unix de x11vnc (dans un dossier 0700) : doit correspondre à VNC_SOCKET côté Node.
VNC_SOCKET="${VNC_SOCKET:-/tmp/.ant-vnc/vnc.sock}"
DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

log() { echo "[entrypoint] $*" >&2; }

wait_for_x() {
  for _ in $(seq 1 100); do
    [ -S "$X_SOCKET" ] && return 0
    sleep 0.1
  done
  return 1
}

run_xvfb() {
  # Verrou / socket orphelins d'une instance précédente : empêcheraient le redémarrage.
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "$X_SOCKET"
  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp
}

run_openbox() {
  wait_for_x && openbox
}

run_x11vnc() {
  # AUCUN port TCP (-rfbport 0, -no6) : Chromium partage la pile réseau du conteneur, et une page web
  # visitée par un agent pourrait ouvrir ws://127.0.0.1:<port> (RFB sans mot de passe) pour voir et
  # piloter l'écran. Une page web ne peut pas ouvrir de socket unix : seul le pont WebSocket /vnc
  # du service Node, authentifié par le jeton, s'y connecte.
  local dir
  dir="$(dirname "$VNC_SOCKET")"
  mkdir -p "$dir" && chmod 700 "$dir" && rm -f "$VNC_SOCKET" || return 1
  wait_for_x || return 1
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 0 -no6 -localhost -unixsock "$VNC_SOCKET" -nopw -quiet -noxdamage
}

# Le dossier personnel est un tmpfs vide à chaque démarrage (docker-compose.yml) : il cache les fichiers de
# /etc/skel (.bashrc, .profile) posés par useradd. Les remettre donne aux shells des agents et au terminal partagé
# leur configuration habituelle. Un fichier déjà présent n'est jamais remplacé.
seed_home() {
  local skel="${SKEL_DIR:-/etc/skel}" home="${HOME:-/home/agent}" src name
  [ -d "$skel" ] && [ -d "$home" ] && [ -w "$home" ] || return 0
  for src in "$skel"/.[!.]* "$skel"/*; do
    [ -f "$src" ] || continue
    name="$(basename "$src")"
    [ -e "$home/$name" ] || cp -p "$src" "$home/$name" 2>/dev/null || log "copie de $name dans $home impossible"
  done
}

# Boucle de supervision minimale : relance la commande 1 s après chaque arrêt.
supervise() {
  local name="$1"
  shift
  (
    set +e
    while true; do
      "$@"
      log "$name s'est arrêté (code $?), redémarrage dans 1 s"
      sleep 1
    done
  ) &
}

main() {
  mkdir -p /tmp/.X11-unix 2>/dev/null || true
  seed_home

  supervise Xvfb run_xvfb
  if wait_for_x; then
    log "écran $DISPLAY prêt"
  else
    log "Xvfb n'a pas démarré à temps (nouvelles tentatives en arrière-plan)"
  fi
  supervise openbox run_openbox
  supervise x11vnc run_x11vnc

  exec node /app/dist/index.js
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
