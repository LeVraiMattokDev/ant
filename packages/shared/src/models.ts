/**
 * Model identifiers and effort levels, verified against the official Anthropic
 * documentation (models overview + effort pages) and the Agent SDK typings
 * (`EffortLevel`, `AgentDefinition.effort`). Do not invent new IDs here.
 */
export const MODEL_IDS = {
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  opus: 'claude-opus-5-5',
} as const;

export type ModelKey = keyof typeof MODEL_IDS;
export type ModelId = (typeof MODEL_IDS)[ModelKey];

export const MODEL_LABELS: Record<string, string> = {
  [MODEL_IDS.sonnet]: 'Sonnet 5.5',
  [MODEL_IDS.haiku]: 'Haiku 5.5',
  [MODEL_IDS.opus]: 'Opus 5.5',
};

export const SELECTABLE_MODELS: readonly ModelId[] = [MODEL_IDS.sonnet, MODEL_IDS.opus, MODEL_IDS.haiku];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'faible',
  medium: 'moyen',
  high: 'élevé',
  xhigh: 'très élevé',
  max: 'maximum',
};

/** Default for every new bot: Sonnet 5.5 with medium effort (Sonnet 5.5 defaults to `high` server-side, so it is always sent explicitly). */
export const DEFAULT_BOT_MODEL: ModelId = MODEL_IDS.sonnet;
export const DEFAULT_BOT_EFFORT: EffortLevel = 'medium';

export type SubagentTier = 'leger' | 'expert';

export const SUBAGENT_TIERS: Record<SubagentTier, { model: ModelId; effort: EffortLevel; label: string }> = {
  leger: { model: MODEL_IDS.haiku, effort: 'low', label: 'Haiku 5.5' },
  expert: { model: MODEL_IDS.opus, effort: 'high', label: 'Opus 5.5' },
};

/** Model used for cheap background classification (heartbeat triage, routine parsing, summaries). */
export const TRIAGE_MODEL: ModelId = MODEL_IDS.haiku;
export const TRIAGE_EFFORT: EffortLevel = 'low';

export function modelLabel(id: string | null | undefined): string {
  if (!id) return 'inconnu';
  return MODEL_LABELS[id] ?? id;
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}
