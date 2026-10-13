import type { BotDTO } from '@ant/shared';

/**
 * French labels of the audit events written by the server (`audit()` calls in apps/server/src). The table and
 * the filter show these; the raw key stays in a tooltip and is what the API filters on (exact match).
 */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  tool: 'Appel d’outil',
  'approval.requested': 'Validation demandée',
  'approval.approved': 'Validation approuvée',
  'approval.rejected': 'Validation refusée',
  'approval.executed': 'Action validée exécutée',
  'approval.expired': 'Validation expirée',
  'audit.export': 'Export du journal',
  'auth.locked': 'Connexion verrouillée (trop d’échecs)',
  'auth.login': 'Connexion',
  'auth.login.failed': 'Connexion échouée',
  'auth.logout': 'Déconnexion',
  'auth.passkey.add': 'Passkey ajoutée',
  'auth.passkey.delete': 'Passkey supprimée',
  'auth.passkey.revoke_all': 'Toutes les passkeys révoquées',
  'auth.password.change': 'Mot de passe modifié',
  'auth.recovery_codes.regenerate': 'Codes de secours régénérés',
  'auth.session.revoke': 'Session révoquée',
  'auth.setup.complete': 'Initialisation terminée',
  'auth.setup.password': 'Mot de passe défini',
  'bot.archive': 'Bot archivé',
  'bot.create': 'Bot créé',
  'bot.update': 'Bot modifié',
  'channel.archive': 'Équipe archivée',
  'channel.create': 'Équipe créée',
  'compute.manual_reset': 'Source de calcul réinitialisée',
  'compute.subscription_restored': 'Abonnement de nouveau disponible',
  'compute.switch': 'Bascule de calcul',
  'computer.download': 'Fichier téléchargé depuis l’ordinateur',
  'computer.release': 'Ordinateur rendu aux agents',
  'computer.takeover': 'Prise de contrôle de l’ordinateur',
  'computer.terminal': 'Terminal de l’ordinateur ouvert',
  'computer.view': 'Écran de l’ordinateur affiché',
  digest: 'Résumé quotidien',
  handoff: 'Transfert à un autre bot',
  'handoff.blocked': 'Transfert bloqué',
  heartbeat: 'Heartbeat',
  'heartbeat.manual': 'Heartbeat lancé à la main',
  'memory.delete': 'Mémoire supprimée',
  'memory.update': 'Mémoire modifiée',
  'memory.write': 'Mémoire enregistrée',
  nudge: 'Relance',
  oneshot: 'Appel ponctuel au modèle',
  'push.subscribe': 'Notifications activées sur un appareil',
  'routine.create': 'Routine créée',
  'routine.delete': 'Routine supprimée',
  'routine.fire': 'Routine déclenchée',
  'routine.propose': 'Routine proposée',
  'routine.update': 'Routine modifiée',
  'run.cancel': 'Exécution annulée',
  'run.finished': 'Exécution terminée',
  'session.rotate': 'Session du bot renouvelée',
  'settings.update': 'Réglages modifiés',
  'subagent.start': 'Sous-agent démarré',
  'subagent.stop': 'Sous-agent terminé',
  'task.create': 'Tâche créée',
  'task.update': 'Tâche modifiée',
  'worker.start': 'Démarrage du worker',
  // Feature modules (docs/API.md « Événements d’audit »).
  notify_owner: 'Notification envoyée par un bot',
  'followup.create': 'Suivi programmé',
  'followup.update': 'Suivi modifié',
  'followup.cancel': 'Suivi annulé',
  'followup.fire': 'Suivi déclenché',
  'task.delete': 'Tâche supprimée',
  'emergency.stop': 'Arrêt d’urgence',
  'emergency.resume': 'Reprise après l’arrêt d’urgence',
  'approval.revoked': 'Autorisation révoquée',
  'job.retry': 'Tâche de fond relancée',
  diagnostic: 'Test de connexion à Claude',
  'worker.down': 'Worker injoignable',
  'worker.recovered': 'Worker de nouveau joignable',
  'attachment.upload': 'Fichier envoyé à un bot',
  'handoff.return': 'Retour d’un transfert',
  'draft.create': 'Brouillon créé',
  'draft.update': 'Brouillon modifié',
  'draft.decide': 'Décision sur un brouillon',
  'draft.published': 'Brouillon publié',
  'draft.delete': 'Brouillon supprimé',
  'watch.propose': 'Veille proposée',
  'watch.create': 'Veille créée',
  'watch.update': 'Veille modifiée',
  'watch.delete': 'Veille supprimée',
  'watch.change': 'Changement détecté par une veille',
};

/** Label of an event key; an unknown key (newer server) is shown as is. */
export function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] ?? event;
}

/** Known events for the filter, sorted by label. */
export function auditEventOptions(): { value: string; label: string }[] {
  return Object.entries(AUDIT_EVENT_LABELS)
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

export const AUDIT_OUTCOME_LABELS: Record<string, string> = {
  ok: 'Réussi',
  done: 'Terminé',
  executed: 'Exécuté',
  error: 'Erreur',
  failed: 'Échec',
  cancelled: 'Annulé',
  blocked: 'Bloqué',
  deferred: 'Reporté',
  expired: 'Expiré',
  pending: 'En attente',
  queued: 'En file d’attente',
  skipped: 'Ignoré',
  paused: 'En pause',
  nothing: 'Rien à signaler',
  switch: 'Bascule de calcul',
  raw: 'Texte brut',
};

export function auditOutcomeLabel(outcome: string): string {
  return AUDIT_OUTCOME_LABELS[outcome] ?? outcome;
}

/** Fixed actors written by the server; bots are `bot:<slug>`, their sub-agents `bot:<slug>/<agent type>`. */
export const AUDIT_ACTOR_LABELS: Record<string, string> = {
  owner: 'Toi',
  system: 'Système',
  anonyme: 'Anonyme',
};

/** "bot:dev/general-purpose" → "Dev · sous-agent general-purpose" (the slug when the bot is unknown or archived). */
export function formatActor(actor: string, bots: readonly Pick<BotDTO, 'slug' | 'name'>[] | undefined): string {
  const fixed = AUDIT_ACTOR_LABELS[actor];
  if (fixed) return fixed;
  const m = /^bot:([^/]+)(?:\/(.+))?$/.exec(actor);
  if (!m) return actor;
  const name = bots?.find((b) => b.slug === m[1])?.name ?? `@${m[1]}`;
  return m[2] ? `${name} · sous-agent ${m[2]}` : name;
}
