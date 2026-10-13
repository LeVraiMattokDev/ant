import { and, desc, eq, gt, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { settingsPatchSchema, type AuditEntryDTO, type NetworkInfoDTO } from '@ant/shared';
import { auditLog, pushSubscriptions } from '../../db/schema';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';
import { publish } from '../../lib/events';
import { getSettings, updateSettings } from '../../lib/settings';
import type { WebDeps } from '../deps';

export function auditToDTO(r: typeof auditLog.$inferSelect): AuditEntryDTO {
  return {
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    event: r.event,
    runId: r.runId ?? null,
    tool: r.tool ?? null,
    detail: r.detail,
    outcome: r.outcome ?? null,
    ip: r.ip ?? null,
  };
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function systemRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx } = deps;

  app.get('/api/settings', async () => getSettings(ctx.db));

  app.patch('/api/settings', async (req) => {
    const patch = settingsPatchSchema.parse(req.body);
    let next;
    try {
      next = await updateSettings(ctx.db, patch);
    } catch (err) {
      if (err instanceof Error && !(err instanceof z.ZodError)) throw new HttpError(400, 'invalid_settings', err.message);
      throw err;
    }
    await audit(ctx.db, { actor: 'owner', event: 'settings.update', detail: patch, ip: req.ip });
    await publish(ctx.sql, { type: 'quota.updated' });
    return next;
  });

  app.get<{ Querystring: { event?: string; actor?: string; before?: string; limit?: string } }>('/api/audit', async (req) => {
    const conditions: SQL[] = [];
    if (req.query.event) conditions.push(eq(auditLog.event, req.query.event));
    if (req.query.actor) conditions.push(eq(auditLog.actor, req.query.actor));
    if (req.query.before && /^\d+$/.test(req.query.before)) conditions.push(lt(auditLog.id, Number(req.query.before)));
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(limit);
    return rows.map(auditToDTO);
  });

  app.get<{ Querystring: { days?: string } }>('/api/audit/export.csv', async (req, reply) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 3650);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(gt(auditLog.at, new Date(Date.now() - days * 86_400_000)))
      .orderBy(desc(auditLog.id))
      .limit(100_000);
    const header = ['id', 'date', 'acteur', 'evenement', 'execution', 'outil', 'resultat', 'ip', 'detail'].join(',');
    const lines = rows.map((r) => [r.id, r.at.toISOString(), r.actor, r.event, r.runId, r.tool, r.outcome, r.ip, r.detail].map(csvCell).join(','));
    await audit(ctx.db, { actor: 'owner', event: 'audit.export', detail: { days, rows: rows.length }, ip: req.ip });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="ant-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(`﻿${header}\n${lines.join('\n')}\n`);
  });

  // What this service sees of the connection: Settings shows the proxy's address so TRUST_PROXY can name it exactly.
  app.get('/api/system/network', async (req): Promise<NetworkInfoDTO> => {
    const forwarded = req.headers['x-forwarded-for'];
    return {
      peerAddress: req.socket?.remoteAddress ?? null,
      clientIp: req.ip,
      forwardedFor: (Array.isArray(forwarded) ? forwarded.join(', ') : forwarded) ?? null,
      trustProxy: deps.cfg.TRUST_PROXY,
      trustAll: deps.cfg.TRUST_PROXY.trim() === 'true',
    };
  });

  // ───────────── Web Push ─────────────
  app.get('/api/push/public-key', async () => ({ publicKey: deps.cfg.VAPID_PUBLIC_KEY ?? null }));

  app.post('/api/push/subscribe', async (req) => {
    const body = z
      .object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) })
      .parse(req.body);
    if (!/^https:\/\//.test(body.endpoint)) throw new HttpError(400, 'invalid_endpoint', 'Point de terminaison push invalide.');
    await ctx.db
      .insert(pushSubscriptions)
      .values({ endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: body.keys.p256dh, auth: body.keys.auth, failures: 0 } });
    await audit(ctx.db, { actor: 'owner', event: 'push.subscribe', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(req.body);
    await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return { ok: true };
  });

  app.post('/api/push/test', async () => {
    if (!deps.push.enabled) throw new HttpError(400, 'push_disabled', 'Web Push n’est pas configuré (clés VAPID manquantes).');
    const delivered = await deps.push.sendToAll({ title: 'Ant', body: 'Notification de test : tout fonctionne.', url: '/settings', tag: 'test' });
    return { delivered };
  });
}
