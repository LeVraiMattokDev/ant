# Ant

Ant est ta plateforme personnelle d'agents IA toujours actifs, propulsés par Claude. Elle est auto-hébergée sur ton homelab Proxmox.
Des bots (« Chef de cabinet », « Dev », « Veille »…) travaillent en parallèle et se passent le travail dans des canaux. Ils utilisent
un ordinateur isolé (terminal + Chromium), te relancent de façon proactive et demandent ta validation avant toute action sensible.

- **Architecture et choix** : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **API REST / WebSocket** : [docs/API.md](docs/API.md)

```
apps/server     API web (Fastify) + worker (Agent SDK, planificateur, quota) — même image Docker
apps/ui         Application web / PWA (React)
apps/computer   « Ordinateur » des agents : shell, fichiers, Chromium (Playwright), noVNC, terminal partagé
packages/shared Types, contrat d'API, logique de quota et règles de risque (testés)
deploy/         Pare-feu, sauvegardes, génération du .env
```

---

## 1. Prérequis

| Élément | Recommandation |
|---|---|
| Proxmox VE | 8.x ou plus récent |
| VM | Debian 12 ou 13, **4 vCPU, 8 Go de RAM, 60 Go de disque** |
| Reverse proxy | Ton Nginx Proxy Manager existant |
| Domaine | Un sous-domaine (ex. `ant.mondomaine.ch`) pointant vers NPM |
| Claude | Abonnement Max (+ éventuellement une clé API de la Claude Console) |

---

## 2. Créer la VM dans Proxmox

1. Télécharge l'ISO Debian « netinst » dans le stockage ISO de Proxmox.
2. **Créer une VM** :
   - Général : nom `ant`, cocher « Démarrer au boot ».
   - Système : machine `q35`, contrôleur SCSI `VirtIO SCSI single`, agent QEMU coché.
   - Disque : 60 Go, `discard` et `SSD emulation` cochés si stockage SSD.
   - CPU : 4 cœurs, type `host`.
   - Mémoire : 8192 Mo.
   - Réseau : pont `vmbr0`, modèle `VirtIO`, **case « Pare-feu » cochée**.
3. Installe Debian (installation minimale + « serveur SSH », sans environnement de bureau), puis, en root :
   ```bash
   apt update && apt install -y qemu-guest-agent git openssl curl
   systemctl enable --now qemu-guest-agent
   ```
4. Donne une **adresse IP fixe** à la VM (réservation DHCP sur ton routeur ou `/etc/network/interfaces`).

### Pare-feu Proxmox (le vrai périmètre)

Dans **Datacenter → Pare-feu → Options**, active le pare-feu. Puis dans **VM `ant` → Pare-feu** :

- **Options** : Pare-feu `Oui`, Politique d'entrée `DROP`, Politique de sortie `ACCEPT`.
- **Règles** (dans cet ordre) :

| Sens | Action | Source / Destination | Protocole / port | Rôle |
|---|---|---|---|---|
| IN | ACCEPT | source = IP de Nginx Proxy Manager | tcp 8080 | Accès à Ant via NPM uniquement |
| IN | ACCEPT | source = IP de ton poste d'admin | tcp 22 | SSH |
| OUT | ACCEPT | destination = IP de ton DNS / routeur | udp+tcp 53 | Résolution DNS |
| OUT | DROP | destination = `10.0.0.0/8` | — | Pas d'accès au LAN |
| OUT | DROP | destination = `172.16.0.0/12` | — | Pas d'accès au LAN |
| OUT | DROP | destination = `192.168.0.0/16` | — | Pas d'accès au LAN |
| OUT | DROP | destination = `169.254.0.0/16` | — | Lien local |

Le pare-feu Proxmox suit l'état des connexions : les réponses à NPM passent, mais la VM ne peut ouvrir aucune connexion vers ton réseau.
Adapte les règles si ton LAN utilise d'autres plages. Ce pare-feu s'ajoute à l'isolation interne des conteneurs (§ 6).

---

## 3. Installer Docker sur la VM

Commandes à lancer **en root** (`su -`). Une Debian minimale n'a souvent ni `sudo` ni `gpg`, et ces commandes n'en ont pas besoin :

```bash
apt update && apt install -y ca-certificates curl git openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker run --rm hello-world   # vérification
```

`$ID` vaut `debian` ou `ubuntu` selon le système. Si `apt install` répond « has no installation candidate », c'est que le dépôt
n'a pas été ajouté : vérifie le contenu de `/etc/apt/sources.list.d/docker.list` et la sortie de `apt update`.

> **Conteneur LXC au lieu d'une VM ?** C'est possible, mais déconseillé. L'ordinateur des agents fait tourner un navigateur exposé
> au web : dans une VM, il est isolé par un noyau séparé ; dans un LXC, il partage le noyau de l'hôte Proxmox. Si tu gardes un LXC,
> active **Options → Fonctionnalités → Imbrication et keyctl** (`pct set <id> --features nesting=1,keyctl=1` sur l'hôte),
> redémarre le conteneur, puis installe Docker comme ci-dessus.

## 4. Récupérer Ant et préparer la configuration

```bash
sudo mkdir -p /opt/ant && sudo chown "$USER" /opt/ant
git clone https://github.com/LeVraiMattokDev/ant.git /opt/ant
cd /opt/ant
./deploy/generate-env.sh       # crée .env (droits 600) avec des secrets aléatoires
nano .env                      # renseigne PUBLIC_ORIGIN, identifiants Claude, clés VAPID
```

Tous les secrets sont des **variables d'environnement** du fichier `.env`. Ce fichier n'est jamais versionné et il est lisible seulement par toi.
Les identifiants Claude ne sont transmis **qu'au service `worker`**.

### Connexion à Claude

#### Abonnement Max (jeton longue durée)

Méthode documentée par Anthropic pour les machines sans navigateur ([documentation](https://code.claude.com/docs/en/authentication)) :

1. Sur ton ordinateur, où Claude Code est installé et connecté à ton compte, lance :
   ```bash
   claude setup-token
   ```
2. Copie le jeton affiché (valable **un an**, il n'est enregistré nulle part) dans `.env` :
   `CLAUDE_CODE_OAUTH_TOKEN=...`
3. Après le premier démarrage, renseigne la **date de création du jeton** dans l'écran **Quota & budget**. Ant te préviendra 30 jours avant son expiration.
4. **Renouvellement** : régénère un jeton avec `claude setup-token`, remplace la valeur dans `.env`, puis `docker compose up -d worker`.

> ⚠️ **Conformité.** Les conditions d'Anthropic réservent l'abonnement à un « usage ordinaire et individuel ». Elles n'autorisent pas
> explicitement un fonctionnement autonome 24 h/24 (les détails sont dans [ARCHITECTURE.md § 6.1](docs/ARCHITECTURE.md#61-connexion-à-labonnement-sur-un-serveur-sans-écran)).
> C'est pourquoi le mode par défaut est **« Hybride prudent »** : l'abonnement sert à ce que **tu** déclenches, et le travail
> autonome (heartbeats, routines, résumés, transferts non initiés par toi) passe sur les crédits API. Tu peux changer de mode dans
> l'écran Quota & budget, en connaissance de cause.

#### Crédits API (repli)

1. Dans la [Claude Console](https://platform.claude.com), crée une clé API et mets-la dans `ANTHROPIC_API_KEY`.
2. **Fixe aussi une limite de dépense dans la Console**. C'est le garde-fou côté Anthropic : il s'ajoute aux plafonds d'Ant
   (8 $/jour et 100 $/mois par défaut), car les coûts calculés par Ant sont des estimations de l'Agent SDK.

Sans clé API, Ant fonctionne sur l'abonnement seul. Les tâches autonomes restent alors en pause tant que tu ne passes pas
au mode « Abonnement puis crédits API » ou « Abonnement uniquement ».

### Notifications push (VAPID)

```bash
docker compose build web
docker compose run --rm --no-deps --entrypoint npx web web-push generate-vapid-keys
```
Reporte les deux clés dans `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, et mets ton adresse dans `VAPID_SUBJECT` (`mailto:...`).

---

## 5. Démarrer Ant

```bash
cd /opt/ant
docker compose build          # quelques minutes (Chromium, Playwright, interface)
docker compose up -d
docker compose ps
docker compose logs web | grep -i "jeton d’initialisation"   # si SETUP_TOKEN est vide
```

Les migrations de la base s'appliquent automatiquement au démarrage.

---

## 6. Isolation réseau des conteneurs

Active le script d'isolation : les conteneurs peuvent sortir sur Internet, mais pas vers ton LAN ni vers la VM.

```bash
sudo cp deploy/ant-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ant-firewall
```

Vérification :
```bash
docker compose exec computer curl -s -m 5 -o /dev/null -w "%{http_code}\n" https://example.com   # 200
docker compose exec computer curl -s -m 5 http://192.168.1.1 || echo "bloqué ✔"                 # bloqué
docker compose exec worker node -e "fetch('http://192.168.1.1').then(()=>console.log('OUVERT ✘')).catch(()=>console.log('bloqué ✔'))"
```

Autres protections en place :
- l'ordinateur des agents n'a **aucun secret** et tourne sans privilèges (`cap_drop: ALL`, `no-new-privileges`, limites de mémoire et de processus) ;
- les outils du SDK qui agissent sur la machine locale (shell, fichiers, WebFetch) sont **désactivés** dans le worker ;
- la base PostgreSQL est sur un réseau Docker sans accès extérieur.

---

## 7. Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host** :

- Domain Names : `ant.mondomaine.ch`
- Scheme `http`, Forward Hostname/IP : IP de la VM, Forward Port : `8080`
- ✅ **Websockets Support**, ✅ Block Common Exploits
- Onglet SSL : certificat Let's Encrypt, ✅ Force SSL, ✅ HTTP/2, ✅ HSTS
- Onglet Advanced :
  ```nginx
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  client_max_body_size 5m;
  ```

Dans `.env`, mets `TRUST_PROXY=<IP de NPM>` pour que seule l'adresse transmise par NPM soit prise en compte (limitation des tentatives par IP).

`PUBLIC_ORIGIN` dans `.env` doit être exactement `https://ant.mondomaine.ch`. Les passkeys, les cookies sécurisés et la
vérification d'origine en dépendent.

---

## 8. Première connexion

1. Ouvre `https://ant.mondomaine.ch/setup`.
2. Saisis le jeton d'initialisation (`SETUP_TOKEN`) et un mot de passe d'au moins 14 caractères.
3. Scanne le QR code avec ton application TOTP, puis entre le code.
4. **Conserve les 10 codes de secours** (gestionnaire de mots de passe).
5. Dans **Réglages → Sécurité**, ajoute une **passkey** (Face ID, Touch ID, Windows Hello, clé FIDO2).
6. Dans **Réglages → Notifications**, active les notifications push. Sur iPhone, installe d'abord Ant sur l'écran d'accueil
   (Partager → « Sur l'écran d'accueil ») : iOS n'autorise les push que pour les PWA installées.

### Créer tes bots

Quelques exemples (écran **Bots → Nouveau bot**) :

| Bot | Rôle | Permissions conseillées |
|---|---|---|
| Chef de cabinet | Coordonne les autres bots, tient tes priorités, prépare le résumé quotidien | Mémoire partagée en écriture, transferts, sous-agent expert |
| Dev | Développement, débogage, revue de code dans `/workspace` | Terminal, fichiers, navigateur, sous-agents |
| Veille | Surveille des sujets et te propose ce qui compte | Recherche web, navigateur, sous-agent léger |
| Gestion X | Prépare des publications pour X (publication soumise à validation) | Navigateur |

Chaque bot utilise par défaut **Claude Sonnet 5.5 avec un effort moyen**. Il peut déléguer à **Haiku 5.5** (sous-agent « léger »)
ou à **Opus 5.5 effort élevé** (sous-agent « expert »). Le fil indique alors le modèle choisi et la raison.

---

## 9. Exploitation

### Mettre à jour
```bash
cd /opt/ant && git pull && docker compose build && docker compose up -d
```

### Sauvegardes
- Le service `backup` fait un `pg_dump` chaque nuit (3 h par défaut) dans `BACKUP_DIR` (`./backups`), avec une conservation de 14 jours.
  Monte idéalement ce dossier sur ton NAS ou ton stockage de sauvegarde.
- Restaurer la base :
  ```bash
  docker compose stop web worker
  docker compose exec -T postgres pg_restore -U ant -d ant --clean --if-exists < backups/ant-AAAA-MM-JJ.dump
  docker compose start web worker
  ```
- Les volumes `workspace`, `browser-profile` (connexions aux sites) et `claude-state` (sessions des agents) sont couverts par
  une sauvegarde **vzdump** de la VM dans Proxmox (recommandée, quotidienne).

### Journaux
```bash
docker compose logs -f worker        # exécutions des bots, bascules, planificateur
docker compose logs -f web
```
L'écran **Audit** liste toutes les actions des agents et les connexions. Il est exportable en CSV.

### Dépannage
| Symptôme | Piste |
|---|---|
| Les bots répondent « en pause » | Écran Quota & budget : abonnement limité, plafond API atteint ou aucune clé API en mode hybride |
| « jeton d'abonnement refusé » | Jeton expiré ou révoqué : régénère-le (§ 4) puis redémarre le worker |
| Vue Ordinateur hors ligne | `docker compose logs computer` ; vérifie que `COMPUTER_RPC_TOKEN` est identique pour les trois services |
| Pas de notifications | Clés VAPID présentes ? Sur iPhone, PWA installée ? Bouton « Tester » dans Réglages |
| Passkey refusée | `PUBLIC_ORIGIN` doit correspondre exactement au domaine utilisé dans le navigateur |

---

## 10. Développement local

```bash
corepack enable && pnpm install
# PostgreSQL local : DATABASE_URL=postgres://...
export DATABASE_URL=postgres://postgres@localhost:5432/ant_dev ENCRYPTION_KEY=$(openssl rand -hex 32) PUBLIC_ORIGIN=http://localhost:5173
pnpm dev:web      # API sur :8080
pnpm dev:worker   # worker (CLAUDE_CODE_OAUTH_TOKEN et/ou ANTHROPIC_API_KEY dans l'environnement)
pnpm dev:ui       # interface sur :5173 (proxy vers :8080)
pnpm test         # tests (les tests d'intégration utilisent TEST_DATABASE_URL, par défaut postgres://postgres@localhost:5432/postgres)
pnpm typecheck
```
