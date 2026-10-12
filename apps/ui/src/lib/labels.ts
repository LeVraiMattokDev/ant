import type {
  ApprovalStatus,
  BotPermissions,
  ComputeSource,
  MemoryKind,
  NudgeKind,
  RunStatus,
  RunTrigger,
  SubscriptionHealth,
  TaskStatus,
} from '@ant/shared';

export const PERMISSION_LABELS: Record<keyof BotPermissions, { label: string; help: string }> = {
  terminal: { label: 'Terminal', help: 'Exécuter des commandes shell sur l’ordinateur des agents.' },
  browser: { label: 'Navigateur', help: 'Piloter Chromium sur l’ordinateur des agents.' },
  files: { label: 'Fichiers', help: 'Lire et écrire dans /workspace.' },
  webSearch: { label: 'Recherche web', help: 'Chercher sur le web et lire les pages trouvées.' },
  sharedMemoryWrite: {
    label: 'Écriture en mémoire partagée',
    help: 'Modifier la mémoire commune à tous les bots. Sa propre mémoire reste toujours modifiable.',
  },
  handoff: { label: 'Transferts', help: 'Confier une tâche à un autre bot ou le mentionner.' },
  lightSubagent: { label: 'Sous-agent léger', help: 'Déléguer une sous-tâche simple à Haiku (effort faible).' },
  expertSubagent: {
    label: 'Sous-agent expert',
    help: 'Déléguer un problème difficile à Opus. Limité par le plafond quotidien d’appels experts.',
  },
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as (keyof BotPermissions)[];

export const COMPUTE_SOURCE_LABELS: Record<ComputeSource, string> = {
  subscription: 'Abonnement',
  api: 'Crédits API',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'En file',
  running: 'En cours',
  waiting_approval: 'Attend une validation',
  done: 'Terminé',
  error: 'Erreur',
  cancelled: 'Annulé',
  paused: 'En pause',
};

export const RUN_TRIGGER_LABELS: Record<RunTrigger, string> = {
  user: 'Ta demande',
  mention: 'Mention',
  handoff: 'Transfert',
  heartbeat: 'Heartbeat',
  routine: 'Routine',
  digest: 'Résumé',
  approval: 'Validation',
  system: 'Système',
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  rejected: 'Refusée',
  expired: 'Expirée',
  executed: 'Exécutée',
  failed: 'Échec',
};

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  profil: 'Profil',
  preference: 'Préférence',
  projet: 'Projet',
  fait: 'Fait',
  note: 'Note',
};

export const NUDGE_KIND_LABELS: Record<NudgeKind, string> = {
  idee: 'Idée',
  risque: 'Risque',
  oubli: 'Oubli',
  etape: 'Prochaine étape',
  opportunite: 'Opportunité',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Ouverte',
  waiting: 'En attente',
  done: 'Terminée',
  dropped: 'Abandonnée',
};

export const HEALTH_LABELS: Record<SubscriptionHealth, string> = {
  ok: 'Disponible',
  warning: 'Proche de la limite',
  limited: 'Limité',
  unknown: 'État inconnu',
  not_configured: 'Non configuré',
  auth_failed: 'Jeton refusé',
};

export const COMPUTE_MODE_HELP: Record<string, string> = {
  hybrid_safe:
    'Tes demandes (tu écris à un bot, tu valides une action) passent par l’abonnement ; le travail autonome (heartbeats, routines, résumés, transferts entre bots) passe par les crédits API. C’est l’usage le plus proche de ce que prévoient les conditions de l’abonnement.',
  subscription_then_api:
    'Tout passe d’abord par l’abonnement, y compris le travail autonome, puis bascule sur les crédits API quand les seuils sont atteints. Économique, mais l’usage autonome sur l’abonnement n’est pas couvert explicitement par ses conditions.',
  subscription_only:
    'Seul l’abonnement est utilisé. Quand il atteint sa limite, les bots se mettent en pause jusqu’à la réinitialisation.',
  api_only: 'Seuls les crédits API sont utilisés, dans la limite des plafonds quotidien et mensuel.',
};
