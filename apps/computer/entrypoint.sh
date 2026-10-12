#!/usr/bin/env bash
# Démarre l'écran virtuel (Xvfb + openbox), le serveur VNC local, puis le service Node.
# Xvfb, openbox et x11vnc sont relancés automatiquement s'ils s'arrêtent.
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
VNC_PORT="${VNC_PORT:-5900}"
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
  # -localhost : seul le pont WebSocket authentifié du service Node (/vnc) y accède.
  wait_for_x && x11vnc -display "$DISPLAY" -forever -shared -rfbport "$VNC_PORT" -localhost -nopw -quiet -noxdamage
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

mkdir -p /tmp/.X11-unix 2>/dev/null || true

supervise Xvfb run_xvfb
if wait_for_x; then
  log "écran $DISPLAY prêt"
else
  log "Xvfb n'a pas démarré à temps (nouvelles tentatives en arrière-plan)"
fi
supervise openbox run_openbox
supervise x11vnc run_x11vnc

exec node /app/dist/index.js
