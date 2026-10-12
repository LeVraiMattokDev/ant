import type { FastifyInstance } from 'fastify';
import { audit } from '../../lib/audit';
import { getSettings } from '../../lib/settings';
import { patchComputeState, quotaStatus, usageRows } from '../../services/quota';
import type { WebDeps } from '../deps';

export async function quotaRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx } = deps;

  app.get('/api/quota', async () => quotaStatus(ctx, await getSettings(ctx.db)));

  app.get<{ Querystring: { days?: string } }>('/api/quota/usage', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const settings = await getSettings(ctx.db);
    return usageRows(ctx, days, settings.timezone);
  });

  app.post('/api/quota/subscription/reset', async (req) => {
    await patchComputeState(ctx, {
      subLimitedUntil: null,
      subLastStatus: 'allowed',
      subAuthFailed: false,
      apiAuthFailed: false,
      allPausedReason: null,
      subFiveHourUtil: null,
      subSevenDayUtil: null,
    });
    await audit(ctx.db, { actor: 'owner', event: 'compute.manual_reset', ip: req.ip });
    return quotaStatus(ctx, await getSettings(ctx.db));
  });
}
