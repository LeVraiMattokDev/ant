#!/usr/bin/env bash
# Isolation réseau d'Ant sur la VM (ou le CT LXC) : les conteneurs peuvent sortir sur Internet
# mais ne peuvent ni joindre le réseau local, ni la machine elle-même (SSH, etc.).
# Seule exception vers le LAN : le port 53 des serveurs DNS de la machine (voir plus bas).
# À exécuter en root après le démarrage de Docker (voir ant-firewall.service).
# Relance-le (systemctl restart ant-firewall) si les serveurs DNS de la machine changent.
set -euo pipefail

BRIDGES=(ant-sandbox ant-egress ant-front)
PRIVATE_RANGES=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 224.0.0.0/4)
CHAIN=ANT-ISOLATION
# Fichiers lus pour trouver les serveurs DNS. Le second est celui de systemd-resolved : quand
# /etc/resolv.conf ne contient que 127.0.0.53, Docker utilise les serveurs qui y sont listés.
RESOLV_FILES="${ANT_RESOLV_CONF:-/etc/resolv.conf /run/systemd/resolve/resolv.conf}"

# Serveurs DNS IPv4 de la machine, hors boucle locale. Le résolveur intégré de Docker (127.0.0.11)
# relaie les requêtes depuis l'espace réseau du conteneur : elles traversent donc ce pare-feu.
# Avec un DNS sur le LAN (routeur, Pi-hole : le cas par défaut d'un CT Proxmox), les bloquer
# empêcherait toute résolution de noms (API Anthropic, navigateur des agents, notifications).
dns_servers() {
  local f
  for f in $RESOLV_FILES; do
    if [ -r "$f" ]; then cat "$f"; fi
  done | awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $2 !~ /^127\./ { print $2 }' | sort -u
}
mapfile -t DNS_SERVERS < <(dns_servers)

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

# DNS d'abord : ces règles doivent précéder les refus vers les plages privées.
for br in "${BRIDGES[@]}"; do
  for dns in "${DNS_SERVERS[@]}"; do
    iptables -A "$CHAIN" -i "$br" -d "$dns" -p udp --dport 53 -j RETURN
    iptables -A "$CHAIN" -i "$br" -d "$dns" -p tcp --dport 53 -j RETURN
  done
done

for br in "${BRIDGES[@]}"; do
  for net in "${PRIVATE_RANGES[@]}"; do
    # Nouvelles connexions sortant du pont vers une adresse privée hors de ce pont : refusées.
    iptables -A "$CHAIN" -i "$br" ! -o "$br" -d "$net" -m conntrack --ctstate NEW -j REJECT --reject-with icmp-admin-prohibited
  done
done
iptables -A "$CHAIN" -j RETURN

# Brancher la chaîne en tête de DOCKER-USER (évaluée avant les règles de Docker).
iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"

# Les conteneurs ne doivent pas atteindre les services de la machine (SSH, etc.).
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

if [ "${#DNS_SERVERS[@]}" -gt 0 ]; then
  echo "DNS autorisé (port 53) vers : ${DNS_SERVERS[*]}"
else
  echo "Aucun serveur DNS IPv4 hors boucle locale dans : $RESOLV_FILES (aucune exception DNS ajoutée)"
fi
echo "Isolation Ant appliquée sur : ${BRIDGES[*]}"
