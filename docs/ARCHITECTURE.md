# Ant — Proposition d'architecture (v0, à valider)

> Statut : **validé et implémenté**. Les écarts avec la proposition initiale sont signalés « (implémentation) ».

Sommaire
1. [Vérifications faites dans la documentation officielle](#1-vérifications-faites-dans-la-documentation-officielle)
2. [Vue d'ensemble et stack](#2-vue-densemble-et-stack)
3. [Découpage en services (Docker Compose)](#3-découpage-en-services-docker-compose)
4. [Isolation de l'« ordinateur » des agents](#4-isolation-de-lordinateur-des-agents)
5. [Moteur d'agents (Claude Agent SDK)](#5-moteur-dagents-claude-agent-sdk)
6. [Sources de calcul : abonnement, crédits API, bascule](#6-sources-de-calcul--abonnement-crédits-api-bascule)
7. [Modèles et sous-agents](#7-modèles-et-sous-agents)
8. [Bots, canaux, transferts entre bots](#8-bots-canaux-transferts-entre-bots)
9. [Mémoire](#9-mémoire)
10. [Planificateur : heartbeat, routines, résumé quotidien](#10-planificateur--heartbeat-routines-résumé-quotidien)
11. [Validations et journal d'audit](#11-validations-et-journal-daudit)
12. [Schéma de base de données](#12-schéma-de-base-de-données)
13. [Interface web / PWA](#13-interface-web--pwa)
14. [Sécurité](#14-sécurité)
15. [Estimation de la consommation](#15-estimation-de-la-consommation)
16. [Plan par phases](#16-plan-par-phases)
17. [Limites connues et risques](#17-limites-connues-et-risques)
18. [Questions ouvertes](#18-questions-ouvertes)
19. [Évolutions](#19-évolutions)

---

## 1. Vérifications faites dans la documentation officielle

Vérifié le 2026-10-12, dans les typages du paquet officiel `@anthropic-ai/claude-agent-sdk`
**v0.3.296** (`sdk.d.ts`) et la documentation Anthropic.

| Point | Valeur vérifiée | Source |
|---|---|---|
| Identifiant Sonnet 5.5 | `claude-sonnet-5-5` | Doc modèles Anthropic |
| Identifiant Haiku 5.5 | `claude-haiku-5-5` | Doc modèles Anthropic |
| Identifiant Opus 5.5 | `claude-opus-5-5` | Doc modèles Anthropic |
| Paramètre d'effort (API Messages) | `output_config.effort` : `low` \| `medium` \| `high` \| `xhigh` \| `max` | Doc « effort » |
| Paramètre d'effort (Agent SDK) | option `effort` de `query()` (type `EffortLevel`) et champ `effort` d'un sous-agent (`AgentDefinition.effort`) | `sdk.d.ts` |
| Effort par défaut | Sonnet 5.5 : `high` (donc **à fixer explicitement à `medium`**) ; Haiku 5.5 et Opus 5.5 : `medium` | Doc modèles |
| Réflexion | Sonnet/Opus/Haiku 5.5 : réflexion adaptative toujours active, on règle la profondeur via l'effort | Doc modèles |
| Sous-agents | option `agents: Record<string, AgentDefinition>` ; `model` accepte un alias ou un **identifiant complet** ; `effort`, `tools`, `prompt`, `maxTurns` par sous-agent | `sdk.d.ts` |
| Limites d'abonnement | événement de flux `rate_limit_event` → `status: allowed \| allowed_warning \| rejected`, `rateLimitType: five_hour \| seven_day \| …`, `utilization`, `resetsAt` | `sdk.d.ts` (`SDKRateLimitEvent`) |
| Utilisation détaillée (5 h / 7 j) | `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` → `five_hour`, `seven_day`, `utilization`, `resets_at` | `sdk.d.ts` — **expérimental** : non utilisé par Ant (instable), les événements `rate_limit_event` suffisent |
| Erreur de limite | message assistant avec `error: 'rate_limit'` | `sdk.d.ts` (`SDKAssistantMessageError`) |
| Coût | `total_cost_usd` dans le message `result` (« estimation, pas une facture ») + `modelUsage` par modèle | `sdk.d.ts` |
| Plafond par exécution | option `maxBudgetUsd` → résultat `error_max_budget_usd` | `sdk.d.ts` |
| Identifiants par exécution | option `env` : **remplace** entièrement l'environnement du sous-processus → permet de choisir abonnement ou clé API à chaque exécution | `sdk.d.ts` |
| Cache de prompt | automatique dans l'Agent SDK ; TTL 1 h sur abonnement (dans les limites), 5 min sur clé API, réglable via `CLAUDE_CODE_PROMPT_CACHE_TTL` | `sdk.d.ts` (réglages) |
| Connexion à l'abonnement sur serveur sans écran | `claude setup-token` → jeton OAuth d'un an → variable `CLAUDE_CODE_OAUTH_TOKEN` (**point de conformité, § 6.1**) | code.claude.com/docs/en/authentication |
| Priorité des identifiants | `ANTHROPIC_API_KEY` passe avant `CLAUDE_CODE_OAUTH_TOKEN` | idem |
| Coût sur abonnement | `total_cost_usd` = estimation locale, sans valeur de facturation sur abonnement | code.claude.com/docs/en/agent-sdk/cost-tracking |

---

## 2. Vue d'ensemble et stack

```
                 Internet
                    │ HTTPS
          ┌─────────▼──────────┐
          │ Nginx Proxy Manager│  (existant, homelab)
          └─────────┬──────────┘
                    │ HTTP, réseau homelab → VM « ant » :8080 uniquement
┌───────────────────▼──────────────────────────── VM Debian « ant » (Proxmox) ─┐
│  docker compose                                                               │
│                                                                               │
│  ┌──────────┐  WS/HTTP  ┌──────────┐   jobs (Postgres)  ┌──────────┐          │
│  │   web    │◄─────────►│ postgres │◄──────────────────►│  worker  │──► API   │
│  │ API+SPA  │  LISTEN/  └──────────┘                    │ Agent SDK│   Claude │
│  │  + WS    │  NOTIFY        ▲ réseau interne seul      │ planif.  │          │
│  └────┬─────┘                                           └────┬─────┘          │
│       │ noVNC / terminal (proxy authentifié)                 │ RPC authentifiée│
│       ▼                                                      ▼                 │
│  ┌──────────────────────────────────────────────────────────────────┐         │
│  │ computer : Xvfb + Chromium (profil persistant) + Playwright,     │         │
│  │ tmux/PTY, /workspace. AUCUN secret. Sortie Internet seulement.   │         │
│  └──────────────────────────────────────────────────────────────────┘         │
└───────────────────────────────────────────────────────────────────────────────┘
```

| Couche | Choix | Pourquoi |
|---|---|---|
| Langage | TypeScript strict, Node 22 LTS, monorepo pnpm | demandé ; un seul langage partout |
| Agents | `@anthropic-ai/claude-agent-sdk` (version épinglée) | demandé ; boucle d'agent, sous-agents, hooks, cache, compaction fournis |
| API web | Fastify 5 + `@fastify/websocket` + Zod | rapide, typé, schémas validés |
| Base | PostgreSQL 17 + Drizzle ORM (migrations versionnées) | relationnel, recherche plein texte native (`french` + `unaccent`), LISTEN/NOTIFY pour le temps réel |
| File de tâches / planif | File maison dans Postgres (`FOR UPDATE SKIP LOCKED`, « couloirs » par bot et fil, clés de déduplication) — (implémentation : remplace pg-boss, plus simple à tester et sans dépendance) | jobs persistants, reprises avec backoff, report sans consommer d'essai, pas de Redis à opérer |
| Front | React 19 + Vite + TanStack Router/Query + Tailwind + Radix | SPA rapide, PWA via `vite-plugin-pwa` |
| Temps réel | WebSocket (bidirectionnel : flux de tokens, prise de main sur l'ordinateur) | |
| Push | Web Push (VAPID, lib `web-push`) | pas de service tiers |
| Ordinateur | Debian slim + Xvfb + x11vnc + noVNC/websockify + Chromium + Playwright + tmux | vue en direct et reprise de main |
| Tests | Vitest (unitaires) + tests d'intégration sur Postgres réel (Testcontainers) + Playwright (e2e UI) | |

---

## 3. Découpage en services (Docker Compose)

| Service | Rôle | Secrets reçus | Réseaux |
|---|---|---|---|
| `web` | Auth, API REST, WebSocket, sert la SPA, proxy authentifié vers noVNC/terminal | `SESSION_SECRET`, `DATABASE_URL`, clés VAPID | `front` (publié :8080), `internal`, `sandbox` |
| `worker` | Exécute les bots (Agent SDK), planificateur (heartbeats, routines, résumé), gestionnaire de quota/budget, envoi des push | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `COMPUTER_RPC_TOKEN`, VAPID | `internal`, `egress`, `sandbox` |
| `computer` | « L'ordinateur » : shell, fichiers, Chromium, écran virtuel. Expose une RPC interne (exécution de commandes, fichiers, actions navigateur, captures) | `COMPUTER_RPC_TOKEN` (pour authentifier le worker), mot de passe VNC | `sandbox` (+ sortie Internet filtrée) |
| `postgres` | Données | mot de passe DB | `internal` (`internal: true`, aucune sortie) |
| `backup` | `pg_dump` quotidien + rotation vers un volume monté (ton stockage Proxmox/NAS) | mot de passe DB | `internal` |

Points clés :
- **Seul `web` est publié**, sur le port 8080 de la VM, à destination de Nginx Proxy Manager.
- **Les identifiants Claude ne vivent que dans `worker`.** Le `computer`, où s'exécutent les commandes
  des agents et le navigateur (donc exposé aux injections de prompt venant du web), n'a **aucun secret**.
- Volumes : `pgdata`, `workspace` (/workspace de l'ordinateur), `browser-profile`, `claude-state`
  (transcripts de sessions de l'Agent SDK, côté worker), `backups`.

---

## 4. Isolation de l'« ordinateur » des agents

Défense en profondeur, du plus large au plus fin :

1. **Pare-feu Proxmox sur la VM** (le vrai périmètre) :
   - entrant : uniquement TCP 8080 depuis l'IP de Nginx Proxy Manager, SSH depuis ton poste d'admin ;
   - sortant : Internet autorisé ; **tout le RFC 1918 (10/8, 172.16/12, 192.168/16), le lien local
     169.254/16 et l'IPv6 ULA refusés**, sauf passerelle/DNS. La VM ne peut donc pas parler à ton réseau.
2. **Dans la VM**, chaîne `DOCKER-USER` d'iptables (script fourni) : le réseau `sandbox` ne peut joindre
   ni l'hôte, ni le LAN, ni `postgres` (réseau différent), seulement Internet.
3. **Conteneur `computer`** : utilisateur non-root, `cap_drop: ALL`, `no-new-privileges`, pas de socket
   Docker, limites CPU/RAM/PIDs. Racine en **lecture seule** (`read_only` du compose) : seuls `/workspace` et le profil
   du navigateur (volumes) sont conservés ; `/tmp` (768 Mo) et le dossier personnel `/home/agent` (512 Mo) sont des
   tmpfs pris sur la mémoire du conteneur et vidés à chaque redémarrage (un `~/.bashrc` piégé ne survit pas).
   `entrypoint.sh` y remet au démarrage les fichiers de `/etc/skel` (`.bashrc`, `.profile`). Les agents savent (prompt
   système) que les gros outils (environnement virtuel Python, `node_modules`) s'installent dans `/workspace`.
4. **Le worker n'expose aucune commande système aux agents.** Les outils intégrés de l'Agent SDK qui
   agissent sur la machine locale (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, etc.)
   sont **désactivés** dans le worker. Les agents agissent uniquement via des outils MCP « Ant »
   (en processus, `createSdkMcpServer`) qui relaient vers la RPC du `computer`. Ainsi une injection de
   prompt ne peut pas lire `env` ni `/proc` du worker pour voler le jeton.
5. **`WebSearch`** (exécuté côté Anthropic) reste autorisé ; la lecture de pages passe par le
   navigateur du `computer`.

Vue « Ordinateur » : noVNC (écran du Chromium) + xterm.js (session tmux partagée) proxifiés par `web`
derrière l'authentification. Bouton **« Prendre la main »** : pose un verrou ; tant qu'il est posé, les
outils navigateur/terminal des agents répondent « l'utilisateur a la main, attends ». **« Rendre la
main »** lève le verrou et prévient le bot.

---

## 5. Moteur d'agents (Claude Agent SDK)

Une **exécution** (`run`) = un appel `query()` de l'Agent SDK pour un bot, dans un fil.

```
message utilisateur / @mention / transfert / heartbeat / routine / validation accordée
        │
        ▼
  job "bot.run" (couloir = bot+fil → un seul run à la fois par bot et par fil)
        │
        ▼
  QuotaManager.decide(priorité, bot, modèle) ─► abonnement | API | pause (§ 6)
        │
        ▼
  query({
    prompt,
    options: {
      model: bot.model,                // ex. "claude-sonnet-5-5"
      effort: bot.effort,              // ex. "medium"
      resume: session.sdkSessionId,    // continuité du fil
      systemPrompt: <prompt Ant stable : rôle + instructions + mémoire épinglée>,
      tools: ["WebSearch", "Agent"],   // seuls outils intégrés disponibles ; aucun outil local (Bash, Read…)
      settingSources: [],              // n'utilise aucun fichier de réglages local
      allowedTools: ["WebSearch", "mcp__ant__*", "Agent"],  // auto-approuvés (ne restreint pas : c'est `tools` qui restreint)
      mcpServers: { ant: <serveur MCP en processus : messages, mémoire, tâches, ordinateur, validations> },
      agents: { leger: {...Haiku}, expert: {...Opus} },   // § 7
      hooks: { PreToolUse, PostToolUse, SubagentStart, SubagentStop },  // PreToolUse filtre CHAQUE appel
                                       // (permissions par bot, validations) ; PostToolUse = audit
                                       // (canUseTool n'est appelé que si le flux de permission tombe sur
                                       // une demande : insuffisant seul, d'où le hook)
      env: <identifiants choisis par QuotaManager>,
      maxBudgetUsd: <si source = API>,
      includePartialMessages: true,    // flux de tokens vers l'UI
    }
  })
        │  flux de messages → WebSocket (web) via NOTIFY ; usage, rate_limit_event → QuotaManager
        ▼
  message final enregistré, tokens/coût enregistrés, audit
```

- Le worker tourne en continu : fermer l'interface n'arrête rien.
- Parallélisme : plusieurs bots en même temps, limite globale réglable (par défaut 3 runs simultanés)
  pour ne pas saturer la VM ni l'abonnement. (implémentation) Le dernier emplacement libre est gardé pour tes propres
  demandes (priorité `interactive`) : une rafale de routines, heartbeats ou transferts ne te fait jamais attendre la fin
  d'une exécution de fond. Avec un seul emplacement, tout le partage.
- Reprise après redémarrage : les jobs non terminés sont rejoués, sauf ceux qui ont épuisé leurs essais, marqués en
  échec ; la session SDK reprend via `resume`. Un arrêt propre du worker ne perd rien : chaque exécution en cours termine
  son tour, enregistre sa consommation et retourne en file, puis reprend sa session au démarrage suivant avec une note
  (« interrompu, reprends »).
- (implémentation) Le prompt système (`snapshot: false`) ne contient que la partie stable (rôle, instructions, mémoire
  épinglée, puis résumé de session après la frontière de cache) ; le contexte propre à chaque exécution (date et heure,
  conversation, déclencheur, tâches ouvertes) est en tête du message utilisateur. Le préfixe reste ainsi dans le cache.
- (implémentation) Une exécution arrêtée par la limite d'étapes (`error_max_turns`) est prolongée automatiquement deux
  fois au plus, dans la même session, avec le même modèle et les mêmes clés d'origine (routine, suivi…).

---

## 6. Sources de calcul : abonnement, crédits API, bascule

### 6.1 Connexion à l'abonnement sur un serveur sans écran

**Méthode documentée** (https://code.claude.com/docs/en/authentication, « Generate a long-lived token ») :
sur une machine où tu es connecté, `claude setup-token` génère un **jeton OAuth valable un an**, lié à ton
abonnement Pro/Max. Il n'est enregistré nulle part : on le place dans la variable d'environnement
`CLAUDE_CODE_OAUTH_TOKEN` du service `worker`. Il ne sert qu'aux requêtes de modèle (pas aux connecteurs
claude.ai). Aucune procédure de renouvellement automatique n'est documentée : on régénère un jeton avant
l'échéance. Ant enregistre la date de création et **t'alerte 30 jours avant l'expiration**, et détecte
une erreur `authentication_failed`.

**Priorité des identifiants** (même page) : `ANTHROPIC_API_KEY` passe **avant** `CLAUDE_CODE_OAUTH_TOKEN`.
Ant ne met donc jamais les deux dans l'environnement d'une même exécution (option `env`, qui remplace
tout l'environnement du sous-processus).

**⚠️ Point de conformité à trancher (je ne peux pas le trancher à ta place)** — textes officiels :
- Agent SDK, page d'aperçu : « Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products, including agents built on the
  Claude Agent SDK. » → vise surtout les produits offerts **à d'autres**. Ant est mono-utilisateur, pour toi.
- https://code.claude.com/docs/en/legal-and-compliance : « Advertised usage limits for Pro and Max plans
  assume ordinary, individual usage of Claude Code and the Agent SDK » ; « OAuth authentication […] is
  designed to support ordinary use of Claude Code and other native Anthropic applications » ;
  « Developers building products or services […] including those using the Agent SDK, should use API key
  authentication ».
- Conditions grand public (https://www.anthropic.com/legal/consumer-terms) : interdiction d'accéder aux
  services « through automated or non-human means, whether through a bot, script, or otherwise », **sauf**
  via une clé API ou « where we otherwise explicitly permit it ».
- En face : `setup-token` est explicitement documenté « for CI pipelines, scripts, or other environments
  where interactive browser login isn't available ».

Lecture : utiliser ton propre abonnement, pour toi, avec le binaire officiel, quand **tu** sollicites un
bot, ressemble à l'usage prévu. En revanche, une flotte de bots qui tourne **24 h/24 de façon autonome**
(heartbeats, routines, chaînes bot→bot) sur l'abonnement n'est couverte explicitement par aucun texte, et
les conditions grand public pourraient l'interdire. Le risque est une restriction ou une suspension de
ton compte Claude, que tu utilises aussi personnellement.

**Ma recommandation** : un mode par défaut **« Hybride prudent »**. L'abonnement sert uniquement aux
exécutions que **tu déclenches** (tu écris à un bot, tu valides une action). Tout ce qui est autonome
(heartbeats, routines, résumés, transferts entre bots non initiés par toi) passe sur les **crédits API**.
C'est aussi le moyen le plus sûr de te garder de la marge sur tes limites. Les trois modes demandés
restent disponibles. Avant d'activer l'abonnement pour l'autonome, tu peux demander une confirmation
écrite au support Anthropic. → **Question 1** en fin de document.

### 6.2 Les deux sources

| Source | Variable d'environnement passée au sous-processus | Ce que l'on mesure |
|---|---|---|
| Abonnement Max | `CLAUDE_CODE_OAUTH_TOKEN` (et **pas** `ANTHROPIC_API_KEY`, qui serait prioritaire) | tokens par modèle consommés par Ant ; `utilization` 5 h / 7 j via `rate_limit_event` (+ API expérimentale si disponible) ; coût « équivalent API » à titre indicatif |
| Crédits API | `ANTHROPIC_API_KEY` (et pas le jeton OAuth) | dollars par bot / modèle / jour (`total_cost_usd`, `modelUsage`) ; plafond strict |

Le choix se fait **à chaque exécution** grâce à l'option `env` de `query()`.

### 6.3 Modes (réglage dans l'interface)

- « Abonnement uniquement »
- « Abonnement puis crédits API » (le défaut que tu as demandé)
- « Crédits API uniquement »
- **« Hybride prudent »** (ma recommandation, voir § 6.1) : abonnement pour ce que tu déclenches, crédits
  API pour l'autonome. Avec bascule vers l'API si l'abonnement est limité.

Défaut retenu : **« Hybride prudent »**.

### 6.4 Règles de décision (`QuotaManager.decide`)

Chaque exécution a une **priorité** :
- `interactive` : tu as écrit dans un fil / validation accordée ;
- `normal` : transfert entre bots, routine marquée urgente ;
- `background` : heartbeat, routine ordinaire, résumé quotidien, résumés de mémoire.

Seuils réglables (valeurs par défaut proposées) :

| Réglage | Défaut | Effet |
|---|---|---|
| `reserve.fiveHour` | 60 % | au-delà, `background` quitte l'abonnement → API (ou pause si mode « abonnement uniquement ») |
| `reserve.weekly` | 50 % | idem sur la fenêtre hebdomadaire |
| `hardStop.fiveHour` | 90 % | au-delà, même `interactive` passe sur l'API |
| `hardStop.weekly` | 85 % | idem |

Algorithme :
1. Mode « API uniquement » → API (si budget restant) sinon pause.
2. Si l'abonnement est marqué **limité** (`rate_limit_event.status = rejected` ou erreur `rate_limit`)
   et que `resetsAt` n'est pas passé → API ou pause selon le mode.
3. Si l'utilisation connue dépasse le seuil correspondant à la priorité → API ou pause selon le mode.
4. Sinon → abonnement.
5. **Retour automatique** : un job planifié à `resetsAt` (+1 min) remet l'abonnement en « disponible »
   et prévient dans l'UI.
6. Bascule **en cours d'exécution** : si l'abonnement est refusé pendant un run, le run est arrêté
   proprement puis relancé avec `resume` (même session) sur l'API si le mode l'autorise ; le fil affiche
   « bascule sur crédits API (limite 5 h atteinte, réinitialisation à 14:05) ».

Important : `utilization` mesure **tout ton compte** (Ant + ton usage personnel de Claude), ce qui est
exactement ce qu'il faut pour te garder de la marge.

### 6.5 Budget API

- Plafonds : par jour, par mois (défaut 100 $), et optionnels par bot.
- Avant un run API : refus si plafond atteint ; pendant : `maxBudgetUsd` = min(reste du jour, reste du
  mois, plafond du bot, plafond par run).
- Alertes à 50 / 80 / 95 % (une seule fois par période) : bannière + push.
- Les coûts de l'Agent SDK sont des **estimations**. Je recommande **en plus** de régler une limite de
  dépense dans la Claude Console (garde-fou côté serveur, qu'Ant ne peut pas dépasser même en cas de bug).
- Si les deux sources sont épuisées : tous les bots passent en pause, un message système et une
  notification push te préviennent, avec l'heure de réinitialisation prévue. (implémentation) Ce push part au plus une
  fois par jour ; il attend la fin des heures de silence, sauf quand tu attends toi-même une réponse (demande de ta
  part). Une tâche autonome sans source de calcul reste en pause 6 h au plus, puis est abandonnée avec un message ⏹️.

---

## 7. Modèles et sous-agents

| Rôle | Modèle | Effort | Usage |
|---|---|---|---|
| Bot (défaut, modifiable par bot) | `claude-sonnet-5-5` | `medium` | conversation, travail courant |
| Sous-agent « léger » | `claude-haiku-5-5` | `low` | tri, résumés, extraction, tâches répétitives |
| Sous-agent « expert » | `claude-opus-5-5` | `high` | architecture, gros débogage, décisions importantes |
| Triage heartbeat | `claude-haiku-5-5` | `low` | « y a-t-il quelque chose à creuser ? » |

Mise en œuvre via l'option native `agents` de l'Agent SDK (`model` et `effort` par sous-agent).

Règles de choix (intégrées au prompt système de chaque bot, en clair) :
- **léger** si la tâche est mécanique, sans jugement, vérifiable (≥ 3 éléments à trier/résumer/extraire,
  ou volume de texte > ~5 000 mots à condenser) ;
- **expert** si : décision difficilement réversible, conception d'architecture, bug non résolu après une
  tentative, raisonnement sur plusieurs contraintes contradictoires, ou demande explicite de ta part ;
- sinon le bot travaille lui-même.

Traçabilité : le hook `SubagentStart`/`PreToolUse` (outil `Agent`) écrit dans le fil une ligne système :
« ↪ Sous-agent **Opus 5.5** (effort high) — raison : … ». La raison est obligatoire dans la description
de délégation ; sans raison, le hook refuse l'appel et demande au bot de la fournir.

Garde-fous : le même hook vérifie le quota/budget avant d'autoriser un sous-agent **expert** (Opus
consomme plus vite les limites de l'abonnement et coûte 2× Sonnet sur l'API) ; plafond configurable du
nombre d'appels « expert » par jour.

---

## 8. Bots, canaux, transferts entre bots

- **Bot** : nom, avatar, rôle, instructions, modèle/effort, permissions d'outils (liste blanche par
  catégorie : ordinateur-terminal, ordinateur-navigateur, mémoire partagée en écriture, transfert,
  sous-agent expert…), fréquence de heartbeat, heures de silence propres, pause.
- **Canaux** : `dm` (toi + un bot) et `group` (toi + plusieurs bots). **Fils** (réponses à un message).
  Historique complet, **recherche plein texte** (Postgres `tsvector` français + `unaccent`) avec filtres
  canal/bot/date.
- **@mention** d'un bot (par toi ou par un autre bot) dans un canal → job pour le bot mentionné, avec le
  contexte du fil.
- **Outils MCP Ant** offerts aux bots : `post_message`, `mention_bot`, `handoff(to_bot, tâche, contexte)`,
  `create_task` / `update_task`, `search_messages`.
- **Garde-fous anti-boucle** : chaque chaîne de travail a un `chain_id` et un compteur de « sauts »
  (défaut max 8 transferts entre bots sans intervention humaine), plafond de runs par chaîne et par
  heure, détection de ping-pong (A→B→A sans nouveau contenu). Au-delà : la chaîne s'arrête et te demande.

---

## 9. Mémoire

- **Mémoire partagée** : qui tu es, tes projets, tes préférences.
- **Mémoire par bot** : faits et notes propres au bot.
- Chaque élément : type (`profil`, `préférence`, `projet`, `fait`, `note`), contenu, étiquettes,
  **épinglé** ou non, importance, auteur (toi ou un bot), source (lien vers le message).
- **Injection** : les éléments épinglés (partagés + du bot), plafonnés (~2 000 tokens), sont placés dans
  le prompt système **stable** → bénéficient du cache de prompt. Le reste est accessible via l'outil
  `memory_search` (recherche plein texte).
- Outils : `memory_search`, `memory_write`, `memory_update`, `memory_delete` (chaque écriture est
  auditée ; la mémoire partagée en écriture est une permission par bot).
- **Résumés des longues conversations** : l'Agent SDK compacte automatiquement une session longue ; en
  plus, quand une session dépasse un seuil (défaut ~150 000 tokens), Ant la **fait tourner** : Haiku
  rédige un résumé du fil, une nouvelle session démarre avec ce résumé → coût par message borné.
- Écran Mémoire : consulter, filtrer, modifier, épingler, **supprimer définitivement**.
- Pas de recherche vectorielle en v1 (Anthropic ne fournit pas d'embeddings ; tu veux du Claude
  uniquement). Le schéma laisse la place à `pgvector` plus tard.

---

## 10. Planificateur : heartbeat, routines, résumé quotidien

Tout repose sur la file de jobs Postgres (persistante, survit aux redémarrages) et un passage du planificateur toutes les 30 s.

### Heartbeat (par bot, fréquence réglable, défaut toutes les 3 h en heures actives)
1. **Triage Haiku** (`claude-haiku-5-5`, effort `low`, sortie structurée via `outputFormat`) : reçoit un
   condensé (mémoire épinglée, tâches ouvertes, derniers échanges, relances déjà faites) et répond
   `{ creuser: bool, sujets: [...] }`.
2. Si `creuser` : run **Sonnet** qui approfondit et rédige 1 à 3 relances : idée, risque, oubli,
   prochaine étape, opportunité.
3. **Déduplication** : chaque relance a une empreinte ; les relances passées sont fournies au modèle ;
   pas de répétition d'un sujet ignoré avant N jours.
4. Livraison dans le fil « Relances » du bot + push (sauf heures de silence → reportées au résumé).

Priorité `background` → soumis aux seuils de réserve (§ 6.4).

### Heures de silence
Globales (ex. 22:00–07:30) + surcharge par bot. Pendant le silence : pas de heartbeat, pas de push
(sauf validation explicitement marquée urgente — réglable).

### Résumé quotidien
Une heure réglable : ce que les bots ont fait, ce qui attend une validation, relances reportées,
conso abonnement / dépenses API de la veille.

### Routines en langage naturel
« chaque lundi à 8h, fais-moi un point sur… » → Haiku traduit en `{ cron, fuseau, consigne, bot, canal }`
→ **carte de confirmation** affichant la lecture humaine (« Tous les lundis à 08:00, Europe/Zurich ») et
les 3 prochaines exécutions → enregistrée → planifiée. Modifiable/désactivable depuis l'écran Routines.

(implémentation) Chaque routine a sa propre session d'agent (`routine:<id>`), pour ses occurrences planifiées comme
pour « Exécuter maintenant » : elle ne reprend pas (et ne paie pas) toute la conversation où elle publie, se souvient de
ses passages précédents et lit ce qui a été écrit dans son canal depuis le dernier. Au plus une occurrence planifiée
attend : une nouvelle occurrence annule la précédente encore en file ou en pause. Les routines d'un bot archivé, ou
d'un canal archivé, ne partent plus. Une routine proposée par un bot (`routine_propose`) reste « proposée » jusqu'à ce
que tu l'actives.

---

## 11. Validations et journal d'audit

### Actions sensibles
Catégories : envoyer un message/e-mail en ton nom, publier, acheter/payer, supprimer, modifier un
compte/des réglages, et toute action déclarée « irréversible ».

Mécanisme :
- Les outils MCP Ant portent une **classe de risque**. Un outil sensible ne s'exécute jamais
  directement : l'appel crée une **carte de validation** (résumé lisible + paramètres exacts) et le bot
  reçoit « en attente de validation n°X ».
- Quand tu valides, **le worker exécute exactement les paramètres validés** (pas une nouvelle
  génération du modèle), puis reprend la session du bot avec le résultat. Robuste aux redémarrages :
  rien n'est « suspendu » en mémoire. (implémentation) Une validation s'exécute au plus une fois : l'exécution est
  réservée avant de commencer, et une exécution interrompue par un redémarrage se termine « échec — interrompue, état
  inconnu », avec un message et un push, sans être rejouée.
- Refus → le bot est informé avec ton éventuel commentaire. Expiration réglable.
- Navigateur : les actions `click`/`submit` sur des domaines classés sensibles (liste éditable :
  banques, boutiques, réseaux sociaux, messageries, comptes) passent par validation, avec capture
  d'écran de la page et de l'élément ciblé. Les commandes terminal correspondant à des motifs
  dangereux (`rm -r` hors /workspace, `curl … | sh`, etc.) aussi. (implémentation) La carte porte l'épingle (`pin`)
  du nœud exact montré : l'action validée est rejouée sur ce nœud, après vérification de son libellé, même si une lecture
  ultérieure a donné sa référence `eN` à un autre élément ; s'il a disparu ou changé, rien n'est fait.

### Journal d'audit
Table **en ajout seul** (un trigger Postgres interdit UPDATE/DELETE) : chaque run, chaque appel d'outil
(entrées expurgées des secrets), chaque validation, chaque bascule de source de calcul, chaque
connexion. Consultable et filtrable dans l'UI, exportable en CSV.

---

## 12. Schéma de base de données

(Drizzle, PostgreSQL 17 ; `id` en UUID v7 sauf mention ; `created_at`/`updated_at` partout.)

**Authentification**
- `owner` (1 ligne) : `password_hash` (argon2id), `totp_secret_enc`, `recovery_codes_hash[]`, `timezone`.
- `webauthn_credentials` : `credential_id`, `public_key`, `counter`, `transports`, `name`, `last_used_at`.
- `auth_sessions` : `id` (hash du jeton), `created_at`, `last_seen_at`, `expires_at`, `ip`, `user_agent`, `revoked_at`.
- `login_attempts` : `ip`, `at`, `success` (limitation des tentatives).

**Bots et conversations**
- `bots` : `slug`, `name`, `avatar`, `role`, `instructions`, `model`, `effort`, `permissions` (jsonb),
  `heartbeat_enabled`, `heartbeat_interval_min`, `quiet_hours` (jsonb, nullable), `paused`, `archived_at`.
- `channels` : `kind` (`dm`\|`group`), `name`, `topic`, `dm_bot_id` (nullable).
- `channel_members` : `channel_id`, `bot_id`.
- `messages` : `channel_id`, `thread_root_id` (nullable), `author_kind` (`user`\|`bot`\|`system`),
  `bot_id`, `content` (markdown), `content_tsv` (tsvector généré, index GIN), `meta` (jsonb : modèle,
  effort, source de calcul, coût, délégation), `run_id`, `status` (`streaming`\|`done`\|`error`).
- `agent_sessions` : `bot_id`, `thread_key`, `sdk_session_id`, `generation`, `approx_tokens`,
  `summary` (texte du résumé de rotation), `active`.

**Exécution, quota, budget**
- `runs` : `bot_id`, `channel_id`, `thread_key`, `trigger` (`user`\|`mention`\|`handoff`\|`heartbeat`\|`routine`\|`digest`\|`approval`),
  `priority`, `chain_id`, `hop`, `status`, `compute_source` (`subscription`\|`api`), `model`, `effort`,
  `started_at`, `finished_at`, `error`.
- `run_model_usage` : `run_id`, `model`, `compute_source`, `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `cost_usd` (estimé).
- `subscription_state` (1 ligne) : `status`, `limited_until`, `five_hour_util`, `five_hour_resets_at`,
  `seven_day_util`, `seven_day_resets_at`, `last_event_at`.
- `subscription_events` : historique des `rate_limit_event` reçus.
- `budget_alerts` : `scope` (`api_day`\|`api_month`\|`bot`\|`sub_5h`\|`sub_week`), `period_key`, `threshold`, `sent_at`.
- `settings` (clé/valeur jsonb) : mode de calcul, seuils, plafonds, heures de silence, heure du résumé,
  concurrence, fuseau.

**Mémoire, tâches, proactivité**
- `memory_items` : `scope` (`shared`\|`bot`), `bot_id`, `kind`, `title`, `content`, `tags[]`, `pinned`,
  `importance`, `author_kind`, `author_bot_id`, `source_message_id`, `tsv`.
- `tasks` : `bot_id`, `title`, `details`, `status` (`open`\|`waiting`\|`done`\|`dropped`), `due_at`, `source_message_id`.
- `nudges` : `bot_id`, `kind` (`idée`\|`risque`\|`oubli`\|`étape`\|`opportunité`), `content`,
  `fingerprint`, `status` (`delivered`\|`deferred`\|`dismissed`\|`acted`), `message_id`.
- `routines` : `bot_id`, `channel_id`, `source_text`, `cron`, `timezone`, `instruction`, `priority`,
  `enabled`, `last_run_at`.

**Ordinateur, validations, audit, push**
- `computer_control` (1 ligne) : `holder` (`agents`\|`user`), `since`, `bot_id` en cours.
- `approvals` : `run_id`, `bot_id`, `category`, `tool`, `payload` (jsonb exact), `summary`, `screenshot_path`,
  `status` (`pending`\|`approved`\|`rejected`\|`expired`\|`executed`\|`failed`), `decided_at`, `comment`, `result`.
- `audit_log` (bigserial, ajout seul) : `at`, `actor`, `event`, `run_id`, `tool`, `input_redacted`, `outcome`, `ip`.
- `push_subscriptions` : `endpoint`, `p256dh`, `auth`, `user_agent`, `last_ok_at`.

**Évolutions (migration `0003_features`, § 19)**
- `bots.completion_push`, `routines.completion_push` (nullable : hérite), `routines.proposed`, `routines.silent_if_nothing`,
  `tasks.assignee` (`bot`\|`owner`), `approvals.revoked_at`, `run_model_usage.purpose` et `routine_id`.
- `followups` : rappels (`reminder`, sans modèle) et travail différé (`work`, run déclencheur `followup`), un par échéance de tâche.
- `channel_reads` (marque de lecture par canal), `owner_presence` (une ligne par connexion temps réel).
- `service_status` (vie du worker, de la sauvegarde, dernier test de connexion).
- `drafts` (brouillons X), `watches` (veilles de pages et flux).

Prévu pour plus tard : `connectors` / `connector_credentials` (Gmail, Calendar, X, GitHub, Discord) et
`voice_sessions`, sans changer le reste.

---

## 13. Interface web / PWA

Écrans : **Bots** · **Canaux & messages privés** (fils, recherche) · **Ordinateur** (noVNC + terminal +
prendre/rendre la main) · **Routines** · **Mémoire** · **Validations en attente** · **Quota & budget**
(jauges 5 h / hebdo, réserve, dépenses API par bot/modèle/jour, mode de calcul) · **Journal d'audit** ·
**Réglages** (sécurité, passkeys, notifications, heures de silence).

- Sombre par défaut (thème clair disponible), responsive mobile d'abord pour les fils et validations.
- Temps réel par WebSocket : flux des réponses, indicateurs « Dev réfléchit… / utilise le navigateur »,
  badges de validations.
- PWA installable ; **Web Push** pour relances, validations, alertes de quota. (Sur iPhone, les push
  nécessitent d'installer la PWA sur l'écran d'accueil, iOS 16.4+.)
- Les cartes de validation sont actionnables depuis la notification (ouvre directement la carte).

---

## 14. Sécurité

- **Pas d'inscription.** Premier lancement : jeton d'initialisation à usage unique (valeur de `SETUP_TOKEN` dans
  `.env` ; quand elle est vide, Ant en génère un à chaque démarrage et l'affiche dans les logs du conteneur `web`)
  → création du mot de passe (≥ 14 caractères, vérifié contre une liste de mots de passe
  courants) + **passkey** (WebAuthn) **et/ou TOTP**, + 10 codes de secours. Ajouter une passkey redemande le mot de
  passe ; changer le mot de passe peut supprimer toutes les passkeys.
- argon2id ; limitation : 5 échecs / 15 min par IP puis délai exponentiel ; journalisation des connexions.
- Session : cookie `__Host-` HttpOnly, Secure, SameSite=Strict, jeton aléatoire stocké haché en base,
  expiration d'inactivité (12 h) et absolue (30 j), révocation depuis l'UI.
- WebSocket et proxys noVNC/terminal : même session + contrôle de l'en-tête `Origin`.
- En-têtes : CSP stricte, HSTS (via NPM), `X-Frame-Options: DENY`, etc.
- Toutes les routes sont authentifiées sauf : page de connexion, vérification de santé interne
  (non publiée), assets statiques.
- Secrets **uniquement via variables d'environnement** (`.env` en `chmod 600` sur la VM, jamais
  versionné ; `.env.example` sans valeurs). Expurgation automatique des secrets dans les logs et l'audit.
- Mises à jour : images épinglées par digest, Renovate/dependabot optionnel.

---

## 15. Estimation de la consommation

Hypothèses : prompt système Ant ~6 000 tokens (sans le prompt « Claude Code » complet), mémoire épinglée
~2 000, cache de prompt actif. Tarifs API (par million de tokens) : Sonnet 5.5 2 $ / 10 $ (lecture cache
0,20 $), Haiku 5.5 0,10 $ / 0,50 $, Opus 5.5 4 $ / 20 $ (lecture cache 0,20 $).
**Ordres de grandeur**, à recalibrer avec les mesures réelles de la phase 1.

| Activité | Hypothèse | Coût « équivalent API » |
|---|---|---|
| Triage heartbeat (Haiku) | ~7 000 tokens entrée, 300 sortie | ~0,001 $ |
| Approfondissement heartbeat (Sonnet) | 3–5 tours, ~40 000 entrée (surtout cache), 2 000 sortie | ~0,05 $ |
| Message interactif simple (Sonnet, medium) | 3 outils, ~70 000 entrée cumulée (surtout cache), 1 500 sortie | ~0,05–0,08 $ |
| Tâche navigateur (Sonnet) | ~30 étapes avec captures | ~0,40–0,80 $ |
| Sous-agent léger (Haiku) | résumé de 20 pages | ~0,01 $ |
| Sous-agent expert (Opus, high) | gros débogage | ~0,50–3 $ |

Scénario « usage modéré » : 4 bots, heartbeat toutes les 3 h sur 14 h actives (≈ 19 triages/jour,
~25 % approfondis), 30 messages/jour, 2 tâches navigateur/jour, 1 appel expert/jour :
- heartbeats ≈ 0,25 $/jour, messages ≈ 2 $/jour, navigateur ≈ 1,2 $/jour, expert ≈ 1,5 $/jour ;
- **≈ 5 $/jour ≈ 150 $/mois en équivalent API.**

Lecture : avec l'abonnement par défaut, l'essentiel est absorbé par le forfait (compté dans tes limites
5 h / hebdo, que les seuils de réserve protègent) ; les ~100 $ de crédits API couvrent les débordements.
Si tu passais en « crédits API uniquement », ce scénario dépasserait 100 $/mois : il faudrait réduire la
fréquence des heartbeats, le recours à Opus ou les tâches navigateur. Les heartbeats seuls (~8 $/mois)
sont négligeables grâce au triage Haiku.

---

## 16. Plan par phases

| Phase | Contenu | Démo de fin de phase |
|---|---|---|
| 1 | Monorepo, Compose, Postgres/Drizzle, auth complète (mot de passe + passkey/TOTP + limitation), 1 bot, messages privés en temps réel, Agent SDK, connexion abonnement + repli API, QuotaManager, écran Quota & budget, audit de base, README Proxmox | tu te connectes, discutes avec un bot, vois la source de calcul et la conso ; bascule simulée vers l'API |
| 2 | N bots, canaux de groupe, fils, @mentions, transferts + anti-boucle, recherche, mémoire partagée/par bot + écran Mémoire, rotation/résumés de sessions | « Chef de cabinet » délègue à « Dev » dans un canal |
| 3 | Conteneur `computer` (terminal, fichiers, Chromium persistant), outils MCP, vue Ordinateur (noVNC + xterm), prise de main, validations (cartes, exécution exacte), règles navigateur sensibles, durcissement réseau | un bot navigue, tu reprends la main ; une action sensible attend ta validation |
| 4 | Heartbeat (triage Haiku → Sonnet), relances dédupliquées, heures de silence, résumé quotidien, routines en langage naturel, Web Push, PWA | une relance pertinente arrive en push sur ton téléphone |
| 5 | Sous-agents léger/expert avec règles et traçage, garde-fous Opus, finitions UI, tests e2e, sauvegardes, revue sécurité | rapport de tests + revue de sécurité |

À chaque phase : tests des parties critiques (QuotaManager, budget, auth, validations, anti-boucle,
planificateur), et je signale explicitement tout ce qui n'est pas terminé.

---

## 17. Limites connues et risques

- **Conditions d'utilisation de l'abonnement** : voir § 6.1. Le fonctionnement autonome 24 h/24 sur
  abonnement n'est pas explicitement autorisé par les textes.
- **Utilisation de l'abonnement** : la lecture des fenêtres 5 h / hebdo repose sur les événements
  `rate_limit_event` (typés dans le SDK, mais leur fréquence et l'unité de `utilization` ne sont pas
  documentées : à calibrer en phase 1). La jauge détaillée via `usage_EXPERIMENTAL…` peut changer ou
  disparaître : c'est un bonus, jamais une dépendance. Conséquence : avant le premier événement d'une
  fenêtre, Ant ne connaît pas ton niveau d'utilisation et applique les règles de prudence.
- **Jeton d'abonnement** valable un an, sans renouvellement automatique documenté : alerte avant expiration.
- **Coûts API = estimations** de l'Agent SDK ; la limite de dépense dans la Console reste le garde-fou ultime.
- **Navigateur libre** : la détection d'actions sensibles par domaine/motif est un filet de sécurité,
  pas une garantie absolue. Les connecteurs structurés (v2) permettront une validation exhaustive des
  envois/publications.
- **Injection de prompt** depuis le web : limitée par l'isolation (pas de secrets dans `computer`,
  pas d'accès LAN), les validations et l'audit.
- **Ressources VM** recommandées : 4 vCPU, 8 Go RAM, 60 Go disque (Chromium + Postgres + Node).

---

## 18. Décisions prises (réponses aux questions ouvertes)

Sans réponse détaillée, les recommandations ont été appliquées : mode « Hybride prudent », plafonds 8 $/jour et 100 $/mois,
fuseau Europe/Zurich, silence 22:00–07:30, résumé à 07:45, passkey + TOTP + codes de secours, interface en français,
VM 4 vCPU / 8 Go / 60 Go. Tout est modifiable dans l'interface (écrans Quota & budget et Réglages).

### Questions d'origine

1. **Abonnement et autonomie (bloquant pour le défaut du mode de calcul)** : après lecture du § 6.1,
   choisis entre (a) « Hybride prudent » par défaut (ma recommandation), (b) « Abonnement puis crédits
   API » pour tout, comme demandé initialement, en connaissance du risque, ou (c) API uniquement tant
   que tu n'as pas de confirmation d'Anthropic.
2. **Crédits API** : je n'ai pas pu vérifier dans la documentation les « ~100 $ inclus dans
   l'abonnement ». Quel plafond mensuel strict mettre par défaut (100 $ ?) et quel plafond quotidien
   (proposition : 8 $) ?
3. **Fuseau horaire** : Europe/Zurich ? Heures de silence par défaut (proposition : 22:00–07:30) et
   heure du résumé quotidien (proposition : 07:45) ?
4. **Deuxième facteur** : passkey + TOTP de secours + codes de secours (proposition), ou seulement l'un des deux ?
5. **Réseau** : plage(s) IP de ton LAN à bloquer et IP de Nginx Proxy Manager (pour les règles de
   pare-feu du README). Le domaine peut rester à définir jusqu'au déploiement.
6. **Ressources de la VM** : 4 vCPU / 8 Go / 60 Go te conviennent-ils ?
7. **Langue** : interface et bots en français par défaut ?

---

## 19. Évolutions

> Statut : **socle posé** (schéma, types partagés, contrat d’API, points d’extension). Quatre équipes développent en
> parallèle, chacune dans sa branche, sans toucher au schéma, aux types partagés ni aux fichiers des autres. Contrat exact
> des routes, outils, événements et tâches de fond : [API.md, « Évolutions »](API.md#évolutions--contrat-des-équipes-a-à-d).

| Équipe | Module | Fonctionnalités |
|---|---|---|
| A | `tracking` | Push de fin de travail, outil `notify_owner`, lu / non-lu côté serveur, présence, vue « Suivi » (tâches de tous les bots et du propriétaire), suivis et rappels (`followup_schedule`…, déclencheur `followup`) |
| B | `ops` | Écran Santé, arrêt d’urgence « Tout arrêter », coût par origine et projection, premier démarrage guidé (équipe de départ, test de connexion) |
| C | `inputs` | Pièces jointes dans les deux sens, partage vers Ant (`/share`), « Approfondir » (modèle ponctuel) |
| D | `capabilities` | Transfert avec retour, lecture web économique (`web_extract`), brouillons X, veilles sans modèle |

### 19.1 Un module par fonctionnalité

Chaque équipe remplit **son** module à chaque couche ; les fichiers partagés appellent tous les modules par un registre,
déjà branché, que personne ne modifie.

| Couche | Registre (figé) | Fichier de l’équipe | Ce qu’un module peut fournir |
|---|---|---|---|
| Worker | `apps/server/src/worker/modules/index.ts` (`WorkerModule`, `types.ts`) | `worker/modules/<module>.ts` | outils MCP, outils du sous-agent léger, libellés d’activité, section du prompt système, description et prompt des déclencheurs, exécutions silencieuses, prompt en messages SDK (images, PDF), hook après exécution, gestionnaires de tâches de fond, passage du planificateur (30 s), maintenance horaire, démarrage |
| Web | `apps/server/src/web/modules/index.ts` (`WebModule`) | `web/modules/<module>.ts` | routes REST, démarrage / arrêt (minuteries), messages WebSocket reçus (`ClientEvent`), fermeture de connexion |
| Interface | `apps/ui/src/features/index.tsx` (`FeatureModule`, `types.ts`) | `features/<module>/index.tsx` (+ ses composants dans ce dossier) | écrans dans le shell, écrans plein écran, navigation (rail, menu « Plus », pastille), actions du rail et du menu mobile, bannières, composants sans rendu (effets), événements temps réel, extras sous un message, entrées du menu « ··· » d’un message, haut de conversation, cartes de l’accueil, sections des réglages, panneaux de la fiche bot |
| Partagé | `packages/shared/src/index.ts` exporte déjà les quatre | `packages/shared/src/<module>.ts` | constantes et fonctions pures (limites, modèles d’équipe, comptage X…) |
| Tâches de fond | `JobKinds` (`lib/jobs.ts`) | — | `followup.fire`, `diagnostic`, `watch.check` déjà déclarés ; un type imprévu se déclare par augmentation de `JobKinds` depuis le fichier du module |

Règles des registres :
- Ordre fixe : `tracking`, `ops`, `inputs`, `capabilities`. Pour `describeTrigger`, `buildPrompt` et `userMessage`, le premier
  module qui répond l’emporte : chacun ne répond que pour ses propres déclencheurs (ou ses propres données).
- Un hook qui lève une erreur, synchrone ou non, est journalisé sans arrêter les autres modules ni l’exécution (côté
  web : des routes qui ne s’enregistrent pas ou un démarrage en échec n’empêchent pas le service de démarrer) ; un
  gestionnaire de tâche de fond, lui, propage l’erreur (la file la note et réessaie).
- `afterRun` reçoit chaque état final d’une exécution, y compris celles fermées sans s’exécuter (annulée en attente, bot
  en pause, conversation archivée, échec du travail, orpheline) : contrat de `FinishedRun` dans
  [API.md](API.md#hook-afterrun-finishedrun).
- Une section du prompt système ne dépend que du bot et de ses permissions (le prompt statique est mis en cache).
- Pendant l’arrêt d’urgence (`settings.emergencyStop`), un `onSchedulerTick` ne lance rien de nouveau.
- Dans l’interface, un slot qui n’a rien à montrer rend `null` ; les nouveaux types d’événements temps réel ne sont traités
  que par les `onEvent` des modules. Chaque contribution est rendue dans sa propre limite d’erreur (`FeatureBoundary`) :
  un composant qui plante disparaît seul (une entrée de navigation garde son lien, sans pastille), le shell et l’écran
  restent.

### 19.2 Conception

**A — Suivi et notifications.** Le push de fin de travail est un hook `afterRun` : il combine la durée de l’exécution, le
mode (`routine` → `bot` → réglage global, `always` / `long` / `never`) et la présence du propriétaire. La présence passe
par la socket temps réel existante (`focus`, une ligne `owner_presence` par connexion, expirée après 60 s : une socket
mobile meurt sans prévenir). Le lu / non-lu vit dans `channel_reads` (une marque par canal, qui n’avance que), le
`localStorage` ne sert plus que de mise à jour optimiste. Suivis et rappels : **une table `followups` plutôt que des runs
planifiés** — un rappel du propriétaire n’a ni bot ni modèle, un run futur apparaîtrait dans « Exécutions en cours », et une
table se liste, se déplace et s’annule simplement ; un suivi `work` démarre au moment voulu un run déclencheur `followup`. Une
échéance de tâche possède un seul suivi (`task_id`), seule source de l’échéance. `tasks.assignee` distingue les tâches du
propriétaire, suivies par un bot.

**B — Santé et confiance.** **`service_status` plutôt que `compute_state.worker_seen_at`** : une ligne par service (worker,
sauvegarde, test de connexion), écrite sans publier `quota.updated` toutes les 30 s, lisible par le script de sauvegarde
avec `psql`. La vie du worker est déjà écrite et exposée (`QuotaStatusDTO.worker`), et la bannière globale « Le worker
ne répond pas » existe déjà (`PausedBanner`) : l'écran Santé s'y relie sans en ajouter une seconde. `/healthz` interroge
déjà la base ; les healthchecks Docker du worker (fichier `/tmp/alive` touché par le module `ops`) et de l’ordinateur
(`GET /health`) sont à faire par l’équipe B. L’arrêt d’urgence est un état
`settings.emergencyStop` géré par le serveur (refusé par `PATCH /api/settings`) : pause des bots (liste mémorisée pour la
reprise), annulation des exécutions, prise de main sur l’ordinateur, refus des validations, révocation des autorisations de
domaine (`grantsRevokedAt`, et `approvals.revoked_at` pour une révocation à l’unité) ; le planificateur ne lance déjà plus
rien pendant l’arrêt. Mettre un seul bot en pause annule aussi ses exécutions, et l’écran Validations propose de refuser
les siennes. Coût par origine : chaque ligne `run_model_usage` porte déjà `purpose` et `routine_id` (runs, suites,
appels ponctuels), la projection mensuelle est servie, le plafond par exécution sur l’abonnement est appliqué. Premier
démarrage : test de connexion par une tâche `diagnostic` (résultat dans `service_status`), équipe de départ créée par
`POST /api/bots/batch`, guide `/bienvenue` tant que `onboardingDoneAt` est nul (déjà posé pour les installations existantes).

**C — Entrées.** Les fichiers vivent sur l’ordinateur des agents (`/workspace/inbox/AAAA-MM-JJ/…` pour les envois du
propriétaire, n’importe où dans `/workspace` pour les bots) : **pas de table**, les métadonnées sont dans
`messages.meta.attachments`. L’aperçu en ligne ne sert que des images et des PDF (liste blanche, `nosniff`, CSP) : un SVG
ou un HTML écrit par un bot ne doit jamais s’exécuter sur l’origine d’Ant. Images et PDF entrent dans le prompt par le hook
`userMessage` ; un bot joint un fichier à sa réponse par `rc.outputs.attachments` (le runner l’écrit déjà dans la réponse
finale). « Approfondir » passe un modèle ponctuel à `dispatchUserMessage` (déjà accepté par `requestRun`, et conservé par la
suite automatique) sans toucher au modèle par défaut du bot.

**D — Capacités des agents.** Le transfert avec retour vit dans `payload.reportTo` du run délégué ; le hook `afterRun`
réveille le délégant une seule fois quand tous ses délégués ont fini (réclamation atomique sur le run délégant). La lecture
web économique fait lire la page par Haiku via `oneShot` en imputant le coût au run (`runId` : lignes d’usage et totaux du
run, `purpose: 'web_extract'`).
Brouillons X : table `drafts`, publication toujours manuelle par le lien d’intention X (les règles de X interdisent
d’automatiser le site). Veilles : table `watches`, récupération dans l’ordinateur (sans secret ni accès au LAN) par la tâche
`watch.check`, par `curl` seulement dans ce tour (la page Chromium est unique et partagée : le rendu par navigateur
attend un contexte de navigation isolé dans la RPC de l’ordinateur) ; le bot n’est réveillé (déclencheur `watch`) que
si l’empreinte change ; ses exécutions sont silencieuses (hook `silentRun`) et ne publient rien quand il répond `RIEN`
(`isSilentNothing`), comme les routines « silencieuses si rien ».

**Hors de ce tour** (décidé, pas oublié) : dans le premier démarrage guidé, « Nouveau bot → À partir d’un modèle » et des
permissions réduites pour un bot créé vierge. Le premier touche le formulaire de bot (équipe A) et l’écran Bots (équipe
B) à la fois ; le second change `DEFAULT_BOT_PERMISSIONS`, donc le comportement de l’API pour tout client. L’équipe de
départ créée par le guide part déjà avec les permissions minimales de son modèle (`BOT_TEMPLATES`).

**Déjà en place dans le socle** (aucune équipe n’a à le refaire) : migration `0003_features` avec reprise des données
(routines déjà proposées, origine des coûts déjà enregistrés, premier démarrage marqué fait s’il existe des bots) ; vie du
worker et projection mensuelle dans `GET /api/quota` ; `purpose` / `routine_id` sur toute consommation ; plafond par
exécution sur l’abonnement ; modèle et effort ponctuels dans `requestRun` et `dispatchUserMessage` ; clés d’origine
(`routineId`, `reportTo`, `followupId`, `watchId`, `draftId`, `depth`) et modèle conservés par la suite automatique ;
`rc.outputs.attachments` → `meta.attachments` ; champs `proposed`, `completionPush`, `silentIfNothing` des routines,
`completionPush` des bots, `assignee` des tâches (création), `lastReadAt` des canaux, `revokedAt` des validations ;
arrêt du planificateur pendant l’arrêt d’urgence ; messages `ClientEvent` validés et identifiant par connexion ;
`realtime.send()` dans l’interface ; outil `handoff` dans son propre fichier ; `okWithImage(texte, base64, mime)` ;
affichage des messages `reminder` et `draft`, pastille « Veille », libellés des déclencheurs et des événements d’audit ;
`effectiveTrigger()` et `chainStartedAt()` (origine et début d’une tâche continuée), `afterRun` sur chaque état final
avec `silent`, `attachments` et la durée de la tâche entière ; `isSilentNothing()` ; `resolveMessageTargets()` ; coût
d’un appel ponctuel ajouté au run (`addRunUsage`) ; rotation des sessions `watch:<id>` (et de tout `<préfixe>:<id>`)
d’après leurs exécutions ; réglages écrits sous verrou (une modification du propriétaire n’efface pas l’arrêt
d’urgence) ; projection mensuelle comptant au moins 3 jours ; `/healthz` qui interroge la base ; `draft.updated` qui ne
porte que l’identifiant.

### 19.3 Carte des fichiers

Chaque équipe ne modifie que les fichiers de sa liste et ne crée de fichiers que sous les noms indiqués (ou préfixés par le
nom de son module). Tout autre fichier existant est **figé** pour ce tour : un besoin non couvert (champ, type, hook) se
signale à l’architecte, qui le livre dans le socle pour tout le monde.

**Figés** (personne) :
- schéma et migrations : `apps/server/src/db/schema.ts`, `apps/server/drizzle/**` ;
- types partagés : `packages/shared/src/{api,settings,index,models,quota,risk,computer,time,redact,mentions,cron-describe}.ts` ;
- serveur : `apps/server/src/{config,web,worker}.ts`, `src/lib/**`, `src/services/{runs,quota,messages,channels,bots,memory,nudges,computer-state,service-status,context}.ts`,
  `src/worker/{runner,main,scheduler,run-context,prompt,deps,heartbeat,rotate,routine-parse,approvals-exec}.ts`,
  `src/worker/modules/{index,types}.ts`, `src/worker/tools/{index,helpers,memory,approvals,nudges}.ts`,
  `src/web/{app,ws,deps,security,session,session-sockets}.ts`, `src/web/modules/{index,types}.ts`, `src/web/routes/auth.ts` ;
- interface : `apps/ui/src/{App,main}.tsx`, `src/features/{index.tsx,types.ts}`, `src/lib/{ws,ws-dispatch,queries,cache,labels,api}.ts`,
  `src/components/layout/{AppShell,IconRail,MobileTabBar}.tsx`, `src/components/layout/shell.ts`,
  `src/components/chat/{MessageItem,SystemMessage,MessageList,ChannelHeader}.tsx`, `src/components/audit/labels.ts`,
  `src/routes/{Home,Settings,BotDetail,Conversation}.tsx`.

**Équipe A — `tracking`**
- Modifie : `apps/server/src/worker/modules/tracking.ts`, `apps/server/src/web/modules/tracking.ts`,
  `apps/server/src/services/{tasks,push}.ts`, `apps/server/src/web/routes/knowledge.ts`,
  `apps/server/src/worker/tools/tasks.ts`, `apps/server/src/worker/digest.ts`, `packages/shared/src/tracking.ts`,
  `apps/ui/src/features/tracking/**`, `apps/ui/src/lib/unread.ts`, `apps/ui/src/components/layout/ConversationList.tsx`,
  `apps/ui/src/components/bots/{BotForm,BotSidePanels}.tsx`, `apps/ui/src/components/memory/MemoryModal.tsx`,
  `apps/ui/src/components/settings/NotificationsSection.tsx`.
- Crée : `apps/server/src/services/{followups,presence,reads}.ts`, `apps/server/src/worker/tools/{followups,notify}.ts`,
  `apps/server/src/worker/followups.ts`, tests `apps/server/test/tracking-*.test.ts`, `apps/ui/test/tracking-*.test.tsx`.

**Équipe B — `ops`**
- Modifie : `apps/server/src/worker/modules/ops.ts`, `apps/server/src/web/modules/ops.ts`,
  `apps/server/src/services/approvals.ts`, `apps/server/src/worker/{approval-flow,alerts,oneshot,compute}.ts`,
  `apps/server/src/web/routes/{system,quota,approvals,bots}.ts`, `packages/shared/src/ops.ts`, `deploy/**`,
  `docker-compose.yml`, `apps/server/Dockerfile`, `.env.example`, `README.md`, `apps/ui/src/features/ops/**`,
  `apps/ui/src/routes/{Quota,Approvals,Bots,Setup}.tsx`, `apps/ui/src/components/{quota,approvals}/**`,
  `apps/ui/src/components/layout/PausedBanner.tsx`, `apps/ui/src/lib/usage.ts`.
- Crée : `apps/server/src/services/{health,emergency,costs}.ts`, `apps/server/src/worker/diagnostic.ts`, tests
  `apps/server/test/ops-*.test.ts`, `apps/ui/test/ops-*.test.tsx`, `deploy/tests/*`.

**Équipe C — `inputs`**
- Modifie : `apps/server/src/worker/modules/inputs.ts`, `apps/server/src/web/modules/inputs.ts`,
  `apps/server/src/services/computer-client.ts`, `apps/server/src/web/routes/{channels,computer}.ts`,
  `apps/server/src/worker/tools/messaging.ts`, `packages/shared/src/inputs.ts`, `apps/computer/**`,
  `apps/ui/src/features/inputs/**`, `apps/ui/src/components/chat/{Composer.tsx,useSendMessage.ts,ModelSelector.tsx}`,
  `apps/ui/src/lib/models.ts`, `apps/ui/src/components/computer/**`, `apps/ui/src/sw.ts`, `apps/ui/vite.config.ts`.
- Crée : `apps/server/src/services/attachments.ts`, `apps/server/src/worker/attachments.ts`,
  `apps/server/src/worker/tools/attachments.ts`, tests `apps/server/test/inputs-*.test.ts`, `apps/ui/test/inputs-*.test.tsx`,
  `apps/computer/test/upload*.test.ts`.

**Équipe D — `capabilities`**
- Modifie : `apps/server/src/worker/modules/capabilities.ts`, `apps/server/src/web/modules/capabilities.ts`,
  `apps/server/src/worker/handoff.ts`, `apps/server/src/worker/tools/{handoff,computer,routines}.ts`,
  `apps/server/src/services/routines.ts`, `apps/server/src/web/routes/routines.ts`, `packages/shared/src/{capabilities,loop-guard}.ts`,
  `apps/ui/src/features/capabilities/**`, `apps/ui/src/routes/Routines.tsx`, `apps/ui/src/components/routines/**`
  (dont le choix « Notifier à la fin » d’une routine, champ `completionPush` déjà servi par l’API).
- Crée : `apps/server/src/services/{drafts,watches}.ts`, `apps/server/src/worker/{handoff-return,watch-check}.ts`,
  `apps/server/src/worker/tools/{drafts,watches,web-extract}.ts`, tests `apps/server/test/capabilities-*.test.ts`,
  `apps/ui/test/capabilities-*.test.tsx`, `packages/shared/test/capabilities.test.ts`.

### 19.4 Règles de fusion

- Aucune migration, aucune modification des types partagés ni des fichiers figés.
- Tests : de nouveaux fichiers préfixés par le module ; un test existant ne se modifie que si le changement de l’équipe le
  casse, et seulement l’assertion concernée. `pnpm -r run typecheck` et toutes les suites restent vertes à chaque fusion.
- Documentation : chaque équipe complète **sa** section de [API.md](API.md#évolutions--contrat-des-équipes-a-à-d) (écarts
  avec le contrat signalés « (implémentation) »), son paragraphe du § 19.2 et sa sous-section de [ETAT.md](ETAT.md).
- Textes visibles en français, sur le ton existant ; pas de TODO, pas de bouchon, pas d’interface morte.
