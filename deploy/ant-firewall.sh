#!/usr/bin/env bash
# Isolation réseau d'Ant sur la VM : les conteneurs peuvent sortir sur Internet
# mais ne peuvent ni joindre le réseau local, ni la VM elle-même (SSH, etc.).
# À exécuter en root après le démarrage de Docker (voir ant-firewall.service).
set -euo pipefail

BRIDGES=(ant-sandbox ant-egress ant-front)
PRIVATE_RANGES=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 224.0.0.0/4)
CHAIN=ANT-ISOLATION

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

for br in "${BRIDGES[@]}"; do
  for net in "${PRIVATE_RANGES[@]}"; do
    # Nouvelles connexions sortant du pont vers une adresse privée hors de ce pont : refusées.
    iptables -A "$CHAIN" -i "$br" ! -o "$br" -d "$net" -m conntrack --ctstate NEW -j REJECT --reject-with icmp-admin-prohibited
  done
done
iptables -A "$CHAIN" -j RETURN

# Brancher la chaîne en tête de DOCKER-USER (évaluée avant les règles de Docker).
iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"

# Les conteneurs ne doivent pas atteindre les services de la VM (SSH, etc.).
for br in "${BRIDGES[@]}"; do
  iptables -C INPUT -i "$br" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -i "$br" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -C INPUT -i "$br" -m conntrack --ctstate NEW -j REJECT 2>/dev/null \
    || iptables -A INPUT -i "$br" -m conntrack --ctstate NEW -j REJECT
done

# IPv6 : Ant n'en a pas besoin ; on bloque le transfert IPv6 des ponts Ant s'il est actif.
if command -v ip6tables >/dev/null 2>&1; then
  for br in "${BRIDGES[@]}"; do
    ip6tables -C FORWARD -i "$br" -j DROP 2>/dev/null || ip6tables -I FORWARD 1 -i "$br" -j DROP || true
  done
fi

echo "Isolation Ant appliquée sur : ${BRIDGES[*]}"
