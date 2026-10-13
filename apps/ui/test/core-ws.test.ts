import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { AuthStateDTO } from '@ant/shared';
import { PONG_TIMEOUT_MS, SESSION_CLOSE_CODE, WAKE_PROBE_MS, realtime } from '../src/lib/ws';
import { qk } from '../src/lib/queries';

/** Minimal WebSocket double driven by the test. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState < FakeSocket.CLOSING) this.readyState = FakeSocket.CLOSING;
  }

  // ── driven by the test ──
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  closed(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  get pings(): number {
    return this.sent.filter((s) => (JSON.parse(s) as { type: string }).type === 'ping').length;
  }
}

const AUTH_OK: AuthStateDTO = { setupRequired: false, authenticated: true, secondFactorPending: false, enrolmentPending: false, hasPasskey: false };

let qc: QueryClient;
let authAnswer: () => Promise<Response>;
const sockets = () => FakeSocket.all;
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  authAnswer = async () => new Response(JSON.stringify(AUTH_OK), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/auth/state')) return authAnswer();
      return new Response('{}', { status: 404 });
    }),
  );
  qc = new QueryClient();
  qc.setQueryData(qk.authState, AUTH_OK);
});

afterEach(() => {
  realtime.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('realtime liveness', () => {
  it('replaces an "open" socket that stops answering pings (half-open connection)', () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    realtime.start(qc);
    const s1 = last();
    s1.open();
    expect(realtime.getStatus()).toBe('open');

    vi.advanceTimersByTime(25_000);
    expect(s1.pings).toBe(1);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);

    // No pong: the dead socket is detached and a new one is opened at once.
    expect(sockets()).toHaveLength(2);
    expect(s1.onclose).toBeNull();
    expect(realtime.getStatus()).toBe('connecting');
    const s2 = last();
    s2.open();
    // Events were missed on the dead link: everything displayed is refreshed.
    expect(invalidate).toHaveBeenCalledTimes(1);
    // A late close of the abandoned socket changes nothing.
    s1.closed();
    expect(realtime.getStatus()).toBe('open');
    expect(sockets()).toHaveLength(2);
  });

  it('keeps a socket that answers its pings', () => {
    realtime.start(qc);
    const s1 = last();
    s1.open();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(25_000);
      s1.receive({ type: 'pong' });
    }
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);
    expect(sockets()).toHaveLength(1);
    expect(s1.pings).toBe(3);
    expect(realtime.getStatus()).toBe('open');
  });

  it('checks an open socket when the network comes back, with a short deadline', () => {
    realtime.start(qc);
    const s1 = last();
    s1.open();
    window.dispatchEvent(new Event('online'));
    expect(s1.pings).toBe(1);
    vi.advanceTimersByTime(WAKE_PROBE_MS + 1);
    expect(sockets()).toHaveLength(2);
  });

  it('ignores the late close of a socket replaced while it was closing', () => {
    realtime.start(qc);
    const s1 = last();
    s1.open();
    s1.readyState = FakeSocket.CLOSING; // server started a close handshake
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(2);
    const s2 = last();
    s1.closed(1001);
    expect(realtime.getStatus()).toBe('connecting');
    s2.open();
    vi.advanceTimersByTime(25_000);
    // The current socket kept its keep-alive (a stale close used to clear it).
    expect(s2.pings).toBe(1);
    s2.receive({ type: 'pong' });
    vi.advanceTimersByTime(20_000);
    // No third connection.
    expect(sockets()).toHaveLength(2);
    expect(realtime.getStatus()).toBe('open');
  });
});

describe('realtime resync', () => {
  it('refreshes the cache when the first attempt failed and a later one opens', () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    realtime.start(qc);
    last().closed(1006);
    vi.advanceTimersByTime(1_001);
    expect(sockets()).toHaveLength(2);
    last().open();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not refetch everything after a clean first connection', () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    realtime.start(qc);
    last().open();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('realtime and an ended session', () => {
  it('goes back to the login state when the server closes with 4401', async () => {
    authAnswer = async () => new Response(JSON.stringify({ ...AUTH_OK, authenticated: false }), { status: 200 });
    realtime.start(qc);
    last().open();
    last().closed(SESSION_CLOSE_CODE);
    await vi.advanceTimersByTimeAsync(1);
    expect(qc.getQueryData<AuthStateDTO>(qk.authState)?.authenticated).toBe(false);
  });

  it('checks the session when the upgrade is refused (close without open)', async () => {
    authAnswer = async () => new Response(JSON.stringify({ ...AUTH_OK, authenticated: false }), { status: 200 });
    realtime.start(qc);
    last().closed(1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(qc.getQueryData<AuthStateDTO>(qk.authState)?.authenticated).toBe(false);
  });

  it('keeps retrying without touching the auth state while the server is unreachable', async () => {
    authAnswer = async () => {
      throw new TypeError('Failed to fetch');
    };
    realtime.start(qc);
    last().closed(1006);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(qc.getQueryData<AuthStateDTO>(qk.authState)).toEqual(AUTH_OK);
    expect(qc.getQueryState(qk.authState)?.status).toBe('success');
    expect(sockets()).toHaveLength(2);
  });

  it('ignores a 200 answer that is not the auth state (captive portal, proxy maintenance page)', async () => {
    authAnswer = async () => new Response('<html><body>Maintenance en cours</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    realtime.start(qc);
    last().closed(1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(qc.getQueryData<AuthStateDTO>(qk.authState)).toEqual(AUTH_OK);
    authAnswer = async () => new Response('', { status: 200 });
    await vi.advanceTimersByTimeAsync(1_100);
    last().closed(1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(qc.getQueryData<AuthStateDTO>(qk.authState)).toEqual(AUTH_OK);
    // A JSON body without the field is not a definite "logged out" either.
    authAnswer = async () => new Response('{}', { status: 200 });
    await vi.advanceTimersByTimeAsync(2_100);
    last().closed(1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(qc.getQueryData<AuthStateDTO>(qk.authState)).toEqual(AUTH_OK);
  });

  it('does not check the session when an established socket simply drops', async () => {
    realtime.start(qc);
    last().open();
    last().closed(1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
