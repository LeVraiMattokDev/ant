import { eq, sql as dsql } from 'drizzle-orm';
import webpush from 'web-push';
import { isWithinRange, type AppSettings } from '@ant/shared';
import { pushSubscriptions } from '../db/schema';
import { publish } from '../lib/events';
import { logger } from '../lib/logger';
import type { Ctx } from './context';

export interface VapidConfig {
  publicKey?: string;
  privateKey?: string;
  subject: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Approval id: the notification offers approve/reject actions. */
  approvalId?: string;
}

export class PushSender {
  readonly enabled: boolean;

  constructor(private readonly ctx: Ctx, private readonly vapid: VapidConfig) {
    this.enabled = Boolean(vapid.publicKey && vapid.privateKey);
    if (this.enabled) webpush.setVapidDetails(vapid.subject, vapid.publicKey!, vapid.privateKey!);
  }

  async sendToAll(payload: PushPayload): Promise<number> {
    if (!this.enabled) return 0;
    const subs = await this.ctx.db.select().from(pushSubscriptions);
    let delivered = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
            TTL: 24 * 3600,
            urgency: payload.approvalId ? 'high' : 'normal',
          });
          delivered++;
          await this.ctx.db.update(pushSubscriptions).set({ lastOkAt: new Date(), failures: 0 }).where(eq(pushSubscriptions.id, s.id));
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
          } else {
            logger.warn({ err, endpoint: s.endpoint.slice(0, 60) }, 'push failed');
            await this.ctx.db
              .update(pushSubscriptions)
              .set({ failures: dsql`${pushSubscriptions.failures} + 1` })
              .where(eq(pushSubscriptions.id, s.id));
          }
        }
      }),
    );
    return delivered;
  }
}

export interface Notification extends PushPayload {
  level?: 'info' | 'warning' | 'error';
  /** Bypasses quiet hours when the owner allowed it in settings. */
  urgent?: boolean;
}

/** In-app toast + Web Push, respecting quiet hours. Returns true when a push was attempted. */
export async function notifyOwner(ctx: Ctx, push: PushSender, settings: AppSettings, n: Notification, now = new Date()): Promise<boolean> {
  await publish(ctx.sql, { type: 'toast', level: n.level ?? 'info', title: n.title, body: n.body, ...(n.url ? { url: n.url } : {}) });
  const quiet = isWithinRange(now, settings.timezone, settings.quietHours);
  if (quiet && !(n.urgent && settings.urgentPushDuringQuietHours)) return false;
  await push.sendToAll(n);
  return true;
}
