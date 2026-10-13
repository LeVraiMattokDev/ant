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
deploy/         Pare-feu, sauvegardes, mise à jour, restauration, génération du .env
```

---

## 1. Prérequis

| Élément | Recommandation |
|---|---|
| Proxmox VE | 8.x ou plus récent |
| VM (ou CT LXC, § 3) | Debian 12 ou 13, **4 vCPU, 8 Go de RAM, 60 Go de disque** |
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

Dans **Datacenter → Pare-feu → Options**, active le pare-feu. Puis dans **VM `ant` → Pare-feu** (ou **CT 108 → Pare-feu** pour un conteneur LXC) :

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

### Variante : conteneur LXC (par exemple CT 108)

C'est possible, mais moins isolé qu'une VM : l'ordinateur des agents fait tourner un navigateur exposé au web. Dans une VM, il est
isolé par un noyau séparé ; dans un LXC, il partage le noyau de l'hôte Proxmox. Les exemples utilisent l'identifiant **108** : remplace-le
par celui de ton CT. Ce qui change par rapport à une VM :

1. **Création** : CT **non privilégié** (le défaut de Proxmox), modèle Debian 12, 4 cœurs, 8192 Mo de RAM, 60 Go de disque,
   adresse IP fixe, **case « Pare-feu » cochée** sur l'interface réseau `net0`.
2. **Fonctionnalités nécessaires à Docker**, sur l'hôte Proxmox, puis redémarrage du CT :
   ```bash
   pct set 108 --features nesting=1,keyctl=1
   pct reboot 108
   ```
3. **Pare-feu** : mêmes règles qu'au § 2, dans **CT 108 → Pare-feu**. Vérifie dans **CT 108 → Réseau → net0** que la case
   « Pare-feu » est bien cochée, sinon les règles ne s'appliquent pas.
4. **Docker** : installe-le dans le CT comme ci-dessus (sans `qemu-guest-agent`, inutile dans un CT). Vérifie ensuite le pilote de
   stockage : `docker info | grep "Storage Driver"` doit afficher `overlay2`. Avec `vfs` (ancien stockage ZFS sans overlay), chaque
   image occupe plusieurs fois sa taille et le disque se remplit : mets Proxmox à jour (ZFS 2.2 ou plus récent) ou place le disque du
   CT sur un stockage ext4 ou LVM-thin.
5. **DNS** : le CT reprend par défaut le DNS de l'hôte (souvent ton routeur ou un Pi-hole, donc une adresse du LAN). Le script
   d'isolation (§ 6) l'autorise automatiquement, sur le port 53 seulement. Si tu changes le DNS du CT (**CT 108 → DNS**), relance
   `systemctl restart ant-firewall`.
6. **Sauvegardes sur ton NAS** : un CT non privilégié ne peut pas monter lui-même un partage NFS ou SMB (`mount: permission denied`).
   Ajoute le partage **sur l'hôte** (Datacenter → Stockage → Ajouter → NFS ou SMB/CIFS ; il apparaît sous `/mnt/pve/<nas>`), puis,
   sur l'hôte :
   ```bash
   mkdir -p /mnt/pve/<nas>/ant
   chown 100000:100000 /mnt/pve/<nas>/ant   # root du CT = uid 100000 sur l'hôte
   chmod 700 /mnt/pve/<nas>/ant
   pct set 108 --mp0 /mnt/pve/<nas>/ant,mp=/srv/ant-backups
   ```
   Dans le `.env` du CT, mets `BACKUP_DIR=/srv/ant-backups`. Si le NAS refuse l'écriture, le service `backup` le signale (§ 9).
   - **SMB/CIFS** : `chown` et `chmod` sont sans effet, les droits viennent des options de montage. Proxmox monte le partage avec
     ses propres options : ajoute celles-ci au stockage, sur l'hôte et CT 108 arrêté, puis démonte-le pour que Proxmox le remonte
     avec elles (quelques secondes) :
     ```bash
     pvesm set <nas> --options uid=100000,gid=100000,file_mode=0600,dir_mode=0700
     umount /mnt/pve/<nas>
     ```
     Ces options valent pour tout le stockage. Si tu préfères ne pas y toucher, monte le partage toi-même dans `/etc/fstab` de l'hôte,
     avec les mêmes options, et utilise ce dossier à la place de `/mnt/pve/<nas>/ant`.
   - **NFS** : la plupart des NAS « écrasent » root (`root_squash`, chez Synology « Mapper root sur… ») : le root de l'hôte n'y a
     aucun droit, et `mkdir` ou `chown` ci-dessus échouent. Crée alors le dossier `ant` depuis le NAS et donne-le à l'uid 100000
     (en SSH sur le NAS : `chown 100000:100000 <dossier>/ant && chmod 700 <dossier>/ant`), ou autorise root de l'hôte le temps
     de ces commandes (`no_root_squash`, « Aucun mappage » chez Synology). Le CT écrit ensuite avec l'uid 100000, que le NAS
     n'écrase pas.
   - **Démarrage** : Proxmox refuse de démarrer un CT dont le dossier source d'un point de montage n'existe pas. Si le NAS n'est pas
     encore monté au démarrage de l'hôte (coupure de courant, NAS plus lent à démarrer, NAS dans une VM de ce même Proxmox),
     le CT 108 et donc Ant ne démarrent pas. Retarde le démarrage automatique des invités, sur l'hôte :
     `pvenode config set --startall-onboot-delay 120` (en secondes). Pour une VM NAS sur cet hôte, fais-la plutôt démarrer en
     premier : `qm set <id du NAS> --startup order=1,up=120` et `pct set 108 --startup order=2`. Après un redémarrage de l'hôte,
     vérifie `pct status 108`. Si le NAS est en panne, `pct set 108 --delete mp0 && pct start 108` démarre Ant sans lui (les dumps
     vont alors sur le disque du CT) ; remets `mp0` une fois le NAS revenu.
7. **vzdump** : la sauvegarde du CT dans Proxmox couvre les volumes Docker (`/var/lib/docker/volumes`, sur le disque du CT). Un point
   de montage d'un dossier de l'hôte comme `mp0` n'y est pas inclus, ce qui est voulu ici : les dumps sont déjà sur le NAS.

## 4. Récupérer Ant et préparer la configuration

```bash
mkdir -p /opt/ant
git clone https://github.com/LeVraiMattokDev/ant.git /opt/ant
cd /opt/ant
./deploy/generate-env.sh       # crée .env (droits 600) avec des secrets aléatoires
nano .env                      # renseigne PUBLIC_ORIGIN, identifiants Claude, clés VAPID
```

Tous les secrets sont des **variables d'environnement** du fichier `.env`. Ce fichier n'est jamais versionné et il est lisible seulement par toi.
Les identifiants Claude ne sont transmis **qu'au service `worker`**.

**Garde une copie de `.env` hors de la machine** (gestionnaire de mots de passe), au minimum `ENCRYPTION_KEY` : le secret TOTP est
chiffré avec cette clé. Sans elle, une sauvegarde restaurée sur une machine réinstallée n'accepte plus les codes TOTP, seulement les
codes de secours et les passkeys.

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
au mode « Abonnement puis crédits API » ou « Abonnement uniquement » : 6 h au plus, après quoi elles sont abandonnées
avec un message ⏹️ dans leur conversation (une routine repart à sa prochaine occurrence).

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
grep ^SETUP_TOKEN= .env       # jeton d'initialisation, à saisir au § 8
```

Les migrations de la base s'appliquent automatiquement au démarrage. Si `SETUP_TOKEN` est vide dans `.env`, Ant génère un jeton
à chaque démarrage et l'affiche dans `docker compose logs web`.

---

## 6. Isolation réseau des conteneurs

Active le script d'isolation : les conteneurs peuvent sortir sur Internet, mais pas vers ton LAN ni vers la VM. Seule exception :
le port 53 des serveurs DNS de la machine (lus dans `/etc/resolv.conf`), pour que la résolution de noms fonctionne quand ton DNS
est sur le LAN (routeur, Pi-hole).

```bash
cp deploy/ant-firewall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ant-firewall
```

Vérification :
```bash
docker compose exec computer getent hosts example.com                                              # une adresse IP
docker compose exec computer curl -s -m 5 -o /dev/null -w "%{http_code}\n" https://example.com   # 200
docker compose exec computer curl -s -m 5 http://192.168.1.1 || echo "bloqué ✔"                 # bloqué
docker compose exec worker node -e "fetch('http://192.168.1.1').then(()=>console.log('OUVERT ✘')).catch(()=>console.log('bloqué ✔'))"
```

Si le DNS de la machine change, relance `systemctl restart ant-firewall`.

Autres protections en place :
- l'ordinateur des agents n'a **aucun secret** et tourne sans privilèges (`cap_drop: ALL`, `no-new-privileges`, limites de mémoire et de processus) ;
- sa racine est **en lecture seule** : seuls `/workspace`, le profil du navigateur, `/tmp` et le dossier personnel sont modifiables, et
  ces deux derniers sont vidés à chaque redémarrage (un fichier piégé par un agent, comme `~/.bashrc`, ne survit pas). Ils sont
  **en mémoire** (768 Mo pour `/tmp`, où Chromium place aussi sa mémoire partagée, et 512 Mo pour le dossier personnel), pris sur
  `COMPUTER_MEMORY` : le cache de pip est désactivé, celui de npm est dans `/workspace/.cache/npm`, et les gros outils
  (environnement virtuel Python, `node_modules`) s'installent dans `/workspace`, sur le disque ;
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

**Adresse IP des clients (`TRUST_PROXY`).** Ant limite les tentatives de connexion par adresse IP et l'inscrit dans l'Audit. Elle
la lit dans l'en-tête `X-Forwarded-For`, mais seulement s'il vient d'un proxy de confiance. Par défaut
(`TRUST_PROXY=loopback,linklocal,uniquelocal`), toutes les adresses privées le sont : NPM sur ton LAN, mais aussi les autres
appareils du LAN et les réseaux Docker, dont celui de l'ordinateur des agents. Un client sur Internet ne peut pas choisir son
adresse ; un agent piégé par une page web, lui, pourrait envoyer depuis son ordinateur des tentatives de connexion sous de fausses
adresses, contourner ainsi la limite par adresse, te bloquer la connexion pendant une heure (limite globale) et fausser l'Audit.

**Juste après la première connexion (§ 8), indique donc l'adresse exacte de NPM** telle qu'Ant la voit : **Réglages →
Sécurité → Adresse du proxy** l'affiche (ou `https://ant.mondomaine.ch/api/system/network`, champ `peerAddress`, sans le
préfixe `::ffff:`) ; reporte-la dans `TRUST_PROXY` (par exemple `TRUST_PROXY=192.168.1.20`), puis lance
`docker compose up -d web`. Recharge la page : « Ton adresse retenue » (`clientIp`) doit toujours être ton adresse, pas
celle de NPM (sinon, l'adresse saisie est fausse). Si l'adresse de NPM change, refais de même.
Ne mets jamais `TRUST_PROXY=true` : NPM ajoute l'adresse réelle à la fin de l'en-tête, et Ant retiendrait alors la première,
choisie par le client. Ancienne valeur par défaut, elle est remplacée automatiquement par `deploy/upgrade.sh`.

`PUBLIC_ORIGIN` dans `.env` doit être exactement `https://ant.mondomaine.ch`. Les passkeys, les cookies sécurisés et la
vérification d'origine en dépendent.

---

## 8. Première connexion

1. Ouvre `https://ant.mondomaine.ch/setup`.
2. Saisis le jeton d'initialisation, affiché par `grep ^SETUP_TOKEN= /opt/ant/.env` (si la valeur est vide, le jeton est dans
   `docker compose logs web` et change à chaque redémarrage), puis un mot de passe d'au moins 14 caractères.
3. Scanne le QR code avec ton application TOTP, puis entre le code.
4. **Conserve les 10 codes de secours** (gestionnaire de mots de passe).
5. Dans **Réglages → Sécurité**, ajoute une **passkey** (Face ID, Touch ID, Windows Hello, clé FIDO2).
6. Dans **Réglages → Notifications**, active les notifications push. Sur iPhone, installe d'abord Ant sur l'écran d'accueil
   (Partager → « Sur l'écran d'accueil ») : iOS n'autorise les push que pour les PWA installées.
7. Mets l'adresse exacte de Nginx Proxy Manager dans `TRUST_PROXY` (§ 7) : sans cela, l'ordinateur des agents peut choisir
   son adresse IP auprès d'Ant.

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

### Connecter le navigateur des agents à tes comptes

Les bots qui ont la permission Navigateur utilisent un Chromium à profil persistant. Connecte-le toi-même, une fois par site
(X, Google…), sans jamais donner ton mot de passe à un bot :

1. Demande à un bot qui a la permission Navigateur d'ouvrir la page de connexion, par exemple « ouvre https://x.com/login et attends ».
   Chromium ne démarre qu'à la première action d'un bot : sans cela, l'écran reste vide.
2. Ouvre **Ordinateur → Écran**, puis clique sur **Prendre la main**. Sans cela, l'écran est en lecture seule. Tant que tu as la main,
   les bots n'utilisent plus l'ordinateur.
3. Connecte-toi dans l'écran, 2FA comprise. Tu peux saisir d'autres adresses dans la barre d'adresse de Chromium.
4. Clique sur **Rendre la main aux agents** : le bot est prévenu et reprend sa tâche.

Les cookies restent dans le volume `browser-profile` (couvert par vzdump, § 9). Si un site te déconnecte, refais la même chose.
Une session connectée permet à tout bot qui a la permission Navigateur d'agir en ton nom sur ce site : ajoute-le dans
**Réglages → Domaines sensibles** pour que chaque clic ou touche Entrée y demande ta validation.

---

## 9. Exploitation

### Mettre à jour

```bash
cd /opt/ant && ./deploy/upgrade.sh
```

Première fois, sur une installation qui n'a pas encore ce script :

```bash
cd /opt/ant && avant=$(git rev-parse HEAD) && git pull && ./deploy/upgrade.sh --depuis "$avant"
```

Le script :
1. refuse de continuer s'il y a des modifications locales dans le dépôt, et note la version actuelle ;
2. fait `git pull`, puis reconstruit les images avec `--pull` (correctifs de sécurité de l'image `node:22-bookworm-slim`) ;
3. fait une **sauvegarde vérifiée** de la base (`ant-avant-maj-<date>-<version>.dump` dans `BACKUP_DIR`) : les migrations
   s'appliquent au redémarrage, et la sauvegarde nocturne peut dater de près de 24 h ;
4. récupère la dernière image PostgreSQL 17 (`docker compose pull postgres backup`), redémarre et attend que `web` soit en bonne santé ;
5. supprime les anciennes images (`docker image prune -f`) et le cache de construction de plus de 7 jours, sinon le disque se remplit
   au fil des mises à jour ;
6. affiche la commande de retour arrière.

**En cas d'échec**, le script dit où il s'est arrêté :
- **avant le redémarrage** (construction des images, Docker Hub qui limite les téléchargements, sauvegarde) : Ant tourne toujours
  sur l'ancienne version et la base n'a pas changé, mais le code, et peut-être les images, sont déjà à la nouvelle. Ne lance pas
  `docker compose up` d'ici là (pas même `docker compose up -d web` après un changement de `.env`) : la nouvelle version
  démarrerait et appliquerait ses migrations sans sauvegarde préalable. Une fois le problème réglé, relance simplement
  `./deploy/upgrade.sh` ;
- **après le redémarrage** (`web` ou `worker` ne démarre pas) : le script affiche la marche à suivre pour revenir en arrière
  (ci-dessous). Si tu préfères corriger le problème et relancer `./deploy/upgrade.sh`, la sauvegarde prise avant la première
  tentative reste celle du retour arrière.

Tant qu'une mise à jour n'a pas réussi, la version d'avant reste la cible du retour arrière (elle est notée dans
`.git/ant-upgrade`) : pas besoin de `--depuis` pour relancer. Si seule l'image PostgreSQL ne peut pas être téléchargée, la mise
à jour continue avec l'image déjà présente. Le script remplace aussi l'ancienne valeur `TRUST_PROXY=true` de `.env` (§ 7).

**Revenir à la version précédente** (le script affiche les valeurs exactes) :

```bash
cd /opt/ant
./deploy/restore.sh /var/backups/ant/ant-avant-maj-AAAA-MM-JJ-HHMMSS-<version>.dump --sans-redemarrage
git checkout <version précédente>
docker compose build && docker compose up -d
```

La base est restaurée d'abord, services arrêtés : la nouvelle version ne redémarre pas dessus (elle y réappliquerait ses
migrations), et l'ancienne n'a pas forcément `restore.sh`. Tu es ensuite sur une version figée : `upgrade.sh` refuse de tourner
tant que tu n'es pas revenu sur la branche. Une fois une version corrigée publiée : `git checkout main && ./deploy/upgrade.sh`.
Cette mise à jour-là prend sa propre sauvegarde, et son retour arrière vise toujours la version restaurée.

### Sauvegardes

- Le service `backup` fait chaque nuit (3 h par défaut, `BACKUP_HOUR`) un `pg_dump` dans `BACKUP_DIR` (`/var/backups/ant` par défaut,
  hors du dépôt git), conservé 14 jours (`BACKUP_KEEP_DAYS`, sauvegardes d'avant mise à jour comprises).
- **Chaque sauvegarde est vérifiée** avant d'être gardée : table des matières lisible, table des migrations présente, relecture
  complète des données. En cas d'échec (base en cours de redémarrage, disque plein…), le service réessaie toutes les 10 minutes,
  6 fois au plus dans la journée.
- **État** : `docker compose ps backup` affiche `unhealthy` si la dernière tentative a échoué ou si aucune sauvegarde n'a réussi depuis
  36 h. Détail : `docker compose logs --tail 20 backup`.
- Les fichiers sont lisibles par root seulement (droits 600) : lance les commandes de restauration en root.
- Mets idéalement `BACKUP_DIR` sur ton NAS (dans un CT LXC : § 3, point 6). Si ton `.env` contient encore l'ancien
  `BACKUP_DIR=./backups` (dans le dépôt), déplace les dumps :
  ```bash
  cd /opt/ant
  mkdir -p /var/backups/ant && mv backups/*.dump /var/backups/ant/
  sed -i 's|^BACKUP_DIR=.*|BACKUP_DIR=/var/backups/ant|' .env && docker compose up -d backup
  ```
- **`.env` n'est pas dans ces sauvegardes** : garde-en une copie hors de la machine (§ 4). Sur une machine réinstallée, remets l'ancien
  `.env` (même `ENCRYPTION_KEY`) au lieu de lancer `deploy/generate-env.sh`, puis restaure la base.
- Les volumes `workspace`, `browser-profile` (connexions aux sites) et `claude-state` (sessions des agents) sont couverts par
  une sauvegarde **vzdump** de la VM ou du CT dans Proxmox (recommandée, quotidienne).

### Restaurer la base

```bash
cd /opt/ant
./deploy/restore.sh /var/backups/ant/ant-AAAA-MM-JJ.dump
```

Le script vérifie l'archive, arrête `web`, `worker` et `backup`, restaure la sauvegarde dans une base neuve (`ant_restauration`)
d'un seul bloc, puis l'échange avec la base actuelle, conservée sous le nom `ant_precedente`. Si la restauration échoue, la base
actuelle n'est pas modifiée. Au redémarrage, `web` applique les migrations du code présent : restaurer une sauvegarde plus ancienne
que la version installée est donc sans risque. Une fois le résultat vérifié, supprime l'ancienne base :
`docker compose exec -T postgres dropdb -U ant ant_precedente`.

Ne restaure pas avec `pg_restore --clean` dans la base existante : après une mise à jour, les objets ajoutés par une nouvelle
migration empêchent de supprimer les anciens, la restauration reste partielle et `web` ne redémarre plus.

### Journaux
```bash
docker compose logs -f worker        # exécutions des bots, bascules, planificateur
docker compose logs -f web
docker compose logs backup           # sauvegardes
```
L'écran **Audit** liste toutes les actions des agents et les connexions. Il est exportable en CSV.

### Dépannage
| Symptôme | Piste |
|---|---|
| Les bots répondent « en pause » | Écran Quota & budget : abonnement limité, plafond API atteint ou aucune clé API en mode hybride |
| « jeton d'abonnement refusé » | Jeton expiré ou révoqué : régénère-le (§ 4) puis redémarre le worker |
| Les bots et le navigateur ne résolvent plus aucun nom (`getent hosts example.com` vide) | DNS de la machine changé : `systemctl restart ant-firewall` (§ 6) |
| Vue Ordinateur hors ligne | `docker compose logs computer` ; vérifie que `COMPUTER_RPC_TOKEN` est identique pour les trois services |
| Écran Ordinateur vide après « Prendre la main » | Chromium n'est pas encore lancé : rends la main, demande à un bot d'ouvrir une page, puis reprends la main |
| `backup` est `unhealthy` | `docker compose logs --tail 20 backup` : base injoignable, disque plein, ou NAS qui refuse l'écriture (§ 3, point 6) |
| Pas de notifications | Clés VAPID présentes ? Sur iPhone, PWA installée ? Bouton « Tester » dans Réglages |
| Passkey refusée | `PUBLIC_ORIGIN` doit correspondre exactement au domaine utilisé dans le navigateur |
| Bannière « Le worker ne répond pas » | `docker compose ps worker` puis `docker compose logs --tail 50 worker` ; `docker compose up -d worker` |
| « ENCRYPTION_KEY n’est pas celle… » à la connexion | Base restaurée avec un autre `.env` : connecte-toi avec un code de secours ou une passkey, puis remets l'ancienne `ENCRYPTION_KEY` dans `.env` (§ 4) et `docker compose up -d web` |

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
pnpm test:deploy  # scripts de déploiement (node --test deploy/tests/*.test.mjs : sauvegarde, restauration, mise à jour, pare-feu ; PostgreSQL local, root pour le pare-feu)
```
