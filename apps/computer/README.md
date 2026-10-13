# @ant/computer — l'ordinateur des agents

Conteneur Linux isolé où les agents d'Ant travaillent : un espace partagé `/workspace`, un shell,
un Chromium persistant piloté par Playwright, un écran virtuel visible en direct (VNC) et un
terminal partagé (tmux). Le service Node écoute sur le port **7000** et n'est joint que par
`worker` (RPC) et `web` (proxy VNC/terminal), sur le réseau `sandbox`.

## Sécurité

- **Toutes** les routes HTTP et les WebSockets exigent `Authorization: Bearer <COMPUTER_RPC_TOKEN>`
  (comparaison à temps constant). Le service refuse de démarrer si le jeton fait moins de 24 caractères.
  Seule exception : `GET /livez` (répond `ok`, aucune information) pour le `HEALTHCHECK` Docker.
- Les commandes, le terminal et Chromium reçoivent un **environnement minimal** (`PATH`, `HOME`,
  `LANG`, `DISPLAY`, `TERM`) : le jeton n'est jamais transmis. Il est aussi retiré de
  `process.env` au démarrage.
- **Chemins confinés** à `WORKSPACE_ROOT` (`src/paths.ts`) : `..`, chemins absolus extérieurs et liens
  symboliques (même cassés) menant dehors sont refusés (403 `path_forbidden`). Supprimer un lien
  supprime le lien, jamais sa cible ; la racine de l'espace de travail ne peut pas être supprimée.
- `x11vnc` (sans mot de passe) n'écoute **sur aucun port TCP**, même local : seulement sur le socket
  unix `VNC_SOCKET`, dans un dossier `0700`. Chromium partage la pile réseau du conteneur : une page
  web visitée par un agent pourrait sinon ouvrir `ws://127.0.0.1:5900` et voir/piloter l'écran (avec
  les sessions connectées du propriétaire). Une page web ne peut pas ouvrir un socket unix : le seul
  accès est le pont WebSocket `/vnc`, authentifié par le jeton (et proxifié par `web` derrière la
  connexion utilisateur). Test : `test/entrypoint.test.ts` (aucun port TCP en écoute pour x11vnc).
- Utilisateur non-root `agent` (uid 1000). Durcissement prévu par le compose : `cap_drop: ALL`,
  `no-new-privileges`, racine en lecture seule (`read_only`). Seuls `/workspace` et le profil du navigateur
  (`/home/agent/.ant-browser`) sont des volumes, donc conservés. `/tmp` (768 Mo) et le dossier personnel `/home/agent`
  (512 Mo) sont des tmpfs pris sur la mémoire du conteneur et vidés à chaque redémarrage : ce qu'un agent y installe ou
  modifie (`pip install --user`, `~/.bashrc`) disparaît. Le cache de pip est désactivé, celui de npm est dans
  `/workspace/.cache/npm`, et les gros outils (environnement virtuel Python, `node_modules`) vont dans `/workspace`.

Limite connue : le service et les commandes des agents tournent sous le même uid ; un agent peut
donc lire l'environnement initial des processus du conteneur (`/proc/<pid>/environ`). Le jeton ne
donne accès qu'à cet ordinateur-ci, que l'agent contrôle déjà : il ne doit servir à rien d'autre.

## Points d'accès

Types exacts : `packages/shared/src/computer.ts`. Erreurs : `{ "error": "<code>", "message": "<texte en français>" }`.
Corps JSON limité à 5 Mo (contenu d'une écriture : 2 Mo).

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/livez` | — (sans jeton) | `ok` |
| GET | `/health` | — | `ComputerHealth` |
| POST | `/exec` | `ExecRequest` | `ExecResponse` |
| POST | `/files/read` | `FileReadRequest` | `FileReadResponse` |
| POST | `/files/write` | `FileWriteRequest` | `{ path, size }` |
| POST | `/files/edit` | `FileEditRequest` | `{ path, replacements }` |
| POST | `/files/list` | `FileListRequest` | `FileEntry[]` |
| GET | `/files/download?path=` | — | flux du fichier (`content-disposition`) |
| POST | `/files/delete` | `{ path }` | `{ ok: true }` |
| POST | `/browser` | `BrowserRequest` | `BrowserResponse` |
| POST | `/browser/inspect` | `{ ref?, selector?, pin? }` | `BrowserTargetInfo & { screenshotPng? }` (avec `pin`) |
| WS | `/vnc` | trames binaires RFB | pont vers le socket unix `VNC_SOCKET` |
| WS | `/terminal` | texte = saisie ; `{"type":"resize","cols","rows"}` | sortie du terminal (texte) |

Détails :

- **exec** : `bash -lc <commande>` dans `/workspace` (ou `cwd`), groupe de processus dédié. Délai par
  défaut 120 s, max 1800 s : à l'expiration, SIGTERM au groupe entier puis SIGKILL 5 s plus tard.
  Sorties limitées à `MAX_OUTPUT_BYTES` chacune : on garde **le début et la fin** (moitié/moitié)
  avec un marqueur `[… N octets tronqués …]` au milieu, et `truncated: true`. Les processus lancés
  en arrière-plan qui gardent la sortie ouverte n'empêchent pas la réponse (1 s d'attente max après
  la fin de bash) et continuent de tourner : leurs tubes restent ouverts, mais ce qu'ils écrivent
  après la réponse est perdu ; redirige leur sortie (`> log 2>&1 &`) pour la garder.
- **files/read** : lignes numérotées façon `cat -n`, 2000 lignes par défaut (`offset`/`limit`,
  `limit` ≤ 10 000), lignes coupées à 2000 caractères. Lecture en flux : seuls les 2000 premiers
  caractères d'une ligne sont gardés en mémoire, même pour un fichier de plusieurs Go sur une seule
  ligne (JS minifié, journal sans retour à la ligne). Binaire (octet nul dans les 8 premiers Ko) :
  `binary: true`, contenu vide, `totalLines` = taille en octets.
- **files/edit** : erreur si le texte est absent, ou présent plusieurs fois sans `replaceAll`
  (le message donne le nombre d'occurrences).
- **files/list** : dossiers d'abord, tri alphabétique, 1000 entrées au plus.
- **browser** : `goto` (http/https seulement), `read` (texte visible ≤ 50 000 caractères + éléments
  interactifs visibles marqués `data-ant-ref="eN"`, renumérotés à chaque lecture, ≤ 300), `screenshot`,
  `click`, `type`, `press`, `select` (libellé puis valeur), `scroll` (±700 px), `back`. Cible : `pin`
  (issu de `browser/inspect`), sinon `ref` (issu du dernier `read`), sinon `selector`. Les actions sont
  sérialisées ; le navigateur est lancé à la première action et relancé s'il a été fermé ou a planté.
  Une erreur donne `ok: false, error`.
- **browser/inspect** : libellé de l'élément visé + capture de l'écran avec l'élément entouré de rouge
  (contour retiré ensuite) — pour les cartes de validation. Renvoie aussi `pin`, posé sur ce nœud
  précis (`data-ant-pin`, un UUID jamais effacé par `read`, réutilisé si le nœud en porte déjà un ;
  toute autre valeur posée par la page est remplacée, et seul un UUID est renvoyé). Une action
  validée exécutée avec `pin` vise l'élément montré au propriétaire, même si d'autres `read` ont
  depuis donné sa référence `eN` à un autre élément ; elle est refusée si le nœud a disparu (page
  rechargée, élément retiré) ou si le `pin` désigne plusieurs éléments.
- **terminal** : `tmux new-session -A -s ant` (session partagée entre toutes les connexions ; `bash -l`
  si tmux est absent). Fermer le WebSocket détache le client, la session continue.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `COMPUTER_RPC_TOKEN` | — (obligatoire, ≥ 24 car.) | jeton partagé avec `worker`/`web` |
| `PORT` | `7000` | port HTTP |
| `WORKSPACE_ROOT` | `/workspace` | espace de travail |
| `BROWSER_PROFILE_DIR` | `/home/agent/.ant-browser` | profil Chromium persistant |
| `BROWSER_EXECUTABLE_PATH` | — | binaire Chromium alternatif (facultatif) |
| `DISPLAY` | `:99` | écran Xvfb |
| `VNC_SOCKET` | `/tmp/.ant-vnc/vnc.sock` | socket unix de x11vnc (même valeur pour `entrypoint.sh` et Node) |
| `BROWSER_HEADLESS` | — | `1` : Chromium sans écran (tests/CI) |
| `MAX_OUTPUT_BYTES` | `100000` | limite par flux de sortie de `/exec` |

## Développement

```sh
pnpm --filter @ant/computer typecheck
pnpm --filter @ant/computer test     # tests navigateur ignorés si Chromium absent
pnpm --filter @ant/computer build    # dist/index.js (tsup)
COMPUTER_RPC_TOKEN=... WORKSPACE_ROOT=/tmp/ws BROWSER_HEADLESS=1 pnpm --filter @ant/computer dev
```

Les tests navigateur utilisent le Chromium de `PLAYWRIGHT_BROWSERS_PATH` (défaut `/opt/pw-browsers`),
qui doit correspondre à la version de Playwright épinglée (1.56.1 → Chromium build 1194).

## Image Docker

```sh
docker build -f apps/computer/Dockerfile -t ant-computer .   # depuis la racine du dépôt
docker run --rm -e COMPUTER_RPC_TOKEN=... -p 127.0.0.1:7000:7000 ant-computer
```

`entrypoint.sh` remet dans le dossier personnel (tmpfs vide) les fichiers de `/etc/skel` (`.bashrc`, `.profile`) sans
remplacer ceux déjà présents, lance Xvfb (`:99`, 1280×800), openbox et x11vnc (socket unix `VNC_SOCKET` uniquement,
aucun port TCP), les relance s'ils s'arrêtent, puis exécute le service Node. Sourcé (`source
entrypoint.sh`), il ne fait que définir ses fonctions : c'est ainsi que les tests lancent `run_x11vnc`.
`apps/computer/Dockerfile.dockerignore` restreint le contexte.
