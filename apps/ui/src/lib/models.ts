/** Display helpers and pure state for the model selector. */
import { EFFORT_LABELS, MODEL_IDS, MODEL_LABELS, SELECTABLE_MODELS, isEffortLevel, type BotDTO, type EffortLevel } from '@ant/shared';

export const MODEL_HINTS: Record<string, string> = {
  [MODEL_IDS.sonnet]: 'Équilibré, pour le travail courant',
  [MODEL_IDS.opus]: 'Le plus capable, plus lent et plus cher',
  [MODEL_IDS.haiku]: 'Rapide et économique',
};

/** "Claude Sonnet 5.5"; unknown ids are shown as is. */
export function modelDisplayName(id: string): string {
  const label = MODEL_LABELS[id];
  return label ? `Claude ${label}` : id;
}

/** "Moyen", "Très élevé". */
export function effortDisplay(effort: string): string {
  const label = isEffortLevel(effort) ? EFFORT_LABELS[effort] : effort;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function modelPillLabel(model: string, effort: string): string {
  return `${modelDisplayName(model)} · ${effortDisplay(effort)}`;
}

/** Selectable models, plus the bot's current one when it is not in the list (kept visible, not lost). */
export function modelOptions(current: string): string[] {
  return SELECTABLE_MODELS.includes(current as (typeof SELECTABLE_MODELS)[number]) ? [...SELECTABLE_MODELS] : [...SELECTABLE_MODELS, current];
}

export type ModelPatch = { model?: string; effort?: EffortLevel };

/** The patch to send for a choice, or null when nothing changes. */
export function modelPatchFor(bot: Pick<BotDTO, 'model' | 'effort'>, choice: ModelPatch): ModelPatch | null {
  const patch: ModelPatch = {};
  if (choice.model !== undefined && choice.model !== bot.model) patch.model = choice.model;
  if (choice.effort !== undefined && choice.effort !== bot.effort) patch.effort = choice.effort;
  return Object.keys(patch).length ? patch : null;
}

/** Optimistic update of the bots list. Returns the same reference when the bot is absent. */
export function applyBotPatch(list: BotDTO[] | undefined, botId: string, patch: Partial<BotDTO>): BotDTO[] | undefined {
  if (!list || !list.some((b) => b.id === botId)) return list;
  return list.map((b) => (b.id === botId ? { ...b, ...patch } : b));
}
