import { redactDeep, truncateDeep } from '@ant/shared';
import { secretValues } from '../config';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema';
import { logger } from './logger';

const secrets = secretValues();

export interface AuditInput {
  actor: string;
  event: string;
  runId?: string | null;
  tool?: string | null;
  detail?: unknown;
  outcome?: string | null;
  ip?: string | null;
}

export async function audit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actor: input.actor,
      event: input.event,
      runId: input.runId ?? null,
      tool: input.tool ?? null,
      detail: input.detail === undefined ? null : truncateDeep(redactDeep(input.detail, secrets)),
      outcome: input.outcome ?? null,
      ip: input.ip ?? null,
    });
  } catch (err) {
    logger.error({ err, event: input.event }, 'audit write failed');
  }
}

export function botActor(slug: string): string {
  return `bot:${slug}`;
}
