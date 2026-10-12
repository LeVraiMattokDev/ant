import { TRIAGE_EFFORT, TRIAGE_MODEL, describeCron, type RoutineDraftDTO } from '@ant/shared';
import { RPC_CHANNEL } from '../lib/events';
import { getSettings } from '../lib/settings';
import { nextRuns, validateCron } from '../services/routines';
import type { WorkerDeps } from './deps';
import { oneShot } from './oneshot';
import { formatLocalDateTime } from './prompt';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cron', 'instruction', 'urgent'],
  properties: {
    cron: { type: 'string', description: 'Expression cron à 5 champs (minute heure jour-du-mois mois jour-de-semaine), dans le fuseau du propriétaire. Dimanche = 0.' },
    instruction: { type: 'string', description: 'La consigne à exécuter à chaque occurrence, reformulée à l’impératif, sans l’indication de fréquence' },
    urgent: { type: 'boolean', description: 'true seulement si le propriétaire indique que c’est important/urgent' },
  },
};

export { RPC_CHANNEL };

export type RoutineParseReply = { requestId: string; ok: true; draft: RoutineDraftDTO } | { requestId: string; ok: false; message: string };

/** Natural language → cron + instruction, with Haiku. Called on behalf of the web service. */
export async function parseRoutine(deps: WorkerDeps, requestId: string, text: string): Promise<RoutineParseReply> {
  const settings = await getSettings(deps.ctx.db);
  const res = await oneShot<{ cron: string; instruction: string; urgent: boolean }>(deps, settings, {
    label: 'routine-parse',
    model: TRIAGE_MODEL,
    effort: TRIAGE_EFFORT,
    system: `Tu convertis une demande de routine en expression cron. Nous sommes le ${formatLocalDateTime(new Date(), settings.timezone)}. Exemples : « chaque lundi à 8h » → "0 8 * * 1" ; « tous les jours à 18h30 » → "30 18 * * *" ; « en semaine à 9h » → "0 9 * * 1-5" ; « le 1er de chaque mois à 10h » → "0 10 1 * *". Pas plus d’une exécution toutes les 15 minutes.`,
    prompt: text,
    schema: SCHEMA,
    priority: 'interactive',
    origin: 'user',
    botId: null,
  });
  if (!res.ok) return { requestId, ok: false, message: `Interprétation impossible : ${res.reason}` };
  try {
    const cron = validateCron(res.value.cron, settings.timezone);
    return {
      requestId,
      ok: true,
      draft: {
        cron,
        timezone: settings.timezone,
        instruction: res.value.instruction,
        urgent: res.value.urgent,
        description: describeCron(cron),
        nextRuns: nextRuns(cron, settings.timezone).map((d) => d.toISOString()),
      },
    };
  } catch (err) {
    return { requestId, ok: false, message: `Expression proposée invalide (${res.value.cron}) : ${(err as Error).message}` };
  }
}
