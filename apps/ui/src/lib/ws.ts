/** Single realtime connection to `/api/ws` with reconnection (exponential backoff + jitter) and keep-alive pings. */
import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@ant/shared';
import { dispatchServerEvent, type DispatchHooks } from './ws-dispatch';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

const PING_MS = 25_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

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

class RealtimeClient {
  private socket: WebSocket | null = null;
  private qc: QueryClient | null = null;
  private hooks: DispatchHooks = {};
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private wanted = false;
  private everOpened = false;
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
    if (s) {
      s.onclose = null;
      s.close(1000, 'logout');
    }
    this.everOpened = false;
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
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.attempt = 0;
    this.connect();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.onWake();
  };

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  private connect(): void {
    this.clearTimers();
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl('/api/ws'));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus('open');
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, PING_MS);
      // Events may have been missed while disconnected: refresh everything that is displayed.
      if (reconnected) void this.qc?.invalidateQueries();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string' || !this.qc) return;
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isServerEvent(data)) return;
      if ((data as { type: string }).type === 'pong') return;
      dispatchServerEvent(this.qc, data, this.hooks);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.clearTimers();
      this.setStatus('closed');
      if (this.wanted) this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      if (this.wanted) this.connect();
    }, delay);
  }
}

export const realtime = new RealtimeClient();

export function useWsStatus(): WsStatus {
  return useSyncExternalStore(realtime.subscribe, realtime.getStatus, () => 'idle' as WsStatus);
}
