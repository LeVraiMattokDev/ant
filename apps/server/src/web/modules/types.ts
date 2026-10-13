import type { FastifyInstance } from 'fastify';
import type { ClientEvent, ServerEvent } from '@ant/shared';
import type { WebDeps } from '../deps';
import type { RealtimeHub } from '../ws';

/** One open /api/ws connection, as the feature modules see it. */
export interface RealtimeConnection {
  /** Random id, unique per connection (presence rows are keyed by it). */
  readonly id: string;
  /** sha256 of the session token (auth_sessions.id). */
  readonly sessionId: string | null;
  /** Sends an event to this connection only. */
  send(event: ServerEvent): void;
}

/**
 * A feature module of the web service (docs/ARCHITECTURE.md « Évolutions »). Each team fills in its own module
 * file; app.ts and ws.ts call every module through web/modules/index.ts, so no team has to edit them.
 */
export interface WebModule {
  readonly name: string;
  /**
   * Registers this module's REST routes. Paths must start with /api/ (the session and CSRF checks of app.ts apply to
   * them like to every other route). To parse a raw body (uploads), register the routes inside
   * `app.register(async (scope) => { scope.addContentTypeParser(...); scope.post(...) })` so the parser stays local.
   */
  routes?(app: FastifyInstance, deps: WebDeps): Promise<void>;
  /** After the routes and the realtime hub exist (timers, LISTEN). Returns what stops it when the app closes. */
  onStart?(deps: WebDeps, hub: RealtimeHub): Promise<(() => Promise<void>) | void>;
  /** A message from a browser on /api/ws (already validated; `ping` is answered by ws.ts and never reaches modules). */
  onClientEvent?(deps: WebDeps, connection: RealtimeConnection, event: Exclude<ClientEvent, { type: 'ping' }>): Promise<void>;
  /** The connection closed (logout, network loss, session revoked). */
  onConnectionClose?(deps: WebDeps, connection: RealtimeConnection): Promise<void>;
}
