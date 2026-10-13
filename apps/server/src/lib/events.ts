import type { ServerEvent } from '@ant/shared';
import type { Sql } from '../db/client';

export const EVENTS_CHANNEL = 'ant_events';
/** Worker → web replies (routine parsing). */
export const RPC_CHANNEL = 'ant_rpc';
/** NOTIFY payloads must stay under 8000 bytes (UTF-8, not UTF-16 units: accented text takes more). */
const MAX_PAYLOAD_BYTES = 7900;
/**
 * Pieces of an oversized delta, in UTF-16 units: even when every unit takes 6 bytes once escaped in JSON (control
 * characters), a piece and its envelope stay under the limit.
 */
export const DELTA_PIECE_UNITS = 1000;

/**
 * Event carried over Postgres NOTIFY between the worker and the web service.
 * Large message payloads are replaced by a reference that the web service expands.
 */
export type WireEvent = ServerEvent | { type: 'message.ref'; messageId: string; created: boolean } | { type: 'run.ref'; runId: string };

/** Splits text into pieces of at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
export function splitText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(text.slice(i, end));
    i = end;
  }
  return pieces;
}

export async function publish(sql: Sql, event: ServerEvent): Promise<void> {
  let wire: WireEvent = event;
  let payload = JSON.stringify(wire);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    if (event.type === 'message.created' || event.type === 'message.updated') {
      wire = { type: 'message.ref', messageId: event.message.id, created: event.type === 'message.created' };
    } else if (event.type === 'run.updated') {
      wire = { type: 'run.ref', runId: event.run.id };
    } else if (event.type === 'message.delta') {
      // Oversized delta: sent in pieces, each with its own position in the message text.
      let offset = event.offset;
      for (const piece of splitText(event.delta, DELTA_PIECE_UNITS)) {
        await sql.notify(EVENTS_CHANNEL, JSON.stringify({ ...event, delta: piece, ...(offset !== undefined ? { offset } : {}) }));
        if (offset !== undefined) offset += piece.length;
      }
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
