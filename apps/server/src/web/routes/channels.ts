import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';
import { archiveChannel, createGroupChannel, getChannel, listChannels, updateGroupChannel } from '../../services/channels';
import { createMessage, getThread, listChannelMessages, searchMessages } from '../../services/messages';
import { activeRuns, cancelRun, dispatchUserMessage, listRecentRuns } from '../../services/runs';
import type { WebDeps } from '../deps';

const channelInput = z.object({
  name: z.string().trim().min(1).max(80),
  topic: z.string().max(500).optional(),
  botIds: z.array(z.string().uuid()).max(50),
});

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_date', `Date invalide : ${field}.`);
  return d;
}

export async function channelRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx } = deps;

  app.get('/api/channels', async () => listChannels(ctx));

  app.post('/api/channels', async (req) => {
    const channel = await createGroupChannel(ctx, channelInput.parse(req.body));
    await audit(ctx.db, { actor: 'owner', event: 'channel.create', detail: { id: channel.id, name: channel.name }, ip: req.ip });
    return channel;
  });

  app.patch<{ Params: { id: string } }>('/api/channels/:id', async (req) => updateGroupChannel(ctx, req.params.id, channelInput.partial().parse(req.body)));

  app.delete<{ Params: { id: string } }>('/api/channels/:id', async (req) => {
    await archiveChannel(ctx, req.params.id);
    await audit(ctx.db, { actor: 'owner', event: 'channel.archive', detail: { id: req.params.id }, ip: req.ip });
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/api/channels/:id/messages', async (req) => {
    await getChannel(ctx, req.params.id);
    return listChannelMessages(ctx, req.params.id, {
      before: parseDate(req.query.before, 'before'),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
  });

  app.post<{ Params: { id: string } }>('/api/channels/:id/messages', async (req) => {
    const body = z
      .object({ content: z.string().trim().min(1).max(50_000), threadRootId: z.string().uuid().nullable().optional() })
      .parse(req.body);
    await getChannel(ctx, req.params.id);
    const message = await createMessage(ctx, {
      channelId: req.params.id,
      threadRootId: body.threadRootId ?? null,
      authorKind: 'user',
      content: body.content,
    });
    const runs = await dispatchUserMessage(ctx, message);
    return { message, runs };
  });

  app.get<{ Params: { id: string } }>('/api/messages/:id/thread', async (req) => getThread(ctx, req.params.id));

  app.get<{ Querystring: { q?: string; channelId?: string; botId?: string; from?: string; to?: string } }>('/api/search', async (req) =>
    searchMessages(ctx, req.query.q ?? '', {
      channelId: req.query.channelId || undefined,
      botId: req.query.botId || undefined,
      from: parseDate(req.query.from, 'from'),
      to: parseDate(req.query.to, 'to'),
    }),
  );

  app.get<{ Querystring: { limit?: string; botId?: string } }>('/api/runs', async (req) =>
    listRecentRuns(ctx, req.query.limit ? Number(req.query.limit) : 50, req.query.botId || undefined),
  );
  app.get('/api/runs/active', async () => activeRuns(ctx));
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) => {
    await cancelRun(ctx, req.params.id);
    await audit(ctx.db, { actor: 'owner', event: 'run.cancel', runId: req.params.id, ip: req.ip });
    return { ok: true };
  });
}
