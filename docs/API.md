# API d'Ant

Toutes les routes sont sous `/api`, en JSON, et **exigent une session complète** (cookie `__Host-ant_session`,
ou `ant_session` en développement HTTP) sauf mention « public ». Les types sont dans `packages/shared/src/api.ts`.

Erreurs : statut HTTP ≥ 400 et corps `ApiErrorBody` `{ error: string, message: string, details? }` (message en français,
affichable tel quel).

Protection CSRF : les requêtes qui modifient (POST/PATCH/PUT/DELETE) doivent envoyer l'en-tête
`X-Requested-With: ant` ; l'en-tête `Origin` est vérifié.

## Authentification

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET (public) | `/api/auth/state` | — | `AuthStateDTO` |
| POST (public) | `/api/auth/setup` | `{ setupToken, password }` | `SetupStartResponse` (session au stade « enroll ») |
| POST (stade enroll) | `/api/auth/setup/totp` | `{ code }` | `RecoveryCodesResponse` (session complète) |
| POST (public) | `/api/auth/login` | `{ password }` | `{ next: 'second_factor' }` (session au stade « mfa ») |
| POST (stade mfa) | `/api/auth/login/second-factor` | `{ code }` ou `{ recoveryCode }` | `{ ok: true }` (session complète) |
| POST (public) | `/api/auth/passkey/login/options` | — | options WebAuthn (`PublicKeyCredentialRequestOptionsJSON`) |
| POST (public) | `/api/auth/passkey/login/verify` | `{ response }` (résultat de `startAuthentication`) | `{ ok: true }` |
| POST | `/api/auth/passkey/register/options` | — | options WebAuthn (`PublicKeyCredentialCreationOptionsJSON`) |
| POST | `/api/auth/passkey/register/verify` | `{ response, name }` | `PasskeyDTO` |
| GET | `/api/auth/passkeys` | — | `PasskeyDTO[]` |
| DELETE | `/api/auth/passkeys/:id` | — | `{ ok: true }` |
| POST | `/api/auth/logout` | — | `{ ok: true }` |
| GET | `/api/auth/sessions` | — | `AuthSessionDTO[]` |
| DELETE | `/api/auth/sessions/:id` | — | `{ ok: true }` |
| POST | `/api/auth/password` | `{ current, next }` | `{ ok: true }` |
| POST | `/api/auth/recovery-codes` | `{ password }` | `RecoveryCodesResponse` |

Limitation : 5 échecs par IP en 15 minutes → `429` avec `message` indiquant le délai.

## Bots

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/bots` | — | `BotDTO[]` |
| POST | `/api/bots` | `BotInput` | `BotDTO` |
| PATCH | `/api/bots/:id` | `Partial<BotInput>` | `BotDTO` |
| DELETE | `/api/bots/:id` | — | `{ ok: true }` (archive) |
| POST | `/api/bots/:id/heartbeat` | — | `{ ok: true }` (lance un heartbeat maintenant) |

## Canaux et messages

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/channels` | — | `ChannelDTO[]` (DM inclus) |
| POST | `/api/channels` | `ChannelInput` | `ChannelDTO` |
| PATCH | `/api/channels/:id` | `Partial<ChannelInput>` | `ChannelDTO` |
| DELETE | `/api/channels/:id` | — | `{ ok: true }` |
| GET | `/api/channels/:id/messages` | `?before=ISO&limit=50` | `MessageDTO[]` (messages de premier niveau, du plus ancien au plus récent) |
| POST | `/api/channels/:id/messages` | `PostMessageInput` | `{ message: MessageDTO, runs: RunDTO[] }` |
| GET | `/api/messages/:id/thread` | — | `{ root: MessageDTO, replies: MessageDTO[] }` |
| GET | `/api/search` | `?q=&channelId=&botId=&from=&to=` | `SearchResultDTO[]` |

Dans un canal de groupe : les bots @mentionnés répondent ; sans mention, les bots déjà présents dans le fil ;
sinon le premier bot du canal.

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
| GET | `/api/tasks` | `?botId=&status=open,waiting` | `TaskDTO[]` |
| POST | `/api/tasks` | `{ botId, title, details?, dueAt? }` | `TaskDTO` |
| PATCH | `/api/tasks/:id` | `{ title?, details?, status?, dueAt? }` | `TaskDTO` |
| DELETE | `/api/tasks/:id` | — | `{ ok: true }` |
| GET | `/api/nudges` | `?botId=&limit=` | `NudgeDTO[]` |
| PATCH | `/api/nudges/:id` | `{ status: 'dismissed' | 'acted' }` | `NudgeDTO` |

## Routines

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/routines` | — | `RoutineDTO[]` |
| POST | `/api/routines/parse` | `RoutineParseInput` | `RoutineDraftDTO` (interprétation du langage naturel par Haiku, ≤ 60 s) |
| POST | `/api/routines/preview` | `{ cron, timezone? }` | `{ description, nextRuns }` |
| POST | `/api/routines` | `RoutineInput` | `RoutineDTO` |
| PATCH | `/api/routines/:id` | `Partial<RoutineInput>` | `RoutineDTO` |
| DELETE | `/api/routines/:id` | — | `{ ok: true }` |
| POST | `/api/routines/:id/run` | — | `{ ok: true }` |

## Validations

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/approvals` | `?status=pending` | `ApprovalDTO[]` |
| GET | `/api/approvals/:id/screenshot` | — | `image/png` |
| POST | `/api/approvals/:id/decide` | `ApprovalDecisionInput` | `ApprovalDTO` |

## Quota et budget

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/quota` | — | `QuotaStatusDTO` |
| GET | `/api/quota/usage` | `?days=30` | `UsageRowDTO[]` |
| POST | `/api/quota/subscription/reset` | — | `QuotaStatusDTO` (lève manuellement l'état « limité ») |

## Réglages, audit, push

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/api/settings` | — | `SettingsDTO` |
| PATCH | `/api/settings` | `Partial<SettingsDTO>` | `SettingsDTO` |
| GET | `/api/audit` | `?event=&actor=&before=<id>&limit=100` | `AuditEntryDTO[]` (du plus récent au plus ancien) |
| GET | `/api/audit/export.csv` | `?days=30` | CSV |
| GET | `/api/push/public-key` | — | `PushPublicKeyDTO` |
| POST | `/api/push/subscribe` | `PushSubscriptionJSON` | `{ ok: true }` |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | `{ ok: true }` |
| POST | `/api/push/test` | — | `{ delivered: number }` |

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

## Temps réel

`WS /api/ws` : le serveur envoie des `ServerEvent` en JSON (un par message). Le client peut envoyer `{"type":"ping"}`
(réponse `{"type":"pong"}`). Reconnexion à la charge du client (backoff exponentiel).
