import { and, desc, eq } from 'drizzle-orm';
import { TRIAGE_EFFORT, TRIAGE_MODEL, type RunOrigin } from '@ant/shared';
import { agentSessions, bots, messages, runs } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { getSettings } from '../lib/settings';
import type { Ctx } from '../services/context';
import { recentTranscript } from '../services/messages';
import type { WorkerDeps } from './deps';
import { oneShot } from './oneshot';

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string', description: 'Résumé factuel, 400 mots maximum' } },
};

const CONVERSATION_SYSTEM =
  'Résume une conversation entre un propriétaire et ses bots pour qu’un bot puisse la poursuivre sans l’historique complet : décisions prises, faits établis, demandes en cours, engagements du bot, préférences exprimées. Factuel, en français, 400 mots maximum.';
const ROUTINE_SYSTEM =
  'Résume les exécutions précédentes d’une routine planifiée pour que le bot puisse la poursuivre sans leur historique complet : ce qui a été rapporté, les chiffres et faits utiles pour comparer d’une fois à l’autre, les points à suivre, les remarques du propriétaire. Factuel, en français, 400 mots maximum.';
const WATCH_SYSTEM =
  'Résume les exécutions précédentes d’une veille (page ou flux surveillé) pour que le bot puisse la poursuivre sans leur historique complet : changements constatés et ce qui en a été rapporté, éléments déjà signalés à ne pas répéter, points à suivre, remarques du propriétaire. Factuel, en français, 400 mots maximum.';
const RUNS_SYSTEM =
  'Résume les exécutions précédentes d’une tâche automatique d’un bot pour qu’il puisse la poursuivre sans leur historique complet : ce qui a été fait et rapporté, faits utiles pour la suite, points à suivre, remarques du propriétaire. Factuel, en français, 400 mots maximum.';
const HEARTBEAT_SYSTEM =
  'Résume les revues proactives (heartbeats) précédentes d’un bot pour qu’il puisse les poursuivre sans leur historique complet : pistes examinées, relances envoyées ou abandonnées et pourquoi, points à surveiller. Factuel, en français, 400 mots maximum.';

/** `runs`: any other session of its own (`<préfixe>:<id>`, e.g. a feature module's), summarised from its runs too. */
type SessionKind = 'conversation' | 'routine' | 'heartbeat' | 'watch' | 'runs';

const UUID = /^[0-9a-f-]{36}$/;

/**
 * What an agent session is about, from its thread key: `<channelId>` or `<channelId>:<threadRootId>` (a conversation),
 * `routine:<routineId>`, `heartbeat:<botId>`, `watch:<watchId>`, or any other `<préfixe>:<id>` whose prefix is not a
 * channel id (a session of its own: its history is its runs, like a routine's).
 */
export function parseThreadKey(threadKey: string): { kind: SessionKind; channelId: string | null; threadRootId: string | null } {
  if (threadKey.startsWith('routine:')) return { kind: 'routine', channelId: null, threadRootId: null };
  if (threadKey.startsWith('heartbeat:')) return { kind: 'heartbeat', channelId: null, threadRootId: null };
  if (threadKey.startsWith('watch:')) return { kind: 'watch', channelId: null, threadRootId: null };
  const [channelId = '', threadRootId = null, ...rest] = threadKey.split(':');
  if (!UUID.test(channelId)) return { kind: /^[a-z][a-z0-9_-]*$/i.test(channelId) && threadRootId ? 'runs' : 'conversation', channelId: null, threadRootId: null };
  if (rest.length > 0 || (threadRootId !== null && !UUID.test(threadRootId))) return { kind: 'conversation', channelId: null, threadRootId: null };
  return { kind: 'conversation', channelId, threadRootId };
}

const SYSTEMS: Record<SessionKind, string> = {
  conversation: CONVERSATION_SYSTEM,
  routine: ROUTINE_SYSTEM,
  heartbeat: HEARTBEAT_SYSTEM,
  watch: WATCH_SYSTEM,
  runs: RUNS_SYSTEM,
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A routine or heartbeat session has no conversation of its own: its history is its runs,
 * each with its instruction and the answer it published.
 */
async function runsTranscript(ctx: Ctx, botId: string, threadKey: string, limit: number): Promise<string> {
  const rows = await ctx.db
    .select({ createdAt: runs.createdAt, prompt: runs.prompt, status: runs.status, answer: messages.content })
    .from(runs)
    .leftJoin(messages, eq(messages.id, runs.responseMessageId))
    .where(and(eq(runs.botId, botId), eq(runs.threadKey, threadKey)))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((r) => {
      const at = r.createdAt.toISOString().slice(0, 16);
      const answer = r.answer ? clip(r.answer, 1500) : `(aucune réponse publiée, statut ${r.status})`;
      return `[${at}] Consigne : ${clip(r.prompt, 600)}\n[${at}] Toi : ${answer}`;
    })
    .join('\n');
}

/**
 * Keeps per-message cost bounded: when a session's context grows past the threshold,
 * Haiku summarises it and the bot continues in a fresh Agent SDK session seeded with the summary.
 * `origin` is the origin of the run that triggered the rotation: after the owner's own messages the
 * summary may use the subscription in hybrid mode, like the conversation it summarises.
 */
export async function rotateSession(deps: WorkerDeps, sessionId: string, origin: RunOrigin = 'autonomous'): Promise<string> {
  const { ctx } = deps;
  const session = await ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.id, sessionId) });
  if (!session || !session.active) return 'session inactive';
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, session.botId) });
  if (!bot) return 'bot introuvable';
  const settings = await getSettings(ctx.db);
  const key = parseThreadKey(session.threadKey);
  let transcript = '';
  if (key.kind !== 'conversation') {
    transcript = await runsTranscript(ctx, bot.id, session.threadKey, 20);
  } else if (key.channelId) {
    const names = new Map((await ctx.db.select({ id: bots.id, slug: bots.slug }).from(bots)).map((b) => [b.id, b.slug]));
    transcript = await recentTranscript(ctx, key.channelId, key.threadRootId, 80, names);
  }
  const system = SYSTEMS[key.kind];
  const label = key.kind === 'conversation' ? 'Conversation récente' : 'Exécutions récentes';
  const res = await oneShot<{ summary: string }>(deps, settings, {
    label: `session-rotate:${bot.slug}`,
    purpose: 'rotate',
    routineId: key.kind === 'routine' ? session.threadKey.slice('routine:'.length) : null,
    model: TRIAGE_MODEL,
    effort: TRIAGE_EFFORT,
    system,
    prompt: `${session.summary ? `Résumé précédent :\n${session.summary}\n\n` : ''}${label} :\n${transcript || '(aucun message enregistré)'}`,
    schema: SUMMARY_SCHEMA,
    priority: 'background',
    origin,
    botId: bot.id,
    botDailyCapUsd: bot.apiDailyCapUsd,
  });
  // No compute right now: the next run past the threshold tries again (hourly job key). A real failure (model error,
  // missing answer) ends the job « failed » with its reason, visible among the failed jobs.
  if (!res.ok && res.paused) return `résumé reporté : ${res.reason}`;
  if (!res.ok) throw new Error(`résumé de la session impossible : ${res.reason}`);
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
