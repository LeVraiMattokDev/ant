import { eq } from 'drizzle-orm';
import type { ServiceKey } from '@ant/shared';
import { serviceStatus } from '../db/schema';
import { ANT_VERSION } from '../lib/version';
import type { Ctx } from './context';

export type ServiceStatusRow = typeof serviceStatus.$inferSelect;

/** Records that `key` is alive now, with its details (replaces the previous ones). */
export async function touchServiceStatus(ctx: Ctx, key: ServiceKey, details: object, now = new Date()): Promise<void> {
  const detail = details as Record<string, unknown>;
  await ctx.db
    .insert(serviceStatus)
    .values({ key, seenAt: now, version: ANT_VERSION, detail, updatedAt: now })
    .onConflictDoUpdate({ target: serviceStatus.key, set: { seenAt: now, version: ANT_VERSION, detail, updatedAt: now } });
}

export async function getServiceStatus(ctx: Ctx, key: ServiceKey): Promise<ServiceStatusRow | null> {
  return (await ctx.db.query.serviceStatus.findFirst({ where: eq(serviceStatus.key, key) })) ?? null;
}
