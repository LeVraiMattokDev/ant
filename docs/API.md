# API d'Ant

Toutes les routes sont sous `/api`, en JSON, et **exigent une session complète** (cookie `__Host-ant_session`,
ou `ant_session` en développement HTTP) sauf mention « public ». Les types sont dans `packages/shared/src/api.ts`.

Erreurs : statut HTTP ≥ 400 et corps `ApiErrorBody` `{ error: string, message: string, details? }` (message en français,
affichable tel quel). Un identifiant mal formé dans le chemin ou la requête (lien tronqué) donne `400 invalid_request`,
jamais une erreur 500.

Protection CSRF : les requêtes qui modifient (POST/PATCH/PUT/DELETE) doivent envoyer l'en-tête
`X-Requested-With: ant` ; l'en-tête `Origin` est vérifié.

## Authentification

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET (public) | `/api/auth/state` | — | `AuthStateDTO` |
| POST (public) | `/api/auth/setup` | `{ setupToken, password }` | `SetupStartResponse` (session au stade « enroll ») |
| POST (stade enroll) | `/api/auth/setup/totp` | `{ code }` | `RecoveryCodesResponse` (session complète) |
| POST (public) | `/api/auth/login` | `{ password }` | `{ next: 'second_factor' }` (session au stade « mfa ») |
| POST (stade mfa) | `/api/auth/login/second-factor` | `{ code }` ou `{ recoveryCode }` | `{ ok: true }` (session complète) ; `409 encryption_key_mismatch` (voir ci-dessous) |
| POST (public) | `/api/auth/passkey/login/options` | — | options WebAuthn (`PublicKeyCredentialRequestOptionsJSON`) |
| POST (public) | `/api/auth/passkey/login/verify` | `{ response }` (résultat de `startAuthentication`) | `{ ok: true }` |
| POST | `/api/auth/passkey/register/options` | `{ password }` (mot de passe actuel) | options WebAuthn (`PublicKeyCredentialCreationOptionsJSON`) ; `400` sans mot de passe, `401 invalid_credentials` s'il est faux |
| POST | `/api/auth/passkey/register/verify` | `{ response, name }` | `PasskeyDTO` |
| GET | `/api/auth/passkeys` | — | `PasskeyDTO[]` |
| DELETE | `/api/auth/passkeys/:id` | — | `{ ok: true }` ; `404 not_found` pour un identifiant inconnu |
| POST | `/api/auth/logout` | — | `{ ok: true }` |
| GET | `/api/auth/sessions` | — | `AuthSessionDTO[]` |
| DELETE | `/api/auth/sessions/:id` | — | `{ ok: true }` |
| POST | `/api/auth/password` | `{ current, next, revokePasskeys? }` | `{ ok: true }` (déconnecte les autres sessions ; `revokePasskeys: true` supprime aussi toutes les passkeys) |
| POST | `/api/auth/recovery-codes` | `{ password }` | `RecoveryCodesResponse` |

Limitation : 5 échecs par IP en 15 minutes → `429` avec `message` indiquant le délai.

- Ajouter une passkey redemande le mot de passe : une session empruntée ou volée ne peut pas y planter la sienne. La
  suppression d'une passkey n'ouvre aucun accès : elle est auditée (avec son nom) et le propriétaire reçoit une alerte.
- `invalid_setup_token` (`403`) renvoie vers la valeur de `SETUP_TOKEN` dans `.env` ; quand elle est vide, le jeton
  généré est affiché dans les journaux du conteneur `web` (une valeur venant de `.env` y est toujours masquée).
- `409 encryption_key_mismatch` : le secret TOTP a été chiffré avec une autre `ENCRYPTION_KEY` (base restaurée sans son
  `.env`). Le message invite à se connecter avec un code de secours ou une passkey, puis à remettre l'ancienne clé.

## Bots

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/bots` | — | `BotDTO[]` |
| POST | `/api/bots` | `BotInput` | `BotDTO` |
| PATCH | `/api/bots/:id` | `Partial<BotInput>` | `BotDTO` ; `409 slug_taken` si l'identifiant est pris (le message dit s'il appartient à un bot archivé) |
| DELETE | `/api/bots/:id` | — | `{ ok: true }` (archive) |
| POST | `/api/bots/:id/heartbeat` | — | `{ ok: true }` (lance un heartbeat maintenant) |

`BotInput.completionPush` (`'always' | 'long' | 'never' | null`, `null` = réglage global) règle le push de fin de travail
de ce bot (§ A). Des heures de silence mal formées donnent `400 invalid_quiet_hours`.

## Canaux et messages

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/channels` | — | `ChannelDTO[]` (DM inclus) |
| POST | `/api/channels` | `ChannelInput` | `ChannelDTO` |
| PATCH | `/api/channels/:id` | `Partial<ChannelInput>` | `ChannelDTO` |
| DELETE | `/api/channels/:id` | — | `{ ok: true }` |
| GET | `/api/channels/:id/messages` | `?before=<id de message>&limit=50` | `MessageDTO[]` (messages de premier niveau, du plus ancien au plus récent) |
| POST | `/api/channels/:id/messages` | `PostMessageInput` | `{ message: MessageDTO, runs: RunDTO[] }` |
| GET | `/api/messages/:id/thread` | — | `{ root: MessageDTO, replies: MessageDTO[] }` |
| GET | `/api/search` | `?q=&channelId=&botId=&from=&to=` | `SearchResultDTO[]` |

Dans un canal de groupe : les bots @mentionnés répondent ; sans mention, les bots déjà présents dans le fil ;
sinon le premier bot du canal.

- Pagination : `before` est l'identifiant du plus ancien message déjà affiché (curseur exact sur `created_at, id`, comme
  le fait l'interface). Une date ISO reste acceptée pour les anciens clients, mais saute les messages écrits dans la même
  milliseconde.
- Recherche : dans `SearchResultDTO.snippet`, les mots trouvés sont entourés de `SEARCH_MARK_START` (U+0002) et
  `SEARCH_MARK_END` (U+0003), exportés par `@ant/shared` : des caractères de contrôle, jamais confondus avec le texte
  (« guillemets » compris). Les `**`, `__` et `~~` orphelins sont retirés de l'extrait.

`ChannelDTO.lastReadAt` est la marque de lecture du propriétaire, commune à tous ses appareils (§ A). `PostMessageInput`
accepte aussi `attachments` et `depth` (§ C).

## Exécutions

| Méthode | Route | Réponse |
|---|---|---|
| GET | `/api/runs?limit=&botId=` | `RunDTO[]` |
| GET | `/api/runs/active` | `RunDTO[]` |
| POST | `/api/runs/:id/cancel` | `{ ok: true }` |

## Mémoire, tâches, relances

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/memory` | `?scope=shared|bot&botId=&q=&kind=` | `MemoryItemDTO[]` |
| POST | `/api/memory` | `MemoryInput` | `MemoryItemDTO` |
| PATCH | `/api/memory/:id` | `Partial<MemoryInput>` | `MemoryItemDTO` |
| DELETE | `/api/memory/:id` | — | `{ ok: true }` |
| GET | `/api/tasks` | `?botId=&status=open,waiting` | `TaskDTO[]` (avec `assignee`) ; `400 unknown_bot` en création pour un bot inconnu ou archivé (de même pour la mémoire) |
| POST | `/api/tasks` | `{ botId, title, details?, dueAt? }` | `TaskDTO` |
| PATCH | `/api/tasks/:id` | `{ title?, details?, status?, dueAt? }` | `TaskDTO` |
| DELETE | `/api/tasks/:id` | — | `{ ok: true }` |
| GET | `/api/nudges` | `?botId=&limit=` | `NudgeDTO[]` |
| PATCH | `/api/nudges/:id` | `{ status: 'dismissed' | 'acted' }` | `NudgeDTO` |

Évolution (§ A) : filtre `assignee`, corps `TaskCreateInput` / `TaskPatchInput` (tâches du propriétaire, réassignation),
échéance reliée à un suivi.

## Routines

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/routines` | — | `RoutineDTO[]` |
| POST | `/api/routines/parse` | `RoutineParseInput` | `RoutineDraftDTO` (interprétation du langage naturel par Haiku ; `504 parse_timeout` après 55 s, avant le délai de 60 s de Nginx Proxy Manager) |
| POST | `/api/routines/preview` | `{ cron, timezone? }` | `{ description, nextRuns }` |
| POST | `/api/routines` | `RoutineInput` | `RoutineDTO` |
| PATCH | `/api/routines/:id` | `Partial<RoutineInput>` | `RoutineDTO` |
| DELETE | `/api/routines/:id` | — | `{ ok: true }` |
| POST | `/api/routines/:id/run` | — | `{ ok: true }` (exécution immédiate, dans la session propre de la routine) ; `400 invalid_channel` si son canal est archivé, `409 bot_paused` |

`RoutineDTO.proposed` : routine proposée par un bot (`routine_propose`), pas encore activée ; l’activer (`enabled: true`)
lève l’indicateur. Un bot qui la propose depuis une conversation où ses routines ne peuvent pas publier (la conversation
privée d’un autre bot, atteinte par un transfert) la propose dans sa propre conversation privée.

- Cible : `channelId: null` (ou absent à la création) = la conversation privée du bot. `PATCH` avec `botId` sans
  `channelId` garde le canal si le nouveau bot peut y publier, sinon prend sa conversation privée. Bot inconnu ou archivé
  → `400 unknown_bot` ; canal inconnu, archivé ou dont le bot n'est pas membre → `400 invalid_channel`. Activer une
  routine revérifie son horaire (`400 too_frequent`) et sa cible.
- Chaque routine a sa propre session d'agent (`routine:<id>`), pour ses exécutions planifiées comme manuelles : elle se
  souvient de ses occurrences précédentes et lit ce qui a été écrit dans son canal depuis son dernier passage.
- Au plus une occurrence planifiée attend : quand une nouvelle occurrence part alors que la précédente attend encore
  (en file ou en pause faute de source de calcul), la précédente est annulée (« remplacée par une occurrence plus récente
  de la routine »). Une exécution lancée à la main n'est jamais remplacée. Les routines d'un bot archivé ne partent
  jamais.
- La réponse publiée par une exécution de routine porte `meta.routineId`. `RoutineInput` accepte `completionPush` (`null` = réglage du bot, § A) et `silentIfNothing` (aucun
message quand le bot répond `RIEN`, § D). `proposed` n’est jamais accepté en entrée.

## Validations

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/approvals` | `?status=pending` | `ApprovalDTO[]` (les 200 plus récentes) |
| GET | `/api/approvals/:id` | — | `ApprovalDTO` (quel que soit son âge : carte ou notification ouverte plus tard) ; `404` pour un identifiant inconnu ou mal formé |
| GET | `/api/approvals/:id/screenshot` | — | `image/png` |
| POST | `/api/approvals/:id/decide` | `ApprovalDecisionInput` | `ApprovalDTO` |

Une validation s'exécute au plus une fois ; une exécution interrompue par un redémarrage se termine en échec (« état
inconnu ») avec un message et un push, sans être rejouée. Un clic (ou une touche envoyée à un élément) validé sur un site
sensible est rejoué sur le nœud exact montré sur la carte : `payload.pin`, posé par `browser/inspect` lors de la demande,
avec vérification que son libellé (`payload.expectedLabel`) n'a pas changé. Sans `pin` ni libellé, ou si l'élément a
disparu ou changé, l'action n'est pas exécutée.

## Quota et budget

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/quota` | — | `QuotaStatusDTO` |
| GET | `/api/quota/usage` | `?days=30` | `UsageRowDTO[]` |
| POST | `/api/quota/subscription/reset` | — | `QuotaStatusDTO` (lève manuellement l'état « limité ») |

`QuotaStatusDTO.api.forecastMonthUsd` : projection linéaire de la dépense API du mois (dépensé ÷ jours écoulés × jours du
mois, au fuseau des réglages), les jours écoulés comptés au moins 3 (`FORECAST_MIN_ELAPSED_DAYS`) : une grosse dépense
dans la première heure du mois ne se projette pas sur le mois entier. `QuotaStatusDTO.worker` : `{ lastSeenAt, alive }`, d’après la ligne `worker` de
`service_status` écrite par le worker à chaque passage du planificateur (≈ 30 s) ; `alive` est faux au-delà de 120 s.
L'interface interroge alors le quota chaque minute et affiche sur tous les écrans la bannière « Le worker ne répond
pas » (`PausedBanner`) ; une exécution en file y est dite « attend le worker ».

## Réglages, audit, push

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/settings` | — | `SettingsDTO` |
| PATCH | `/api/settings` | `Partial<SettingsDTO>` | `SettingsDTO` |
| GET | `/api/audit` | `?event=&actor=&before=<id>&limit=100` | `AuditEntryDTO[]` (du plus récent au plus ancien ; `actor=bot:<slug>` inclut ses sous-agents `bot:<slug>/<type>`) |
| GET | `/api/audit/export.csv` | `?days=30` | CSV |
| GET | `/api/push/public-key` | — | `PushPublicKeyDTO` |
| POST | `/api/push/subscribe` | `PushSubscriptionJSON` | `{ ok: true }` (idempotent ; audité seulement pour un nouvel appareil) |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | `{ ok: true }` |
| POST | `/api/push/test` | — | `{ delivered: number }` |
| GET | `/api/system/network` | — | `NetworkInfoDTO` : `peerAddress` (le proxy vu par Ant), `clientIp` retenue, `forwardedFor`, `trustProxy`, `trustAll` |

`GET /healthz` (public, hors `/api`, pour le healthcheck du conteneur `web` ou une sonde externe) : `{ ok: true }` si la
base répond à `select 1` en moins de 3 s, sinon `503 { ok: false, error: 'database_unreachable' }`.

`/api/system/network` sert à mettre l'adresse exacte de Nginx Proxy Manager dans `TRUST_PROXY` (README § 7) ; Réglages →
Sécurité l'affiche (« Adresse du proxy vue par Ant »), avec un avertissement quand `TRUST_PROXY=true`.

`PATCH /api/settings` ignore les clés gérées par le serveur (`emergencyStop`, `grantsRevokedAt`, écrites par
l’arrêt d’urgence, § B) ; `onboardingDoneAt` s’y règle (date ISO, ou `null` pour rejouer le premier démarrage).

## Ordinateur

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/computer/status` | — | `ComputerStatusDTO` |
| POST | `/api/computer/control` | `{ holder: 'user' | 'agents' }` | `ComputerStatusDTO` |
| GET | `/api/computer/files` | `?path=` | `FileEntryDTO[]` |
| GET | `/api/computer/files/download` | `?path=` | fichier |
| GET | `/api/computer/activity` | `?limit=50` | `AuditEntryDTO[]` (actions des agents sur l'ordinateur) |
| WS | `/api/computer/vnc` | — | flux RFB binaire (pour noVNC) |
| WS | `/api/computer/terminal` | — | terminal partagé : messages texte = données ; `{"type":"resize","cols","rows"}` |

Les WebSockets de l'écran et du terminal se ferment avec le code `4401` quand la session prend fin (révoquée, expirée,
déconnexion) ; l'interface vérifie alors `/api/auth/state`, affiche « Session expirée » et revient à la connexion au lieu
de se reconnecter en boucle. Le téléchargement est relayé en flux : le délai de 120 s ne porte que sur l'attente des
en-têtes de l'ordinateur, pas sur la durée du transfert.

## Temps réel

`WS /api/ws` : le serveur envoie des `ServerEvent` en JSON (un par message). Le client envoie des `ClientEvent` :
`{"type":"ping"}` (réponse `{"type":"pong"}`) et la présence `{"type":"focus","channelId":<uuid|null>,"visible":<bool>}`
(§ A). Un message invalide est ignoré. Reconnexion à la charge du client (backoff exponentiel).

- Le client envoie un ping toutes les 25 s et abandonne une socket dont le pong n'arrive pas dans les 10 s (4 s après un
  réveil : onglet de nouveau visible, réseau revenu), puis se reconnecte et rafraîchit ce qui est affiché.
- Code de fermeture `4401` : session révoquée ou expirée. Le client vérifie `/api/auth/state` et ne revient à l'écran
  de connexion que si le serveur confirme (`authenticated: false`).
- `message.delta` porte `offset` : position du morceau dans le texte du message (unités UTF-16, comme `String.length`).
  Le client applique les morceaux de façon idempotente et recharge le message s'il manque un passage. Un morceau trop
  gros pour un NOTIFY PostgreSQL (8 000 octets) est découpé, chaque partie avec sa propre position.

---

# Évolutions : contrat des équipes A à D

Ce qui suit est le contrat que chaque équipe implémente, dans ses propres fichiers (carte des fichiers :
[ARCHITECTURE § 19](ARCHITECTURE.md#19-évolutions)). Le schéma (migration `0003_features`), les types partagés
(`packages/shared/src/api.ts`, `settings.ts`, et les modules `tracking.ts`, `ops.ts`, `inputs.ts`, `capabilities.ts`)
et les points d’extension existent déjà : aucune équipe ne les modifie.

## Conventions communes

- Routes sous `/api/`, déclarées dans le module web de l’équipe (`apps/server/src/web/modules/<module>.ts`, hook `routes`) :
  session complète, en-tête `X-Requested-With: ant` pour toute modification, corps validés par Zod (`400 invalid_request`).
- Erreurs : `ApiErrorBody` avec un `message` en français affichable tel quel. Codes communs : `400 invalid_request`
  (corps invalide), `404 not_found`, `400 unknown_bot` (bot inconnu ou archivé), `400 invalid_channel` (canal inconnu,
  archivé, ou où le bot ne peut pas écrire), `400 invalid_date`.
- Une conversation cible suit la règle des routines : `channelId: null` (ou absent) = la conversation privée du bot ; un
  canal de groupe doit compter le bot parmi ses membres.
- Toute action du propriétaire qui modifie quelque chose est auditée (`actor: 'owner'`, `ip`), toute action d’un bot aussi
  (`actor: 'bot:<slug>'`, `runId`) : liste des événements ci-dessous.
- Après une écriture, publier l’événement temps réel indiqué (`publish()` de `lib/events.ts`). Un événement de plus de
  7 900 octets est abandonné par `publish()` (limite de NOTIFY) : un événement qui porterait un objet de taille libre ne
  porte que son identifiant, l’interface recharge l’objet.
- Clés de déduplication des tâches de fond : `jobs.dedupe_key` est unique sur toutes les tâches, terminées comprises,
  jusqu’à leur purge (7 jours après leur création). Une clé doit donc contenir ce qui distingue deux demandes légitimes
  (créneau, minute, date prévue) : sinon la seconde est ignorée sans erreur pendant une semaine.
- Origine d’une exécution : `effectiveTrigger(run)` (`services/runs.ts`), jamais `run.trigger` seul. Une tâche qui
  atteint la limite d’étapes continue dans une exécution déclencheur `system` ; son déclencheur d’origine est dans
  `payload.continuedTrigger`, et le début de la tâche entière dans `payload.chainStartedAt` (`chainStartedAt(run)`).
- Destinataires d’un message du propriétaire : `resolveMessageTargets(ctx, message)` (`services/runs.ts`), la règle
  qu’applique `dispatchUserMessage` (conversation privée → son bot ; groupe → @mentionnés, sinon bots du fil, sinon
  premier membre). Ne pas la recopier.

### Hook `afterRun` (`FinishedRun`)

`afterRun` reçoit **chaque** état final d’une exécution : fin normale, mais aussi exécution annulée en file ou
en pause (propriétaire, arrêt d’urgence, occurrence de routine remplacée), bot en pause ou archivé au démarrage,
conversation archivée, tâche autonome abandonnée faute de calcul, travail en échec définitif, exécution orpheline. Ces
dernières n’ont pas de réponse (`finalText` vide, `error` renseigné). Le passage est noté (`payload.afterRunAt`) ; un
redémarrage au mauvais moment peut toutefois le rejouer : un hook reste idempotent (réclamation atomique, `tag` de
notification). Champs :

- `status` (`done` | `error` | `cancelled`), `trigger` (= `effectiveTrigger(run)`), `continued` (limite d’étapes atteinte,
  une suite automatique prend le relais : la tâche n’est pas finie) ;
- `finalText`, `error`, `responseMessageId` (réponse publiée par le runner, `null` sinon), `attachments` (fichiers joints
  par le bot, `rc.outputs.attachments`) ;
- `silent` : le runner n’a publié aucune réponse (heartbeat, ou `silentRun` d’un module) ; le module qui a rendu
  l’exécution silencieuse publie lui-même la réponse (§ D, « Exécutions silencieuses »), les autres ne l’annoncent pas ;
- `startedAt` / `durationMs` : depuis le premier démarrage de la tâche entière (suites automatiques comprises).

## A — Suivi et notifications (module `tracking`)

### Lu / non-lu partagé

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| POST | `/api/channels/:id/read` | `ChannelReadInput` `{ at? }` | `ChannelReadDTO` `{ channelId, lastReadAt }` |

- `at` (ISO) vaut maintenant par défaut et est ramené à maintenant s’il est dans le futur. La marque n’avance que :
  `last_read_at = greatest(ancienne, at)`. Table `channel_reads` (une ligne par canal).
- Publie `{ type: 'channel.read', channelId, lastReadAt }` (les autres appareils mettent leurs pastilles à jour).
- Erreurs : `404 not_found` (canal inconnu ou archivé), `400 invalid_date`. Non audité.
- `GET /api/channels` renvoie déjà `lastReadAt` (`null` si jamais marqué).

### Présence (WebSocket)

- Le navigateur envoie `{ type: 'focus', channelId, visible }` à chaque changement (conversation ouverte, onglet visible ou
  caché) et toutes les `PRESENCE_REFRESH_MS` (30 s) tant que la page est visible, puis de nouveau après chaque reconnexion
  (`realtime.send()` renvoie `false` quand la socket n’est pas ouverte).
- Le module web l’enregistre dans `owner_presence` (une ligne par connexion, clé `RealtimeConnection.id`) au plus une fois
  toutes les 15 s par connexion sauf changement, et supprime la ligne à la fermeture (`onConnectionClose`).
- « Le propriétaire regarde le canal X » = il existe une ligne `visible = true`, `channel_id = X`, mise à jour depuis
  moins de `PRESENCE_TTL_MS` (60 s). La maintenance horaire supprime les lignes de plus d’une heure.

### Push de fin de travail

Hook `afterRun` du module worker. Un push part quand toutes ces conditions sont vraies :

1. `status` vaut `done` ou `error` (jamais `cancelled`), et `continued` est faux (une suite automatique n’est pas une fin) ;
2. `finished.trigger` (le déclencheur d’origine, `effectiveTrigger(run)` : la dernière exécution d’une longue tâche est
   une suite automatique dont `run.trigger` vaut `system`) est `user`, `mention`, `handoff`, `approval`, `routine` ou
   `followup` (jamais `heartbeat`, `digest`, `system`, `watch`, `draft`) ;
3. mode effectif = `routine.completionPush ?? bot.completionPush ?? settings.completionPush` (`routineId` : celui du
   `payload`, conservé par les suites) : `never` → rien ; `long` → seulement si `durationMs ≥ completionPushMinSeconds ×
   1000` (`durationMs` couvre toute la tâche, suites comprises) ; `always` → toujours ;
4. pas d’exécution silencieuse sans rien à dire : `silent` et `isSilentNothing(finalText)` (`@ant/shared`) → rien, aucun
   message ne sera publié (routine « silencieuse si rien ») ;
5. le propriétaire ne regarde pas ce canal (présence ci-dessus).

Contenu : titre « <bot> a terminé » (« <bot> : échec » en cas d’erreur), corps = 160 premiers caractères de la réponse
(Markdown retiré), ou de `error` sans réponse (travail en échec, exécution orpheline), `url` = `/c/<channelId>` ou
`/c/<channelId>/t/<threadRootId>`, `tag` = `run-<channelId>` (les notifications d’une même conversation se remplacent :
un état final vu deux fois après un redémarrage ne donne qu’une notification). Envoi par `notifyOwner()` (respecte les
heures de silence). Non audité.

### Tâches du propriétaire et vue « Suivi »

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/tasks` | `?botId=&status=open,waiting&assignee=bot|owner` | `TaskDTO[]` |
| POST | `/api/tasks` | `TaskCreateInput` | `TaskDTO` |
| PATCH | `/api/tasks/:id` | `TaskPatchInput` | `TaskDTO` |
| DELETE | `/api/tasks/:id` | — | `{ ok: true }` |

- `assignee: 'owner'` : chose à faire par le propriétaire, suivie par `botId`. `PATCH { botId }` réassigne (`400 unknown_bot`).
- `sourceMessageId` (POST) : message d’origine (« Créer une tâche » depuis le menu d’un message).
- Échéance : une tâche ouverte avec `dueAt` possède exactement un suivi (`followups.task_id`) à `dueAt` : `reminder` si
  `assignee = 'owner'`, `work` si `assignee = 'bot'`, consigne « Échéance : <titre> ». Changer `dueAt` le déplace ; `dueAt: null`,
  `status: done|dropped` ou la suppression de la tâche l’annulent. Même règle pour les outils `task_create` / `task_update`.
- Audit : `task.create`, `task.update`, `task.delete` (propriétaire et bots). Publie `tasks.updated` (+ `followups.updated`
  si le suivi lié change).
- `POST /api/memory` accepte `sourceMessageId` (« Mémoriser » depuis un message).
- La vue `/suivi` regroupe : En retard, Aujourd’hui, Cette semaine, En attente de toi (`assignee = owner`), Sans échéance,
  plus les suivis à venir (`GET /api/followups`).

### Suivis et rappels

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/followups` | `?status=pending|fired|cancelled|failed&botId=&channelId=&taskId=&limit=100` | `FollowupDTO[]` |
| POST | `/api/followups` | `FollowupInput` | `FollowupDTO` |
| PATCH | `/api/followups/:id` | `FollowupPatchInput` `{ runAt?, instruction? }` | `FollowupDTO` |
| DELETE | `/api/followups/:id` | — | `{ ok: true }` (annule) |

- `GET` : `status` vaut `pending` par défaut ; tri par `runAt` croissant (`pending`) ou `firedAt` décroissant (autres).
- `POST` (propriétaire, `createdBy: 'owner'`) : `runAt` dans le futur et au plus `FOLLOWUP_LIMITS.maxDelayDays` jours ;
  `instruction` 1 à 2000 caractères ; `kind: 'work'` exige `botId` (`400 bot_required`) ; sans `botId`, un `reminder` est un
  rappel du propriétaire à lui-même (push, et message système dans `channelId` s’il est donné) ; `taskId` inconnu →
  `400 unknown_task`.
- `PATCH` / `DELETE` : seulement un suivi `pending` (`409 not_pending`, « Ce suivi n’est plus en attente. »).
- Déclenchement (planificateur du module, chaque passage de 30 s, rien pendant l’arrêt d’urgence) : chaque suivi dû met en
  file un job `followup.fire` `{ followupId }` (clé de déduplication `followup:<id>:<runAt en ms>` : un suivi déplacé
  après son déclenchement, par exemple l’échéance d’une tâche, repart à sa nouvelle date). Le job réclame la ligne
  (`pending` → `fired`, atomique), puis :
  - `reminder` : message `authorKind: 'system'`, `botId`, `meta: { kind: 'reminder', followupId }` dans la conversation
    (aucun appel au modèle), et `notifyOwner` (titre « Rappel de <bot> » ou « Rappel », `url` vers la conversation ou
    `/suivi`, `tag` `followup-<id>`) ;
  - `work` : `requestRun` déclencheur `followup`, priorité `background`, origine `autonomous` (`user` s’il a été créé par
    le propriétaire), même canal et fil, `payload: { followupId }`, `chainId` du suivi ; `runId` est enregistré. Bot en
    pause ou archivé → `status: 'failed'`, `error` en français.
- Publie `followups.updated` à chaque changement. Audit : `followup.create`, `followup.update`, `followup.cancel`,
  `followup.fire` (`actor: 'system'`).

### Outils des bots (A)

| Outil | Paramètres | Règles |
|---|---|---|
| `notify_owner` | `title` (≤ 80), `body` (≤ 500), `urgent?` | Push + toast. Au plus `settings.notifyOwnerDailyLimit` par bot et par jour local (compté sur l’audit `notify_owner`) ; heures de silence respectées sauf `urgent` avec `urgentPushDuringQuietHours`. Audit `notify_owner`. |
| `followup_schedule` | `at?` (ISO) ou `in_minutes?` (entier), `instruction` (≤ 2000), `mode: 'rappel' \| 'travail'` | Crée un suivi (`reminder` / `work`) dans la conversation et le fil de l’exécution. Délai entre `FOLLOWUP_LIMITS.minDelayMinutes` et `maxDelayDays` ; au plus `maxPendingPerBot` en attente par bot ; `depth` = profondeur du suivi qui a déclenché l’exécution + 1 (0 sinon), refus au-delà de `maxChainDepth` sans message du propriétaire. Audit `followup.create`. |
| `followup_list` | — | Suivis en attente du bot. |
| `followup_cancel` | `id` | Seulement les siens, en attente. Audit `followup.cancel`. |
| `task_create` | + `for_owner?: boolean` | `assignee: 'owner'` ; `due` crée le suivi d’échéance. |

Le module donne aussi `describeTrigger` / `buildPrompt` pour le déclencheur `followup` (« Rappel que tu t’es programmé le … :
<consigne> »), et une section du prompt système (quand utiliser `followup_schedule` : commande longue, réponse externe attendue).

Le résumé quotidien (`worker/digest.ts`) sépare « à faire pour toi » (`assignee = owner`) et « en cours chez les bots », et
liste les rappels du jour.

## B — Santé, arrêt d’urgence, coûts, premier démarrage (module `ops`)

### Santé

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/system/health` | — | `SystemHealthDTO` |
| GET | `/api/system/jobs` | `?status=failed&kind=&limit=50` | `JobDTO[]` (du plus récent au plus ancien, `limit` ≤ 200) |
| POST | `/api/system/jobs/:id/retry` | — | `JobDTO` |

- Niveaux (`HealthLevel`) :
  - worker : `ok` si vu depuis moins de `WORKER_ALIVE_MS`, `error` sinon, `unknown` sans ligne `service_status` ;
  - ordinateur : `error` si configuré mais injoignable, `unknown` s’il n’est pas configuré ;
  - base : taille (`pg_database_size`) et les 5 plus grosses tables, toujours `ok` ;
  - jobs : par type, en attente, en cours, plus ancien dû (`run_at ≤ now`) et échecs sur 24 h ; `warning` dès un échec
    sur 24 h ou un job dû depuis plus de 5 min, `error` au-delà de 30 min ;
  - sauvegarde : `ok` si `lastSuccessAt` a moins de `BACKUP_STALE_HOURS`, `warning` sinon, `error` si `lastError` est
    plus récent que `lastSuccessAt`, `unknown` sans ligne ;
  - push : `warning` sans clés VAPID ou sans abonnement ;
  - jeton d’abonnement : `warning` à 30 jours ou moins, `error` à 7 jours ou moins (ou expiré), `unknown` si la date n’est
    pas renseignée alors que l’abonnement est configuré.
- `retry` : seulement un job `failed` (`409 not_failed`) ; remet `status: 'pending'`, `attempts: 0`, `run_at: now`,
  `last_error: null`, `finished_at: null`. Refusé pour `bot.run` et `approval.execute` (`400 not_retryable`, « Relance
  plutôt la demande dans la conversation. » / « Une action validée n’est jamais rejouée. »). Audit `job.retry`.
- Liveness : le worker écrit déjà `service_status` (`worker`, détail `WorkerStatusDetail`) au démarrage et toutes les 30 s.
  La sauvegarde (`deploy/backup.sh`) écrit la ligne `backup` après chaque tentative :
  ```sql
  insert into service_status (key, seen_at, version, detail, updated_at)
  values ('backup', now(), null, '{"lastAttemptAt":"…","lastSuccessAt":"…","lastError":null,"file":"…","sizeBytes":123}', now())
  on conflict (key) do update set seen_at = excluded.seen_at, detail = excluded.detail, updated_at = now();
  ```
- Surveillance du worker (module web, `onStart`, toutes les 60 s) : quand la ligne `worker` a plus de
  `WORKER_DOWN_ALERT_MS`, une seule fois par incident (`budget_alerts` scope `worker_down`, `period_key` = `seen_at` ISO) :
  push « Le worker ne répond plus depuis X min », `health.updated`, audit `worker.down` ; au retour : `health.updated`,
  audit `worker.recovered`. Les minuteries s’arrêtent avec l’application (fonction renvoyée par `onStart`).
- Healthchecks des conteneurs (`docker-compose.yml`) : `web` interroge déjà `/healthz`, qui vérifie la base (socle) ;
  le module worker `ops` touche `/tmp/alive` (tmpfs) à chaque `onSchedulerTick`, et le healthcheck du `worker` vérifie
  que ce fichier a moins de 90 s ; celui de `computer` appelle `GET /health` de sa RPC.
- Écran `/sante` (rail et Réglages). La bannière globale « Le worker ne répond pas » existe déjà (`PausedBanner`, d’après
  `QuotaStatusDTO.worker`) : l'équipe B peut y ajouter un lien vers `/sante`, sans en créer une seconde.

### Arrêt d’urgence « Tout arrêter »

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| POST | `/api/system/emergency-stop` | `EmergencyStopInput` `{ reason? }` (≤ 500) | `{ state: EmergencyStopState }` |
| POST | `/api/system/emergency-resume` | — | `EmergencyResumeDTO` `{ resumedBotIds }` |
| GET | `/api/approvals/grants` | — | `ApprovalDTO[]` (autorisations de domaine actives) |
| POST | `/api/approvals/:id/revoke` | — | `ApprovalDTO` |

- `emergency-stop` (`409 already_stopped`) : met en pause chaque bot actif non déjà en pause (liste mémorisée dans
  `pausedBotIds`) ; annule chaque exécution `queued`, `running`, `paused` ou `waiting_approval` (`cancelRun`) ; prend la main
  sur l’ordinateur (`setComputerHolder('user')`) ; refuse chaque validation en attente avec le commentaire « Arrêt d’urgence »
  (sans relancer de bot) ; pose `grantsRevokedAt = now` ; enregistre `settings.emergencyStop` (`updateSettings`, clé gérée
  par le serveur). Publie `emergency.updated` (avec l’état) et `bot.updated`. Audit `emergency.stop`.
- Tant que `settings.emergencyStop` est posé : le planificateur ne lance ni heartbeat, ni routine, ni résumé (déjà en place),
  et chaque module ne lance rien de nouveau dans `onSchedulerTick` (suivis, veilles, rappels de brouillons).
- `emergency-resume` (`409 not_stopped`) : réactive seulement les bots de `pausedBotIds` encore en pause et non archivés,
  rend l’ordinateur aux agents, `emergencyStop: null`. Les exécutions annulées ne sont pas relancées. Publie
  `emergency.updated` (`state: null`). Audit `emergency.resume`.
- Autorisation de domaine active = validation `tool: 'request_approval'`, `status: 'executed'`, `decidedAt` depuis moins de
  30 min, `revokedAt` nul et `decidedAt > settings.grantsRevokedAt`. `hasActiveGrant()` (`worker/approval-flow.ts`)
  applique la même règle.
- `revoke` : `404`, `409 not_a_grant` (pas une autorisation de domaine exécutée), `409 already_revoked` ; pose `revoked_at`,
  publie `approval.updated`. Audit `approval.revoked`.
- UI : bouton rouge (slot `railActions` et `mobileMenuActions`) avec confirmation, bannière persistante « Ant est arrêté —
  Reprendre » (slot `banners`), liste « Autorisations actives » dans Validations.
- Mettre **un** bot en pause (`PATCH /api/bots/:id { paused: true }`, `web/routes/bots.ts`) annule aussi ses exécutions
  actives (`queued`, `running`, `paused` : `cancelRun`). Ses validations en attente restent : l’écran
  Validations propose, pour chaque bot en pause qui en a, « Refuser les N validations de <bot> » (même refus que
  `POST /api/approvals/:id/decide`, commentaire « Bot mis en pause »).

### Coût par origine

| Méthode | Route | Query | Réponse |
|---|---|---|---|
| GET | `/api/quota/usage/origins` | `?days=30` (1 à 365) | `UsageOriginsDTO` |
| GET | `/api/quota/top-runs` | `?days=7&limit=10` (1 à 90 ; 1 à 50) | `RunDTO[]` (par coût décroissant) |

- `run_model_usage.purpose` est déjà rempli : déclencheur de l’exécution (`continuedTrigger` pour une suite automatique),
  ou `OneShotRequest.purpose` (`heartbeat_triage`, `digest`, `rotate`, `routine_parse`, puis `web_extract`, `diagnostic`).
  `routine_id` : routine de l’exécution (ou de la session résumée). Les anciennes lignes sans exécution restent `null`
  (« non classé »).
- `byRoutine` : au plus 10 routines, les plus coûteuses d’abord (routines supprimées exclues).
- `top-runs` trie sur `runs.cost_usd`, qui comprend déjà les appels ponctuels faits pour l’exécution (`oneShot` avec
  `runId`, ex. `web_extract`).
- Alerte de projection (`worker/alerts.ts`) : un push par mois quand `forecastMonthUsd > apiMonthlyCapUsd`
  (`budget_alerts` scope `api_month_forecast`, seuil 100), en nommant l’origine principale du mois. La projection compte
  au moins 3 jours écoulés : pas d’alerte sur la seule première heure du mois. L’écran Quota l’affiche avec la mention
  « projection » et, avant le 4ᵉ jour du mois, « estimation prudente en début de mois ».
- `settings.perRunSubscriptionCapUsd` (défaut 5 $, 0 = désactivé) est déjà passé en `maxBudgetUsd` aux exécutions sur
  l’abonnement ; l’écran Quota l’expose sous le nom « Plafond par exécution sur l’abonnement » (repris tel quel par le
  message d’erreur de l’exécution arrêtée).

### Premier démarrage

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| POST | `/api/system/diagnostic` | — | `DiagnosticDTO` (`status: 'pending'`) |
| GET | `/api/system/diagnostic` | — | `DiagnosticDTO` (`status: 'idle'` si jamais lancé) |
| POST | `/api/bots/batch` | `BotBatchInput` | `BotBatchDTO` |

- `diagnostic` (`409 diagnostic_running` si un job `diagnostic` est en attente ou en cours) : met en file le job
  `diagnostic` (`maxAttempts: 1`) et écrit la ligne `service_status` `diagnostic` (`DiagnosticDTO`). Le job lance, pour
  chaque source configurée, un `oneShot` Haiku d’un tour forcé sur cette source (option `forceSource` à ajouter dans
  `worker/oneshot.ts`, `purpose: 'diagnostic'`), puis écrit le résultat et publie `health.updated`. Jamais automatique
  (≈ 0,001 $ par source). Audit `diagnostic`.
- `bots/batch` : 1 à 10 bots, chacun validé par `botInputSchema` (`web/routes/bots.ts`) avant toute création ; créés avec
  `createBot` ; `groupChannel` crée un canal de groupe avec tous ces bots. Audit `bot.create` par bot (+ `channel.create`).
- Les modèles d’équipe vivent dans `packages/shared/src/ops.ts` (`BOT_TEMPLATES`, permissions minimales par rôle).
- `/bienvenue` (slot `bareRoutes`) s’affiche tant que `settings.onboardingDoneAt` est `null` (redirection par un
  composant du slot `effects`) ; la migration l’a déjà posé pour les installations qui ont des bots. La fin du guide envoie
  `PATCH /api/settings { onboardingDoneAt: <maintenant> }`.

## C — Pièces jointes, partage, « Approfondir » (module `inputs`)

### Ordinateur (RPC interne, `apps/computer`)

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| POST | `/files/upload` | `?path=<chemin absolu sous /workspace>`, corps brut, `Content-Length` obligatoire | `{ path, size }` |
| GET | `/files/download` | `?path=&inline=1` | fichier |

- `upload` : `ATTACHMENT_MAX_BYTES` au plus (`413 payload_too_large`), crée les dossiers, refuse d’écraser (`409 exists`),
  chemin confiné à /workspace (`400`). Client : `ComputerClient.upload(path, body, size)`.
- `download?inline=1` : seulement pour les types de `INLINE_MIME_TYPES` (déduits de l’extension) : `content-type` réel,
  `content-disposition: inline`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`
  (à vérifier avec l’aperçu PDF de Chromium ; sans `sandbox` pour le PDF si nécessaire, jamais pour un autre type). Tout
  autre fichier reste en `application/octet-stream` + `attachment`.

### Web

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| POST | `/api/channels/:id/attachments` | corps brut ; en-têtes `Content-Type`, `X-File-Name` (nom encodé par `encodeURIComponent`) | `MessageAttachment` |
| POST | `/api/channels/:id/messages` | `PostMessageInput` (+ `attachments?`, `depth?`) | `{ message, runs }` |
| GET | `/api/computer/files/download` | `?path=&inline=1` | fichier (aperçu) |

- Envoi : limite de corps propre à la route (`ATTACHMENT_MAX_BYTES`, le reste de l’API garde 2 Mo) ; nom nettoyé (pas de
  `/`, 1 à 200 caractères, `400 invalid_name`) ; stocké sous `INBOX_DIR/<AAAA-MM-JJ local>/<uuid>-<nom>` ; `mime` déduit de
  l’extension. Erreurs : `404 not_found` (canal), `413 too_large` (« 25 Mo maximum »), `503 computer_disabled`,
  `502 computer_error`. Audit `attachment.upload`.
- Message : `attachments` = chemins renvoyés par l’envoi (au plus `ATTACHMENTS_PER_MESSAGE`, tous sous `INBOX_DIR`, existants :
  `400 invalid_attachment`) ; le serveur construit `meta.attachments` (`name` sans le préfixe uuid, `mime`, `size`) ;
  `content` peut être vide quand il y a au moins une pièce jointe.
- `depth` : modèle ponctuel `RUN_DEPTH_MODELS[depth]` passé à `dispatchUserMessage(ctx, message, { model, effort,
  payload: { depth } })` (déjà en place) ; le modèle par défaut du bot ne change pas. `expert` exige
  `permissions.expertSubagent` de chaque bot ciblé (`resolveMessageTargets`, la règle même de `dispatchUserMessage` ;
  `403 expert_not_allowed`) et compte dans `expertDailyLimit` (audit
  `subagent.start` avec `tier: 'expert'` et `day`, comme les sous-agents ; `429 expert_limit` au-delà).
- Aperçu `inline=1` : non audité (les téléchargements le restent, `computer.download`).

### Worker

- Hook `userMessage` : quand le message déclencheur porte des images (`png`, `jpeg`, `webp`, `gif`, au plus 5, 5 Mo chacune)
  ou des PDF (10 Mo), le prompt devient des `SDKUserMessage` avec des blocs `image` / `document` (lus par
  `ComputerClient.download`) ; les autres fichiers sont cités par leur chemin.
- Outils : `file_view(path)` (image de /workspace → `okWithImage(texte, base64, mime)`), `attach_file(path, caption?)`
  (ajoute à `rc.outputs.attachments`, écrit dans `meta.attachments` de la réponse finale par le runner, au plus
  `ATTACHMENTS_PER_MESSAGE`), `post_message` accepte `attach?: string[]`.

### Partage vers Ant

- Manifeste (`vite.config.ts`) : `share_target` `{ action: '/share', method: 'GET', params: { title, text, url } }` ; la
  variante `POST` multipart (fichiers) est interceptée par `sw.ts`, qui range les fichiers dans Cache Storage (`ant-share`) et
  redirige vers `/share?files=<n>`.
- Écran `/share` (slot `routes`) : choix du destinataire, texte prérempli modifiable, raccourcis « En faire une tâche »,
  « Rappel » (`POST /api/followups`), « Brouillon X » (message au bot), envoi par les routes ci-dessus. Sans session,
  `/login?next=` conserve les paramètres. Bookmarklet et raccourci iPhone (Safari n’a pas de Web Share Target) décrits dans
  une section des Réglages (slot `settingsSections`).

## D — Transferts avec retour, lecture web, brouillons X, veilles (module `capabilities`)

### Transfert avec retour

- `handoff` gagne `attendre_resultat?: boolean` (défaut `true`) : le run cible porte `payload.reportTo = { runId, botId }`
  (run délégant). Les @mentions n’attendent pas de retour.
- Hook `afterRun` (qui voit aussi les délégués annulés avant de démarrer, en échec ou orphelins, § « Hook afterRun ») :
  quand un run portant `reportTo` se termine (et que `continued` est faux) et qu’aucun autre run du même
  `reportTo.runId` n’est encore `queued`, `running`, `paused` ou `waiting_approval`, réclamer le retour de façon atomique
  (`update runs set payload = payload || '{"handoffReturnRequested":true}' where id = <reportTo.runId> and not
  (payload ? 'handoffReturnRequested') returning id`), puis `requestRun` pour `reportTo.botId` : même canal et fil,
  déclencheur `handoff`, priorité `normal`, origine du run délégant, même `chainId`, `hop` = plus grand `hop` des délégués + 1,
  `payload: { handoffReturn: true, returnOf: <runId> }`, prompt = statut et réponse finale de chaque délégué
  (`HANDOFF_REPORT_MAX_CHARS` chacune). Une suite automatique hérite déjà de `reportTo`.
- Garde-fou : le retour compte comme un saut (`maxHandoffHops`) mais n’est pas une arête de ping-pong (aucune ligne
  `handoffs`) ; `loop-guard.ts` reste la seule règle. Audit `handoff.return`.

### Lecture web économique

- Outil `web_extract({ url, question })` (permission `browser`) : `goto` + `read` du navigateur, puis `oneShot`
  `TRIAGE_MODEL` (schéma `{ reponse, extraits ≤ 8, liens ≤ 10 }`, page présentée comme donnée non fiable) avec
  `runId: rc.run.id` (le coût s’ajoute à celui du run : `RunDTO.costUsd`, coût de la réponse), `routineId:
  rc.run.payload.routineId`, `purpose: 'web_extract'`, origine et priorité du run ; renvoie au plus
  `WEB_EXTRACT_MAX_CHARS`.
  Donné aussi au sous-agent léger (`lightSubagentTools`).
- `browser` `read` gagne `max_chars` (défaut 12 000) et `offset`, avec l’indication « suite : offset=… ».

### Brouillons X

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/drafts` | `?status=<liste>&botId=&from=&to=&limit=100` | `DraftDTO[]` |
| GET | `/api/drafts/:id` | — | `DraftDTO` |
| PATCH | `/api/drafts/:id` | `DraftPatchInput` | `DraftDTO` |
| POST | `/api/drafts/:id/decide` | `DraftDecisionInput` | `DraftDTO` |
| POST | `/api/drafts/:id/published` | `DraftPublishedInput` | `DraftDTO` |
| DELETE | `/api/drafts/:id` | — | `{ ok: true }` |

- `GET` : planifiés d’abord (par `scheduledAt`), puis par `createdAt` décroissant.
- Longueur : chaque partie compte au plus `X_MAX_WEIGHTED_LENGTH` caractères pondérés (URL = `X_URL_WEIGHT`) :
  `400 too_long` avec `details: { part, length }` ; `post` et `reply` = 1 partie, `thread` = 2 à 25 (`400 invalid_parts`).
- `PATCH` : seulement `draft`, `approved` ou `scheduled` (`409 not_editable`).
- `decide` : `approve` → `approved` ; `schedule` → `scheduled` avec `scheduledAt` futur (`400 invalid_date`),
  `notified_at` remis à `null` ; `reject` → `rejected`, `ownerFeedback` = commentaire. `409 already_decided` si publié ou
  refusé. Un refus, ou une validation d’un brouillon dont le propriétaire a modifié le texte, lance un run du bot
  (déclencheur `draft`, priorité `normal`, origine `user`, `payload: { draftId }`) avec l’avant/après et le commentaire.
  Audit `draft.decide`.
- `published` : depuis `draft`, `approved` ou `scheduled` ; `url` facultative, `https://x.com/…` ou `https://twitter.com/…`
  (`400 invalid_url`) ; `status: 'published'`, `publishedAt`. Audit `draft.published`. `DELETE` : audit `draft.delete`.
- Publie `{ type: 'draft.updated', draftId }` à chaque changement (l’identifiant seul : un fil de 25 parties dépasse ce
  que porte un NOTIFY) ; l’interface recharge le brouillon (`GET /api/drafts/:id`) et la liste.
- Rappel de publication (`onSchedulerTick`) : brouillon `scheduled` dont `scheduledAt` est passé et `notified_at` nul →
  `notifyOwner` « À publier maintenant » (`url` `/contenus?draft=<id>`, `tag` `draft-<id>`), puis `notified_at`.
- Outils : `draft_create({ kind, parts, reply_to_url?, media_paths?, notes? })` crée le brouillon et sa carte
  (message `authorKind: 'system'`, `botId`, `meta: { kind: 'draft', draftId }`) ; `draft_update` (ses brouillons à l’état
  `draft`) ; `draft_list`. Audit `draft.create`, `draft.update`. Section du prompt système : ne jamais publier sur X par le
  navigateur, préparer un brouillon.
- UI : écran `/contenus` (liste par jour), carte sous le message (slot `messageExtras`), compteur par partie, « Ouvrir dans
  X » = `X_INTENT_URL?text=<partie>` (`&in_reply_to=<id du post>` pour une réponse), « Marquer publié ».

### Veilles

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/watches` | `?botId=` | `WatchDTO[]` |
| POST | `/api/watches` | `WatchInput` | `WatchDTO` |
| PATCH | `/api/watches/:id` | `Partial<Omit<WatchInput, 'botId'>>` | `WatchDTO` |
| DELETE | `/api/watches/:id` | — | `{ ok: true }` |
| POST | `/api/watches/:id/check` | — | `{ ok: true }` (vérification mise en file) |

- URL `http(s)` seulement (`400 invalid_url`) ; `intervalMin` ≥ `WATCH_LIMITS.minIntervalMin` (`400 too_frequent`) ;
  au plus `WATCH_LIMITS.maxPerBot` par bot (`409 too_many`) ; activer une veille proposée lève `proposed`. Audit
  `watch.create`, `watch.update`, `watch.delete`. Publie `watches.updated`.
- Vérification : `onSchedulerTick` met en file `watch.check` `{ watchId }` pour chaque veille active due (`next_check_at ≤ now`,
  clé `watch:<id>:<next_check_at en ms>`) ; `check` met en file `{ watchId, manual: true }` (clé
  `watch:<id>:manual:<minute en cours, en ms ÷ 60 000>` : un clic par minute au plus, jamais un bouton mort). Le job récupère
  le contenu dans l’ordinateur par `curl -sL --max-time 30` (`computer.exec`, URL correctement échappée), normalise
  (sélecteur, espaces, jetons dynamiques), hache. Seul `render: 'http'` existe dans ce tour (`WATCH_RENDERS`) : la page
  Chromium de l’ordinateur est unique et partagée avec les bots et le propriétaire, une vérification de fond la ferait
  quitter sous leurs pieds (formulaire en cours, page d’une validation en attente) ; le rendu par navigateur viendra
  avec un contexte de navigation isolé dans la RPC de l’ordinateur. Première vérification : référence seule. Inchangé :
  `last_checked_at`, `next_check_at`. Changé : `last_snapshot` (`maxSnapshotBytes`), `last_diff` (`maxDiffBytes` ; nouveaux
  éléments pour un RSS), `last_changed_at`, puis `requestRun` déclencheur `watch`, priorité `background`, origine
  `autonomous`, `threadKey` `watch:<id>` (session propre, résumée d’après ses exécutions à la rotation), `payload:
  { watchId }`, prompt = consigne + diff. Erreur : `last_error`, nouvel essai à l’intervalle suivant. Audit `watch.change`.
- Rien ne part pendant l’arrêt d’urgence ni quand le propriétaire a la main sur l’ordinateur (`holder === 'user'`) : le job
  repousse alors `next_check_at` à l’intervalle suivant, sans erreur. « Vérifier maintenant » répond dans ces cas
  `409 emergency_stop` (« Ant est arrêté : reprends d’abord. ») ou `409 owner_has_control` (« Tu as la main sur
  l’ordinateur : rends-la aux agents d’abord. »).
- Exécutions silencieuses : `silentRun` vrai pour un run `watch` (ou `payload.watchId`) et pour une routine
  `silentIfNothing`. Le runner ne publie alors rien ; le `afterRun` du module (`finished.silent`) fait ce que le runner
  aurait fait :
  - `done` avec une réponse et `!isSilentNothing(finalText)` (`@ant/shared` : « RIEN », casse, espaces, ponctuation et
    Markdown ignorés) : message du bot avec `runId` (colonne) et `meta.runId`, `meta.kind` `watch` ou `routine` (avec
    `watchId` / `routineId`), `meta.attachments` = `finished.attachments`, coût et modèle comme une réponse ordinaire ;
    puis `updateRun(responseMessageId)`. Sans cela, la session verrait sa propre réponse comme « nouvelle » au passage
    suivant, et la rotation résumerait « aucune réponse publiée ».
  - `done` vide ou `RIEN` : rien n’est publié ;
  - `error` : message `⚠️ <error>` du bot (`status: 'error'`, mêmes `runId` et `meta`), pour qu’un échec ne passe pas
    inaperçu ; `cancelled` : rien.
- Outil `watch_propose({ url, instruction, kind?, selector?, interval_min? })` : veille créée désactivée,
  `proposed: true`, message système dans la conversation. Audit `watch.propose`.
- UI : onglet « Veille » de l’écran Routines (dernier changement, aperçu du diff, « Vérifier maintenant »), réglage
  « Silencieux si rien » et « Notifier à la fin » (`completionPush`) dans l’éditeur de routine.

## Nouveaux événements temps réel

| Événement | Émis par | Effet attendu côté interface |
|---|---|---|
| `{ type: 'channel.read', channelId, lastReadAt }` | A | met à jour `lastReadAt` du canal dans le cache |
| `{ type: 'followups.updated' }` | A | recharge les suivis |
| `{ type: 'emergency.updated', state }` | B | bannière d’arrêt, réglages, bots |
| `{ type: 'health.updated' }` | B | recharge la santé et le quota |
| `{ type: 'draft.updated', draftId }` | D | recharge le brouillon (liste, carte) |
| `{ type: 'watches.updated' }` | D | recharge les veilles |

Le cœur (`lib/ws-dispatch.ts`) ne les traite pas : chaque module les reçoit par son `onEvent`.

## Tâches de fond déclarées

| `JobKind` | Charge utile | Module | Essais |
|---|---|---|---|
| `followup.fire` | `{ followupId }` | A | 2 |
| `diagnostic` | `{}` | B | 1 |
| `watch.check` | `{ watchId, manual? }` | D | 1 |

Un module traite ses types par `jobs` (`WorkerModule`) ; ils sont réclamés avec les tâches auxiliaires (3 à la fois). Un type
imprévu se déclare depuis le fichier du module par augmentation de l’interface `JobKinds` (`lib/jobs.ts`), sans modifier ce
fichier.

## Événements d’audit ajoutés

Libellés déjà présents dans `apps/ui/src/components/audit/labels.ts`.

| Événement | Module | Acteur |
|---|---|---|
| `notify_owner`, `followup.create`, `followup.update`, `followup.cancel`, `followup.fire`, `task.delete` | A | bot, propriétaire ou système |
| `emergency.stop`, `emergency.resume`, `approval.revoked`, `job.retry`, `diagnostic`, `worker.down`, `worker.recovered` | B | propriétaire ou système |
| `attachment.upload` | C | propriétaire |
| `handoff.return`, `draft.create`, `draft.update`, `draft.decide`, `draft.published`, `draft.delete`, `watch.propose`, `watch.create`, `watch.update`, `watch.delete`, `watch.change` | D | bot, propriétaire ou système |

Les appels d’outils (`file_view`, `web_extract`…) restent audités sous l’événement `tool`.
