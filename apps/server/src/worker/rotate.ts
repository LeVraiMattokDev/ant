import { eq } from 'drizzle-orm';
import { TRIAGE_EFFORT, TRIAGE_MODEL } from '@ant/shared';
import { agentSessions, bots } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { recentTranscript } from '../services/messages';
import type { WorkerDeps } from './deps';
import { oneShot } from './oneshot';

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string', description: 'Résumé factuel, 400 mots maximum' } },
};

/**
 * Keeps per-message cost bounded: when a conversation's context grows past the threshold,
 * Haiku summarises it and the bot continues in a fresh Agent SDK session seeded with the summary.
 */
export async function rotateSession(deps: WorkerDeps, sessionId: string): Promise<string> {
  const { ctx } = deps;
  const session = await ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.id, sessionId) });
  if (!session || !session.active) return 'session inactive';
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, session.botId) });
  if (!bot) return 'bot introuvable';
  const settings = await getSettings(ctx.db);
  const [channelId, threadRootId] = session.threadKey.includes(':') && !session.threadKey.startsWith('heartbeat:')
    ? (session.threadKey.split(':') as [string, string])
    : [session.threadKey, null];
  const isConversation = /^[0-9a-f-]{36}$/.test(channelId);
  const names = new Map((await ctx.db.select({ id: bots.id, slug: bots.slug }).from(bots)).map((b) => [b.id, b.slug]));
  const transcript = isConversation ? await recentTranscript(ctx, channelId, threadRootId, 80, names) : '';
  const res = await oneShot<{ summary: string }>(deps, settings, {
    label: `session-rotate:${bot.slug}`,
    model: TRIAGE_MODEL,
    effort: TRIAGE_EFFORT,
    system:
      'Résume une conversation entre un propriétaire et ses bots pour qu’un bot puisse la poursuivre sans l’historique complet : décisions prises, faits établis, demandes en cours, engagements du bot, préférences exprimées. Factuel, en français, 400 mots maximum.',
    prompt: `${session.summary ? `Résumé précédent :\n${session.summary}\n\n` : ''}Conversation récente :\n${transcript || '(aucun message enregistré)'}`,
    schema: SUMMARY_SCHEMA,
    priority: 'background',
    origin: 'autonomous',
    botId: bot.id,
    botDailyCapUsd: bot.apiDailyCapUsd,
  });
  if (!res.ok) return `résumé impossible : ${res.reason}`;
  await ctx.db.transaction(async (tx) => {
    await tx.update(agentSessions).set({ active: false, updatedAt: new Date() }).where(eq(agentSessions.id, session.id));
    await tx.insert(agentSessions).values({
      botId: session.botId,
      threadKey: session.threadKey,
      generation: session.generation + 1,
      summary: res.value.summary,
      lastSeenAt: new Date(),
    });
  });
  await audit(ctx.db, { actor: botActor(bot.slug), event: 'session.rotate', detail: { threadKey: session.threadKey, generation: session.generation + 1, tokens: session.approxTokens } });
  return 'ok';
}
