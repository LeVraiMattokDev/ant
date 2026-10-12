import type { ServerEvent } from '@ant/shared';
import type { Sql } from '../db/client';

export const EVENTS_CHANNEL = 'ant_events';
/** Worker → web replies (routine parsing). */
export const RPC_CHANNEL = 'ant_rpc';
const MAX_PAYLOAD = 7500;

/**
 * Event carried over Postgres NOTIFY between the worker and the web service.
 * Large message payloads are replaced by a reference that the web service expands.
 */
export type WireEvent = ServerEvent | { type: 'message.ref'; messageId: string; created: boolean } | { type: 'run.ref'; runId: string };

export async function publish(sql: Sql, event: ServerEvent): Promise<void> {
  let wire: WireEvent = event;
  let payload = JSON.stringify(wire);
  if (payload.length > MAX_PAYLOAD) {
    if (event.type === 'message.created' || event.type === 'message.updated') {
      wire = { type: 'message.ref', messageId: event.message.id, created: event.type === 'message.created' };
    } else if (event.type === 'run.updated') {
      wire = { type: 'run.ref', runId: event.run.id };
    } else if (event.type === 'message.delta') {
      // Split oversized deltas.
      const chunks = event.delta.match(/[\s\S]{1,3000}/g) ?? [];
      for (const chunk of chunks) await publish(sql, { ...event, delta: chunk });
      return;
    } else {
      return;
    }
    payload = JSON.stringify(wire);
  }
  await sql.notify(EVENTS_CHANNEL, payload);
}

export async function subscribe(sql: Sql, handler: (event: WireEvent) => void): Promise<() => Promise<void>> {
  const { unlisten } = await sql.listen(EVENTS_CHANNEL, (payload) => {
    try {
      handler(JSON.parse(payload) as WireEvent);
    } catch {
      // ignore malformed payloads
    }
  });
  return unlisten;
}
