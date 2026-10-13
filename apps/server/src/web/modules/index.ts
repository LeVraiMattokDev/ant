import type { FastifyInstance } from 'fastify';
import type { ClientEvent } from '@ant/shared';
import { logger } from '../../lib/logger';
import type { WebDeps } from '../deps';
import type { RealtimeHub } from '../ws';
import { capabilitiesWebModule } from './capabilities';
import { inputsWebModule } from './inputs';
import { opsWebModule } from './ops';
import { trackingWebModule } from './tracking';
import type { RealtimeConnection, WebModule } from './types';

export type { RealtimeConnection, WebModule } from './types';

/** The feature modules of the web service, in a fixed order (tracking, ops, inputs, capabilities). */
export const WEB_MODULES: readonly WebModule[] = [trackingWebModule, opsWebModule, inputsWebModule, capabilitiesWebModule];

/** A module whose routes fail to register is logged and left out; the others and the core API still serve. */
export async function registerModuleRoutes(app: FastifyInstance, deps: WebDeps, modules: readonly WebModule[] = WEB_MODULES): Promise<void> {
  for (const m of modules) {
    if (!m.routes) continue;
    try {
      await m.routes(app, deps);
    } catch (err) {
      logger.error({ err, module: m.name }, 'feature module routes failed to register');
    }
  }
}

/**
 * Starts the modules; the returned function stops them (called when the app closes). A module that fails to start
 * is logged and skipped: the web service still starts.
 */
export async function startWebModules(deps: WebDeps, hub: RealtimeHub, modules: readonly WebModule[] = WEB_MODULES): Promise<() => Promise<void>> {
  const stops: (() => Promise<void>)[] = [];
  for (const m of modules) {
    if (!m.onStart) continue;
    try {
      const stop = await m.onStart(deps, hub);
      if (stop) stops.push(stop);
    } catch (err) {
      logger.error({ err, module: m.name }, 'feature module failed to start');
    }
  }
  return async () => {
    for (const stop of stops.reverse()) {
      await stop().catch((err) => logger.warn({ err }, 'feature module stop failed'));
    }
  };
}

export async function dispatchClientEvent(
  deps: WebDeps,
  connection: RealtimeConnection,
  event: Exclude<ClientEvent, { type: 'ping' }>,
  modules: readonly WebModule[] = WEB_MODULES,
): Promise<void> {
  for (const m of modules) {
    if (!m.onClientEvent) continue;
    try {
      await m.onClientEvent(deps, connection, event);
    } catch (err) {
      logger.warn({ err, module: m.name, type: event.type }, 'feature module failed on a client event');
    }
  }
}

export async function connectionClosed(deps: WebDeps, connection: RealtimeConnection, modules: readonly WebModule[] = WEB_MODULES): Promise<void> {
  for (const m of modules) {
    if (!m.onConnectionClose) continue;
    try {
      await m.onConnectionClose(deps, connection);
    } catch (err) {
      logger.warn({ err, module: m.name }, 'feature module failed on a closed connection');
    }
  }
}
