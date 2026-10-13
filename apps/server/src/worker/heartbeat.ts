import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { NUDGE_KINDS, TRIAGE_EFFORT, TRIAGE_MODEL, isWithinRange, type AppSettings } from '@ant/shared';
import { bots, channelMembers, messages } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { dmChannelId, type BotRow } from '../services/bots';
import { pinnedMemoryBlock } from '../services/memory';
import { recentNudgesSummary } from '../services/nudges';
import { requestRun } from '../services/runs';
import { openTasksSummary } from '../services/tasks';
import type { WorkerDeps } from './deps';
import { oneShot } from './oneshot';
import { formatLocalDateTime } from './prompt';

export interface TriageResult {
  creuser: boolean;
  sujets: { type: string; pourquoi: string }[];
}

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['creuser', 'sujets'],
  properties: {
    creuser: { type: 'boolean', description: 'true seulement s’il y a quelque chose de concret, utile et nouveau à creuser' },
    sujets: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'pourquoi'],
        properties: {
          type: { type: 'string', enum: [...NUDGE_KINDS] },
          pourquoi: { type: 'string', description: 'Une phrase : ce qui mérite l’attention et pourquoi maintenant' },
        },
      },
    },
  },
} as const;

export function isQuietFor(bot: Pick<BotRow, 'quietHours'>, settings: AppSettings, now = new Date()): boolean {
  return isWithinRange(now, settings.timezone, bot.quietHours ?? settings.quietHours);
}

/** Bots whose heartbeat is due now. */
export function heartbeatDue(bot: BotRow, settings: AppSettings, now = new Date()): boolean {
  if (!bot.heartbeatEnabled || bot.paused || bot.archivedAt) return false;
  if (isQuietFor(bot, settings, now)) return false;
  if (!bot.lastHeartbeatAt) return true;
  return now.getTime() - bot.lastHeartbeatAt.getTime() >= bot.heartbeatIntervalMin * 60_000;
}

async function recentActivity(deps: WorkerDeps, bot: BotRow, hours: number): Promise<string> {
  const { db } = deps.ctx;
  const since = new Date(Date.now() - hours * 3600_000);
  const channelIds = (await db.select({ id: channelMembers.channelId }).from(channelMembers).where(eq(channelMembers.botId, bot.id))).map((r) => r.id);
  if (channelIds.length === 0) return '(aucune activité)';
  const rows = await db
    .select({ authorKind: messages.authorKind, botId: messages.botId, content: messages.content, createdAt: messages.createdAt, kind: messages.meta })
    .from(messages)
    .where(and(inArray(messages.channelId, channelIds), gt(messages.createdAt, since)))
    .orderBy(desc(messages.createdAt))
    .limit(40);
  if (rows.length === 0) return '(aucune activité récente)';
  const names = new Map((await db.select({ id: bots.id, slug: bots.slug }).from(bots)).map((b) => [b.id, b.slug]));
  return rows
    .reverse()
    .map((r) => {
      const who = r.authorKind === 'user' ? 'Propriétaire' : r.authorKind === 'system' ? 'Système' : `@${names.get(r.botId ?? '') ?? 'bot'}`;
      const text = r.content.replace(/\s+/g, ' ').slice(0, 400);
      return `[${r.createdAt.toISOString().slice(0, 16)}] ${who} : ${text}`;
    })
    .join('\n');
}

export interface HeartbeatOutcome {
  status: 'skipped' | 'nothing' | 'queued' | 'paused';
  reason: string;
}

/**
 * Two-stage heartbeat: a cheap Haiku triage decides whether there is anything worth digging into;
 * only then the bot runs with its own model (Sonnet by default) and may send up to 3 nudges.
 */
export async function runHeartbeat(deps: WorkerDeps, botId: string, force = false, now = new Date()): Promise<HeartbeatOutcome> {
  const { ctx } = deps;
  const settings = await getSettings(ctx.db);
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot || bot.archivedAt || bot.paused) return { status: 'skipped', reason: 'bot en pause ou archivé' };
  if (!force && !bot.heartbeatEnabled) return { status: 'skipped', reason: 'heartbeat désactivé' };
  if (!force && isQuietFor(bot, settings, now)) return { status: 'skipped', reason: 'heures de silence' };
  // Atomic claim of the slot: a second job (enqueued under the next slot key while the first one waited
  // for an aux slot, or claimed at the same time) finds the heartbeat already done and stops here.
  const claimed = await ctx.db
    .update(bots)
    .set({ lastHeartbeatAt: now })
    .where(
      force
        ? eq(bots.id, bot.id)
        : and(eq(bots.id, bot.id), or(isNull(bots.lastHeartbeatAt), lte(bots.lastHeartbeatAt, new Date(now.getTime() - bot.heartbeatIntervalMin * 60_000)))),
    )
    .returning({ id: bots.id });
  if (claimed.length === 0) return { status: 'skipped', reason: 'heartbeat déjà fait pour cet intervalle' };

  const [memory, tasks, activity, previous] = await Promise.all([
    pinnedMemoryBlock(ctx, bot.id, 4000),
    openTasksSummary(ctx, bot.id, 20),
    recentActivity(deps, bot, 48),
    recentNudgesSummary(ctx, bot.id, settings.nudgeCooldownDays),
  ]);
  const context = `# Bot
${bot.name} (@${bot.slug}) — rôle : ${bot.role}

# Date
${formatLocalDateTime(now, settings.timezone)}

# Mémoire épinglée
${memory || '(vide)'}

# Tâches ouvertes
${tasks}

# Activité des 48 dernières heures
${activity}

# Relances déjà envoyées (à ne pas répéter)
${previous}`;

  const triage = await oneShot<TriageResult>(deps, settings, {
    label: `heartbeat-triage:${bot.slug}`,
    purpose: 'heartbeat_triage',
    model: TRIAGE_MODEL,
    effort: TRIAGE_EFFORT,
    system:
      'Tu fais le tri rapide d’un heartbeat : à partir du contexte d’un bot, décide s’il existe quelque chose de concret, utile et NOUVEAU à signaler au propriétaire (idée, risque, oubli, prochaine étape, opportunité). Sois exigeant : en cas de doute, creuser = false. Ne répète jamais une relance déjà envoyée.',
    prompt: context,
    schema: TRIAGE_SCHEMA as unknown as Record<string, unknown>,
    priority: force ? 'interactive' : 'background',
    origin: force ? 'user' : 'autonomous',
    botId: bot.id,
    botDailyCapUsd: bot.apiDailyCapUsd,
  });
  if (!triage.ok) {
    await audit(ctx.db, { actor: botActor(bot.slug), event: 'heartbeat', detail: { stage: 'triage', reason: triage.reason }, outcome: triage.paused ? 'paused' : 'error' });
    return { status: triage.paused ? 'paused' : 'skipped', reason: triage.reason };
  }
  if (!triage.value.creuser || triage.value.sujets.length === 0) {
    await audit(ctx.db, { actor: botActor(bot.slug), event: 'heartbeat', detail: { stage: 'triage', result: 'rien' }, outcome: 'nothing' });
    return { status: 'nothing', reason: 'rien à creuser' };
  }

  const topics = triage.value.sujets.map((s) => `- [${s.type}] ${s.pourquoi}`).join('\n');
  const prompt = `Heartbeat : revue proactive. Le tri préliminaire a repéré ces pistes :
${topics}

${context}

Creuse ces pistes (mémoire, tâches, recherche si utile), puis envoie entre 0 et 3 relances avec l’outil nudge_create. Une relance doit être concrète, actionnable et nouvelle ; si une piste ne tient pas après vérification, abandonne-la. Mets aussi à jour tes tâches si nécessaire. Ta réponse finale n’est pas publiée : résume-la en une phrase.`;
  const run = await requestRun(ctx, {
    botId: bot.id,
    channelId: await dmChannelId(ctx, bot.id),
    threadRootId: null,
    threadKey: `heartbeat:${bot.id}`,
    trigger: 'heartbeat',
    priority: force ? 'interactive' : 'background',
    origin: force ? 'user' : 'autonomous',
    prompt,
    payload: { nudgeTopics: triage.value.sujets.map((s) => s.pourquoi) },
  });
  await audit(ctx.db, { actor: botActor(bot.slug), event: 'heartbeat', runId: run?.id ?? null, detail: { stage: 'triage', topics: triage.value.sujets }, outcome: 'queued' });
  return { status: 'queued', reason: topics };
}
