import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EFFORT_LEVELS, type BotInput } from '@ant/shared';
import { audit } from '../../lib/audit';
import { enqueue } from '../../lib/jobs';
import { archiveBot, createBot, getBot, listBots, updateBot } from '../../services/bots';
import type { WebDeps } from '../deps';

const timeRange = z.object({ start: z.string(), end: z.string() }).nullable();

const permissions = z
  .object({
    terminal: z.boolean(),
    browser: z.boolean(),
    files: z.boolean(),
    webSearch: z.boolean(),
    sharedMemoryWrite: z.boolean(),
    handoff: z.boolean(),
    lightSubagent: z.boolean(),
    expertSubagent: z.boolean(),
  })
  .partial();

const botInput = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().optional(),
  avatar: z.string().max(16).optional(),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().max(20_000).optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  permissions: permissions.optional(),
  heartbeatEnabled: z.boolean().optional(),
  heartbeatIntervalMin: z.number().int().optional(),
  quietHours: timeRange.optional(),
  apiDailyCapUsd: z.number().min(0).max(10_000).nullable().optional(),
  paused: z.boolean().optional(),
});

export async function botRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx } = deps;

  app.get('/api/bots', async () => listBots(ctx));

  app.post('/api/bots', async (req) => {
    const input = botInput.parse(req.body) as BotInput;
    const bot = await createBot(ctx, input);
    await audit(ctx.db, { actor: 'owner', event: 'bot.create', detail: { id: bot.id, slug: bot.slug }, ip: req.ip });
    return bot;
  });

  app.patch<{ Params: { id: string } }>('/api/bots/:id', async (req) => {
    const input = botInput.partial().parse(req.body) as Partial<BotInput>;
    const bot = await updateBot(ctx, req.params.id, input);
    await audit(ctx.db, { actor: 'owner', event: 'bot.update', detail: { id: bot.id, changes: input }, ip: req.ip });
    return bot;
  });

  app.delete<{ Params: { id: string } }>('/api/bots/:id', async (req) => {
    await getBot(ctx, req.params.id);
    await archiveBot(ctx, req.params.id);
    await audit(ctx.db, { actor: 'owner', event: 'bot.archive', detail: { id: req.params.id }, ip: req.ip });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/bots/:id/heartbeat', async (req) => {
    const bot = await getBot(ctx, req.params.id);
    await enqueue(ctx.db, 'heartbeat', { botId: bot.id, force: true }, { maxAttempts: 1 });
    await audit(ctx.db, { actor: 'owner', event: 'heartbeat.manual', detail: { botId: bot.id }, ip: req.ip });
    return { ok: true };
  });
}
