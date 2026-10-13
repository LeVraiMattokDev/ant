# État d'avancement d'Ant

Ce document dit ce qui est fait, comment c'est vérifié, et ce qui reste limité. Il est mis à jour à chaque livraison.

## Résumé par phase

| Phase | Contenu | État |
|---|---|---|
| 1 | Authentification (mot de passe argon2id + TOTP, passkeys, codes de secours, limitation des tentatives, sessions), bots, messages privés, connexion abonnement + repli API, quota et budget | ✅ |
| 2 | Plusieurs bots, canaux de groupe, fils, @mentions, transferts avec garde-fous anti-boucle, recherche plein texte, mémoire partagée / par bot, compactage des longues sessions | ✅ |
| 3 | Ordinateur des agents (terminal, fichiers, Chromium persistant), vue en direct (noVNC + terminal), prise de main, validations exécutées à l'identique, isolation réseau | ✅ |
| 4 | Heartbeat à deux étages (Haiku puis modèle du bot), relances dédupliquées, heures de silence, résumé quotidien, routines en langage naturel, Web Push, PWA | ✅ |
| 5 | Sous-agents léger (Haiku 5.5) / expert (Opus 5.5) avec règles, raison obligatoire et traçage, limite quotidienne d'appels experts, tests, sauvegardes, revue de sécurité | ✅ |

## Vérifications effectuées

- **Tests automatisés**
  - `packages/shared` : décisions de source de calcul (tous les modes et seuils), alertes, règles de risque, anti-boucle, heures de silence, réglages.
  - `apps/server` : tests d'intégration sur un vrai PostgreSQL.
    - Authentification complète, CSRF, limitation des tentatives, codes de secours à usage unique.
    - File de tâches.
    - Exécution d'un bot avec un Agent SDK simulé : flux, reprise de session, **bascule abonnement → crédits API en cours d'exécution**, pause propre, hooks des sous-agents, transferts et blocage des boucles, validations.
    - Heartbeat, résumé, routines, compactage, alertes.
  - `apps/computer` : confinement des chemins, exécution, fichiers, WebSockets, Chromium réel.
  - `apps/ui` : logique du cache temps réel et rendu des composants.
  - `deploy` (`node --test deploy/tests/*.test.mjs`) :
    - sauvegarde : nouvelle tentative après un `pg_dump` en échec, archive invalide jamais gardée, abandon après 6 échecs
      dans la journée, droits 600, état du healthcheck, arrêt immédiat sur SIGTERM quand le script est le PID 1 ;
    - restauration sur un vrai PostgreSQL avec les migrations d'Ant : retour à l'état du dump après une migration plus récente,
      ancienne base conservée, base intacte si l'archive est corrompue ou si la restauration échoue ;
    - mise à jour dans un vrai dépôt git : sauvegarde avant le redémarrage, arrêt si elle échoue, commande de retour arrière ;
      après un échec (construction, sauvegarde, démarrage de `web`), une simple relance vise toujours la version d'avant et le
      dump d'avant la première tentative, y compris après un retour arrière ; image PostgreSQL non téléchargée sans conséquence ;
    - pare-feu appliqué avec le vrai iptables dans un espace réseau isolé : DNS du LAN autorisé (port 53 seulement), reste
      du LAN refusé.
- **Essais réels**
  - Services web et worker compilés puis démarrés pour de vrai.
  - Parcours complet par l'API : configuration, TOTP, refus du WebSocket sans session, création de bot, message, pause faute d'identifiants.
  - **Image Docker de production** (lecture seule, sans capacités Linux) : le binaire Claude Code de l'Agent SDK démarre, joint l'API d'Anthropic, et un identifiant refusé est détecté et géré.
  - **Image de l'ordinateur** construite avec le Dockerfile actuel et démarrée avec le service `computer` de docker-compose
    (racine en lecture seule, `/tmp` et `/home/agent` en tmpfs, sans capacités) : sain, Xvfb, openbox, x11vnc (socket unix) et
    tmux démarrent ; commandes, environnement virtuel Python dans `/tmp`, Chromium à profil persistant (page chargée et lue).
    Après redémarrage, un `~/.bashrc` modifié a disparu, `/workspace` et le profil navigateur sont conservés.
  - **Images plus légères** : serveur 960 Mo (1,32 Go avant ; `node_modules` 337 Mo au lieu de 577, sans le binaire Claude Code
    musl inutile), ordinateur 2,16 Go (3,08 Go avant ; `node_modules` 81 Mo au lieu de 722). L'image serveur, construite en
    entier (interface comprise), démarre en lecture seule contre PostgreSQL (migrations, interface, `/healthz`), et son binaire
    Claude Code répond.
  - **Interface réelle contre le vrai serveur**, dans un Chromium headless :
    - parcours de configuration complet (jeton, mot de passe, TOTP, codes de secours) ;
    - message à un bot, puis affichage de la pause et de sa raison ;
    - tous les écrans parcourus sur ordinateur et sur mobile (390 px), sans erreur de console ni violation de CSP.
  - **Vue Ordinateur en direct** à travers le proxy authentifié du serveur : l'écran noVNC montre le Chromium de l'agent, et le terminal tmux partagé est connecté.

## Ce qui n'a pas pu être vérifié ici

- **Service `backup` dans son image `postgres:17-alpine`** (busybox) et **pile complète lancée par `deploy/upgrade.sh`** :
  Docker Hub a refusé l'image PostgreSQL (429, limite de requêtes). `backup.sh` est testé avec `/bin/sh` (dash, POSIX comme busybox) contre
  un vrai PostgreSQL, et `upgrade.sh` avec un faux `docker`. Au premier déploiement : `docker compose ps backup` doit passer à
  `healthy` (5 min après le démarrage), puis vérifier la première sauvegarde avec `docker compose logs backup`.
- **Image de l'ordinateur avec ses derniers réglages** (`/tmp` de 768 Mo, dossier personnel de 512 Mo, `/dev/shm` de 256 Mo,
  pip sans cache et cache npm dans `/workspace`) : pas de démon Docker ici. Les fichiers de configuration de pip et npm ont été
  vérifiés hors image. Au premier déploiement : `docker compose exec computer pip cache dir` doit répondre que le cache est
  désactivé, et `docker compose exec computer npm config get cache` afficher `/workspace/.cache/npm`.
- **Étapes Proxmox du CT LXC** (options de montage du NAS, délai de démarrage) : pas de Proxmox ici, les commandes du README
  suivent la documentation de Proxmox VE 8.
- **Appels réels à Claude avec ton abonnement ou ta clé API** : aucun identifiant valide n'existe dans l'environnement de développement.
  L'intégration est vérifiée jusqu'à l'API d'Anthropic (refus d'une fausse clé), mais pas une vraie réponse de modèle.
  À tester en premier après déploiement : un message à un bot, puis l'écran Quota & budget.
- **Unités des événements de limite de l'abonnement** : `rate_limit_event.utilization` et `resetsAt` ne sont pas documentés
  précisément. Ant accepte une fraction ou un pourcentage, et des secondes ou des millisecondes. Les événements bruts sont
  conservés dans la table `subscription_events` pour calibrer si besoin.
- **Notifications push sur ton téléphone** : elles dépendent des clés VAPID et du navigateur. Utilise le bouton « Tester » des réglages.

## Limites connues (à connaître avant usage)

1. **Conformité de l'abonnement** : voir [ARCHITECTURE § 6.1](ARCHITECTURE.md#61-connexion-à-labonnement-sur-un-serveur-sans-écran).
   Le mode par défaut « Hybride prudent » limite l'abonnement à ce que tu déclenches.
2. **Navigateur libre** : la validation porte sur les clics et la touche Entrée **sur les sites listés comme sensibles** (liste
   modifiable dans Réglages). Une action irréversible sur un site absent de la liste ne serait pas interceptée automatiquement.
   Les bots ont pour consigne d'appeler `request_approval` avant toute action irréversible. Les connecteurs structurés (v2)
   permettront une validation exhaustive.
3. **Injection de prompt** depuis une page web : l'ordinateur n'a aucun secret et ne peut pas joindre ton LAN. Les actions sensibles
   sont validées. En revanche, un bot trompé pourrait encore envoyer des informations vers un site public par une simple navigation.
4. **Commandes longues** : 280 s maximum par appel `computer_exec`. Au-delà, l'agent lance la commande en arrière-plan et suit son journal.
5. **Coûts** : ce sont des estimations de l'Agent SDK. La limite de dépense dans la Claude Console reste le garde-fou ultime.
6. **Pas de recherche sémantique** dans la mémoire (Claude uniquement, pas d'embeddings) : la recherche est en plein texte.
7. **Hors périmètre v1**, comme prévu : la voix et les connecteurs Gmail, Calendar, X, GitHub et Discord. L'architecture les
   prévoit (outils MCP supplémentaires + table de connecteurs).
8. **Ordinateur des agents en lecture seule** : ce qu'un agent installe hors de `/workspace` et du profil navigateur
   (`pip install --user`, fichiers de `~`) disparaît au redémarrage du conteneur. `/tmp` (768 Mo, mémoire partagée de Chromium
   comprise) et le dossier personnel (512 Mo) sont pris sur la mémoire du conteneur : le cache de pip est désactivé, celui de
   npm est dans `/workspace/.cache/npm`, et les gros outils s'installent dans `/workspace` (par exemple un environnement
   virtuel Python).

## Évolutions en cours (équipes A à D)

Conception et répartition : [ARCHITECTURE § 19](ARCHITECTURE.md#19-évolutions) ; contrat :
[API.md, « Évolutions »](API.md#évolutions--contrat-des-équipes-a-à-d). Chaque équipe tient à jour sa sous-section.

### Socle (fait)

- Migration `0003_features` : nouvelles tables (`followups`, `channel_reads`, `owner_presence`, `service_status`, `drafts`,
  `watches`) et colonnes, avec reprise des données. Vérifiée sur une base neuve (tests du serveur) et sur une base de la
  version précédente remplie de données : routines déjà proposées marquées `proposed`, origine des coûts reprise des
  exécutions, premier démarrage marqué fait quand des bots existent ; une seconde application ne change rien.
- Types partagés, réglages (avec valeurs par défaut) et points d’extension des modules (worker, web, interface), couverts
  par `apps/server/test/foundation.test.ts` et `apps/ui/test/features.test.tsx`.
- Vie du worker (`service_status`) et projection mensuelle dans `GET /api/quota` ; origine (`purpose`, `routine_id`) de toute
  consommation ; plafond par exécution sur l’abonnement (5 $ par défaut, 0 pour le désactiver) ; aucun heartbeat, routine ni
  résumé pendant l’arrêt d’urgence.
- Non vérifiable ici (aucun identifiant Claude) : l’effet réel de `maxBudgetUsd` sur une exécution par abonnement. Le test de
  connexion du premier démarrage (B) permettra de le vérifier ; en cas de souci, le réglage se désactive avec 0.

### Socle : corrections après revue (fait)

Tests : `apps/server/test/foundation-review.test.ts`, `apps/ui/test/foundation-isolation.test.tsx`, ajouts dans
`{sched,runtime,web}-fixes.test.ts` et `apps/computer/test/browser.test.ts`.
- `afterRun` voit chaque état final (annulée en attente, bot en pause, conversation archivée, abandon faute de calcul,
  échec du travail, orpheline, occurrence remplacée), avec le déclencheur d’origine et la durée de toute la tâche quand
  la dernière exécution est une suite automatique, l’indicateur `silent` et les fichiers joints. Une exécution annulée
  pendant son attente est traitée tout de suite, pas à l’heure prévue de sa reprise.
- Une erreur passagère de la base au démarrage d’une exécution n’est plus prise pour une conversation archivée.
- Modules isolés partout : hooks synchrones du worker, routes et démarrage du web, chaque contribution de l’interface.
- Réglages écrits sous verrou ; projection mensuelle d’au moins 3 jours ; `/healthz` qui interroge la base ; coût d’un
  appel ponctuel ajouté à son exécution ; sessions `watch:<id>` résumées d’après leurs exécutions.
- Navigateur : une cible vide (`ref: ""`) est une touche sur la page, à la demande comme à l’exécution ; un élément sans
  libellé n’ouvre pas de carte impossible à exécuter ; un élément dans un Shadow DOM ouvert garde son libellé.
- Contrat (API.md) : clés de déduplication uniques, `draft.updated` réduit à l’identifiant, veilles par `curl` seulement
  dans ce tour, réponse des exécutions silencieuses, pause d’un bot seul et healthchecks confiés à B ; « À partir d’un
  modèle » et permissions réduites d’un bot vierge sortis de ce tour (ARCHITECTURE § 19.2).

### Reprises entre flux (fait)

Points laissés d'un flux de correction à l'autre, terminés sur le socle (tests : `apps/server/test/{web,sched,runtime}-fixes.test.ts`,
`apps/ui/test/screens-fixes.test.tsx`, `apps/computer/test/entrypoint.test.ts`).
- Sécurité : ajout d'une passkey avec le mot de passe (Réglages et premier démarrage), option « Supprimer aussi toutes
  les passkeys » au changement de mot de passe, adresse du proxy vue par Ant dans Réglages → Sécurité (avertissement si
  `TRUST_PROXY=true`), message clair quand `ENCRYPTION_KEY` ne correspond pas au secret TOTP, jeton d'initialisation
  désigné par `SETUP_TOKEN` dans les messages et les journaux, terminal et écran qui s'arrêtent sur une session expirée.
- Planification : au plus une occurrence planifiée d'une routine en attente, « Exécuter maintenant » dans la session de la
  routine, routines d'un bot archivé jamais lancées, exécution annulée si sa conversation a été archivée, dernier emplacement
  d'exécution gardé pour tes demandes, push « Ant est en pause » urgent seulement quand tu attends une réponse.
- Navigateur : un clic ou une touche validés sont rejoués sur le nœud épinglé montré sur la carte (`pin`).
- Interface : bannière globale « Le worker ne répond pas », pagination des messages par identifiant, position des morceaux
  diffusés (`message.delta.offset`), déconnexion depuis les Réglages qui coupe aussi les notifications, terminologie
  « équipe », Entrée qui va à la ligne sur téléphone dans « Nouvelle routine ».
- Non repris, volontairement : identifiants de bots archivés réservés (contrainte d'unicité, historique d'audit par
  identifiant) ; suppression d'une passkey sans mot de passe (n'ouvre aucun accès, auditée et signalée) ; pause
  « structurelle » des tâches autonomes sans clé API (le README promet qu'elles attendent, bornées à 6 h) ; estimation
  du coût par table de prix quand aucun résultat n'arrive (doublon fragile) ; minuterie de durée maximale d'une exécution
  et relance « suivie d'effet » automatique (nouveaux réglages, hors de ce tour).

### A — Suivi et notifications

À venir.

### B — Santé et confiance

À venir.

### C — Entrées

À venir.

### D — Capacités des agents

À venir.
