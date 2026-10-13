import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMPLETION_PUSH_MODES, describeCron, type RoutineDraftDTO, type RoutineInput } from '@ant/shared';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';
import { RPC_CHANNEL } from '../../lib/events';
import { enqueue } from '../../lib/jobs';
import { getSettings } from '../../lib/settings';
import { assertActiveChannel } from '../../services/channels';
import type { Ctx } from '../../services/context';
import { createRoutine, deleteRoutine, listRoutines, nextRuns, routineThreadKey, updateRoutine, validateCron } from '../../services/routines';
import { requestRun } from '../../services/runs';
import { routines } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { WebDeps } from '../deps';

export interface RoutineParser {
  parse(text: string, botId: string): Promise<RoutineDraftDTO>;
}

/**
 * The web service holds no Claude credentials: natural-language parsing runs in the worker
 * (job `routine.parse`), which answers on the `ant_rpc` NOTIFY channel.
 */
/**
 * Below the 60 s proxy_read_timeout of Nginx Proxy Manager's default proxy host: the owner gets this service's French
 * answer (and the manual entry) rather than the proxy's bare 504.
 */
export const ROUTINE_PARSE_TIMEOUT_MS = 55_000;

export async function createWorkerRoutineParser(ctx: Ctx, timeoutMs = ROUTINE_PARSE_TIMEOUT_MS): Promise<RoutineParser> {
  const waiting = new Map<string, { resolve: (d: RoutineDraftDTO) => void; reject: (e: Error) => void }>();
  await ctx.sql.listen(RPC_CHANNEL, (payload) => {
    try {
      const msg = JSON.parse(payload) as { requestId: string; ok: boolean; draft?: RoutineDraftDTO; message?: string };
      const w = waiting.get(msg.requestId);
      if (!w) return;
      waiting.delete(msg.requestId);
      if (msg.ok && msg.draft) w.resolve(msg.draft);
      else w.reject(new HttpError(422, 'parse_failed', msg.message ?? 'Interprétation impossible.'));
    } catch {
      // ignore malformed payloads
    }
  });
  return {
    async parse(text, botId) {
      const requestId = randomUUID();
      const result = new Promise<RoutineDraftDTO>((resolve, reject) => {
        waiting.set(requestId, { resolve, reject });
        setTimeout(() => {
          if (waiting.delete(requestId)) {
            reject(new HttpError(504, 'parse_timeout', 'Le worker n’a pas répondu à temps. Clique sur « Saisir l’horaire moi-même » pour indiquer l’expression cron.'));
          }
        }, timeoutMs);
      });
      await enqueue(ctx.db, 'routine.parse', { requestId, text, botId }, { maxAttempts: 1 });
      return result;
    },
  };
}

const routineInput = z.object({
  botId: z.string().uuid(),
  channelId: z.string().uuid().nullable().optional(),
  sourceText: z.string().max(2000),
  cron: z.string().min(9).max(100),
  timezone: z.string().optional(),
  instruction: z.string().min(1).max(4000),
  urgent: z.boolean().optional(),
  enabled: z.boolean().optional(),
  completionPush: z.enum(COMPLETION_PUSH_MODES).nullable().optional(),
  silentIfNothing: z.boolean().optional(),
});

export async function routineRoutes(app: FastifyInstance, deps: WebDeps, parser?: RoutineParser): Promise<void> {
  const { ctx } = deps;
  const rp = parser ?? (await createWorkerRoutineParser(ctx));

  app.get('/api/routines', async () => listRoutines(ctx));

  app.post('/api/routines/parse', async (req) => {
    const body = z.object({ text: z.string().trim().min(5).max(1000), botId: z.string().uuid() }).parse(req.body);
    return rp.parse(body.text, body.botId);
  });

  app.post('/api/routines/preview', async (req) => {
    const body = z.object({ cron: z.string(), timezone: z.string().optional() }).parse(req.body);
    const tz = body.timezone ?? (await getSettings(ctx.db)).timezone;
    const cron = validateCron(body.cron, tz);
    return { description: describeCron(cron), nextRuns: nextRuns(cron, tz).map((d) => d.toISOString()) };
  });

  // Bot and channel checks (unknown or archived → 400 unknown_bot / invalid_channel) belong to createRoutine and
  // updateRoutine, which know the real target: `channelId: null` or a new bot without a channel means a bot's DM.
  app.post('/api/routines', async (req) => {
    const settings = await getSettings(ctx.db);
    const routine = await createRoutine(ctx, routineInput.parse(req.body) as RoutineInput, settings.timezone);
    await audit(ctx.db, { actor: 'owner', event: 'routine.create', detail: { id: routine.id, cron: routine.cron }, ip: req.ip });
    return routine;
  });

  app.patch<{ Params: { id: string } }>('/api/routines/:id', async (req) => {
    const routine = await updateRoutine(ctx, req.params.id, routineInput.partial().parse(req.body) as Partial<RoutineInput>);
    await audit(ctx.db, { actor: 'owner', event: 'routine.update', detail: { id: routine.id, enabled: routine.enabled }, ip: req.ip });
    return routine;
  });

  app.delete<{ Params: { id: string } }>('/api/routines/:id', async (req) => {
    await deleteRoutine(ctx, req.params.id);
    await audit(ctx.db, { actor: 'owner', event: 'routine.delete', detail: { id: req.params.id }, ip: req.ip });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/routines/:id/run', async (req) => {
    const routine = await ctx.db.query.routines.findFirst({ where: eq(routines.id, req.params.id) });
    if (!routine) throw new HttpError(404, 'not_found', 'Routine introuvable.');
    if (routine.channelId) await assertActiveChannel(ctx, routine.channelId);
    const run = await requestRun(ctx, {
      botId: routine.botId,
      channelId: routine.channelId,
      threadRootId: null,
      // The routine's own agent session, like its scheduled occurrences: it remembers them and they remember this one.
      threadKey: routineThreadKey(routine.id),
      trigger: 'routine',
      priority: 'interactive',
      origin: 'user',
      prompt: routine.instruction,
      payload: { routineId: routine.id },
    });
    if (!run) throw new HttpError(409, 'bot_paused', 'Le bot de cette routine est en pause.');
    return { ok: true };
  });
}
