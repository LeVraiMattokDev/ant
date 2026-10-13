import { and, eq, gte, inArray, lt, sql as dsql } from 'drizzle-orm';
import { TRIAGE_EFFORT, TRIAGE_MODEL, localDateKey, round2 } from '@ant/shared';
import { approvals, nudges, runModelUsage, runs, tasks } from '../db/schema';
import { audit } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { activeBots, dmChannelId } from '../services/bots';
import { createMessage } from '../services/messages';
import { notifyOwner } from '../services/push';
import type { WorkerDeps } from './deps';
import { oneShot } from './oneshot';

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown'],
  properties: { markdown: { type: 'string', description: 'Résumé quotidien en Markdown, 250 mots maximum' } },
};

/** Collects yesterday's facts (runs, approvals, nudges, tasks, consumption) and asks Haiku to write the digest. */
export async function runDigest(deps: WorkerDeps, now = new Date()): Promise<string> {
  const { ctx } = deps;
  const settings = await getSettings(ctx.db);
  const allBots = await activeBots(ctx);
  if (allBots.length === 0) return 'aucun bot';
  const author = allBots.find((b) => b.id === settings.digestBotId) ?? allBots[0]!;
  const since = new Date(now.getTime() - 24 * 3600_000);
  const yesterday = localDateKey(since, settings.timezone);
  const names = new Map(allBots.map((b) => [b.id, b.name]));

  const runRows = await ctx.db
    .select({ botId: runs.botId, status: runs.status, trigger: runs.trigger, n: dsql<number>`count(*)::int` })
    .from(runs)
    .where(gte(runs.createdAt, since))
    .groupBy(runs.botId, runs.status, runs.trigger);
  const pending = await ctx.db
    .select({ title: approvals.title, botId: approvals.botId, summary: approvals.summary })
    .from(approvals)
    .where(eq(approvals.status, 'pending'));
  const deferred = await ctx.db.select().from(nudges).where(and(gte(nudges.createdAt, since), inArray(nudges.status, ['deferred', 'delivered'])));
  const done = await ctx.db.select().from(tasks).where(and(eq(tasks.status, 'done'), gte(tasks.updatedAt, since)));
  const overdue = await ctx.db.select().from(tasks).where(and(inArray(tasks.status, ['open', 'waiting']), lt(tasks.dueAt, now)));
  const usage = await ctx.db
    .select({
      source: runModelUsage.computeSource,
      cost: dsql<number>`coalesce(sum(${runModelUsage.costUsd}),0)::float`,
      tokens: dsql<number>`coalesce(sum(${runModelUsage.inputTokens} + ${runModelUsage.outputTokens} + ${runModelUsage.cacheReadTokens} + ${runModelUsage.cacheWriteTokens}),0)::bigint`,
    })
    .from(runModelUsage)
    .where(eq(runModelUsage.day, yesterday))
    .groupBy(runModelUsage.computeSource);

  const facts = [
    `Période : dernières 24 h (journée du ${yesterday}).`,
    `Activité des bots :\n${runRows.map((r) => `- ${names.get(r.botId) ?? '?'} : ${r.n} exécution(s) ${r.trigger} → ${r.status}`).join('\n') || '- aucune'}`,
    `Validations en attente : ${pending.length}${pending.length ? `\n${pending.map((p) => `- ${p.title} (${names.get(p.botId) ?? '?'}) : ${p.summary.slice(0, 160)}`).join('\n')}` : ''}`,
    `Relances des dernières 24 h :\n${deferred.map((n) => `- ${names.get(n.botId) ?? '?'} [${n.kind}] ${n.title}${n.status === 'deferred' ? ' (reportée pendant les heures de silence)' : ''}`).join('\n') || '- aucune'}`,
    `Tâches terminées :\n${done.map((t) => `- ${t.title} (${names.get(t.botId) ?? '?'})`).join('\n') || '- aucune'}`,
    `Tâches en retard :\n${overdue.map((t) => `- ${t.title} (échéance ${t.dueAt?.toISOString().slice(0, 10)}, ${names.get(t.botId) ?? '?'})`).join('\n') || '- aucune'}`,
    `Consommation d’hier : ${usage.map((u) => (u.source === 'api' ? `crédits API ${round2(u.cost).toFixed(2)} $` : `abonnement ${Number(u.tokens).toLocaleString('fr-CH')} tokens (≈ ${round2(u.cost).toFixed(2)} $ en équivalent API)`)).join(' ; ') || 'aucune'}.`,
  ].join('\n\n');

  const res = await oneShot<{ markdown: string }>(deps, settings, {
    label: 'daily-digest',
    purpose: 'digest',
    model: TRIAGE_MODEL,
    effort: TRIAGE_EFFORT,
    system: `Tu es ${author.name}, et tu rédiges le résumé quotidien d’Ant pour son propriétaire. Français, Markdown, 250 mots maximum. Commence par ce qui demande son attention (validations en attente, tâches en retard), puis ce qui a été fait, puis la consommation. Pas de formule creuse.`,
    prompt: facts,
    schema: DIGEST_SCHEMA,
    priority: 'background',
    origin: 'autonomous',
    botId: author.id,
    botDailyCapUsd: author.apiDailyCapUsd,
  });
  // Without compute, the facts are still worth sending as-is.
  const body = res.ok ? res.value.markdown : `${facts}\n\n_(résumé brut : ${res.reason})_`;
  const channelId = await dmChannelId(ctx, author.id);
  await createMessage(ctx, {
    channelId,
    authorKind: 'bot',
    botId: author.id,
    content: `**Résumé du jour**\n\n${body}`,
    meta: { kind: 'digest', ...(res.ok ? { model: TRIAGE_MODEL, computeSource: res.source } : {}) },
  });
  if (deferred.some((n) => n.status === 'deferred')) {
    await ctx.db.update(nudges).set({ status: 'delivered', deliveredAt: now }).where(and(gte(nudges.createdAt, since), eq(nudges.status, 'deferred')));
  }
  await notifyOwner(ctx, deps.push, settings, { title: 'Résumé du jour', body: pending.length ? `${pending.length} validation(s) en attente.` : 'Ton résumé quotidien est prêt.', url: `/c/${channelId}`, tag: 'digest' });
  await audit(ctx.db, { actor: 'system', event: 'digest', detail: { author: author.slug, ok: res.ok }, outcome: res.ok ? 'ok' : 'raw' });
  return 'ok';
}
