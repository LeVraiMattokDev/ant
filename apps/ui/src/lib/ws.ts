/**
 * Single realtime connection to `/api/ws` with reconnection (exponential backoff + jitter), keep-alive pings
 * and a liveness deadline: a socket that stops answering pings (half-open TCP after a network switch or an
 * expired NAT entry) is dropped and replaced instead of staying "open" for many minutes.
 */
import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@ant/shared';
import { fetchAuthState, qk } from './queries';
import { dispatchServerEvent, type DispatchHooks } from './ws-dispatch';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

const PING_MS = 25_000;
/** A ping left unanswered this long means the connection is dead. */
export const PONG_TIMEOUT_MS = 10_000;
/** Shorter deadline when the page wakes up (tab visible again, network back): a dead link is replaced quickly. */
export const WAKE_PROBE_MS = 4_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** Close code sent by the server when the session is revoked or expired (apps/server/src/web/session-sockets.ts). */
export const SESSION_CLOSE_CODE = 4401;

/** Delay before reconnection attempt `attempt` (0-based): exponential, capped, with "equal jitter". */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

export function wsUrl(path: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${path}`;
}

function isServerEvent(v: unknown): v is ServerEvent {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** Detaches every handler so a replaced socket can no longer touch the client's state, then closes it. */
function detach(socket: WebSocket, code?: number, reason?: string): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  try {
    socket.close(code, reason);
  } catch {
    /* already closed */
  }
}

class RealtimeClient {
  private socket: WebSocket | null = null;
  private qc: QueryClient | null = null;
  private hooks: DispatchHooks = {};
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pongDeadline = 0;
  private wanted = false;
  /** Set whenever events may have been missed (a drop, a failed attempt): the next open refreshes the cache. */
  private needsResync = false;
  private checkingAuth = false;
  private status: WsStatus = 'idle';
  private listeners = new Set<() => void>();

  start(qc: QueryClient, hooks: DispatchHooks = {}): void {
    this.qc = qc;
    this.hooks = hooks;
    if (this.wanted) return;
    this.wanted = true;
    window.addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    window.removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) detach(s, 1000, 'logout');
    this.needsResync = false;
    this.attempt = 0;
    this.setStatus('idle');
  }

  getStatus = (): WsStatus => this.status;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private setStatus(s: WsStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.listeners) l();
  }

  private onWake = (): void => {
    if (!this.wanted) return;
    const s = this.socket;
    // "Open" can be a lie after a network switch: check that the server still answers.
    if (s?.readyState === WebSocket.OPEN) {
      this.probe(s, WAKE_PROBE_MS);
      return;
    }
    if (s?.readyState === WebSocket.CONNECTING) return;
    this.attempt = 0;
    this.connect();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.onWake();
  };

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.pongDeadline = 0;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.clearPongTimer();
  }

  /** Sends a ping and drops the socket if no pong comes back within `timeoutMs`. */
  private probe(socket: WebSocket, timeoutMs: number): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'ping' }));
    } catch {
      /* the deadline below handles a socket that cannot send */
    }
    const deadline = Date.now() + timeoutMs;
    // Keep an earlier deadline that is already armed; only tighten it.
    if (this.pongTimer && this.pongDeadline <= deadline) return;
    this.clearPongTimer();
    this.pongDeadline = deadline;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.pongDeadline = 0;
      if (this.socket === socket) this.abandon(socket);
    }, timeoutMs);
  }

  /**
   * Gives up on a socket that stopped answering. Its handlers are detached first: on a dead link the closing
   * handshake can take up to a minute, and its late `onclose` must not disturb the replacement.
   */
  private abandon(socket: WebSocket): void {
    detach(socket);
    this.socket = null;
    this.clearTimers();
    this.needsResync = true;
    this.setStatus('closed');
    this.attempt = 0;
    if (this.wanted) this.connect();
  }

  private connect(): void {
    this.clearTimers();
    const previous = this.socket;
    if (previous) {
      // Only a CLOSING or CLOSED socket gets replaced (see onWake): forget it so its close is a no-op.
      this.socket = null;
      detach(previous);
      this.needsResync = true;
    }
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl('/api/ws'));
    } catch {
      this.needsResync = true;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      const resync = this.needsResync;
      this.needsResync = false;
      this.attempt = 0;
      this.setStatus('open');
      this.pingTimer = setInterval(() => this.probe(socket, PONG_TIMEOUT_MS), PING_MS);
      // Events may have been missed while disconnected, or before a first attempt that failed: refresh what is displayed.
      if (resync) void this.qc?.invalidateQueries();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket || typeof ev.data !== 'string' || !this.qc) return;
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isServerEvent(data)) return;
      if ((data as { type: string }).type === 'pong') {
        this.clearPongTimer();
        return;
      }
      dispatchServerEvent(this.qc, data, this.hooks);
    };

    socket.onclose = (ev: CloseEvent) => {
      // A socket that was already replaced must not clear the new one's timers or schedule another connection.
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.needsResync = true;
      this.setStatus('closed');
      if (!this.wanted) return;
      // 4401: session revoked or expired. A refused upgrade (HTTP 401) shows up as a close without open (1006).
      if (ev.code === SESSION_CLOSE_CODE || !opened) void this.checkAuth();
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  /**
   * Asks the server whether the session is still valid. Only a definite `authenticated: false` updates the
   * auth state (the app then goes back to the login screen and stops this client); a network error, or a 200 answer
   * that is not the auth state (captive portal, proxy maintenance page, empty body: `fetchAuthState` rejects it), is
   * ignored so that a server restart never turns into a logout or an error screen.
   */
  private async checkAuth(): Promise<void> {
    if (this.checkingAuth) return;
    this.checkingAuth = true;
    try {
      const state = await fetchAuthState();
      if (state.authenticated === false && this.wanted) this.qc?.setQueryData(qk.authState, state);
    } catch {
      /* server unreachable: keep retrying the socket */
    } finally {
      this.checkingAuth = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = backoffDelay(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted) this.connect();
    }, delay);
  }
}

export const realtime = new RealtimeClient();

export function useWsStatus(): WsStatus {
  return useSyncExternalStore(realtime.subscribe, realtime.getStatus, () => 'idle' as WsStatus);
}
