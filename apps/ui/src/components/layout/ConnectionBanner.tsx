import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useWsStatus } from '../../lib/ws';

/** A drop shorter than this (a reconnection in progress) is not worth a banner. */
export const REALTIME_GRACE_MS = 5_000;
/** Refresh period of what is on screen while the realtime connection is down. */
export const FALLBACK_POLL_MS = 15_000;
/** A server that has not answered the probe by then is treated as unreachable for this round. */
export const PROBE_TIMEOUT_MS = 10_000;
/** Cheap public route, behind the same proxy as the data (`/api`), used to know whether the server answers. */
export const PROBE_PATH = '/api/auth/state';

/** What the realtime events normally keep fresh. Only queries that are on screen (active) are refetched. */
const POLLED_KEYS = [qk.channels, qk.activeRuns, qk.messagesAll, qk.threadAll, qk.approvalsAll] as const;

/** `null`: realtime is up (or the drop is still short). `polling`: the server answers. `unreachable`: it does not. */
export type RealtimeFallback = null | 'polling' | 'unreachable';

/**
 * Non-null once the realtime connection has been down for REALTIME_GRACE_MS. Meanwhile the conversations, runs
 * and approvals on screen are refetched every FALLBACK_POLL_MS, so a blocked WebSocket (proxy without WebSocket
 * support) never leaves the owner looking at stale data. Each round first checks that the server answers: when
 * it does not (server restarting, proxy down, bad mobile network), refetching would only turn what is on screen
 * into error blocks, so the round is skipped and the last data stays displayed.
 */
export function useRealtimeFallback(): RealtimeFallback {
  const qc = useQueryClient();
  const status = useWsStatus();
  // 'connecting' and 'closed' alternate during the backoff: the delay runs from the first moment it is not open.
  const down = status === 'connecting' || status === 'closed';
  const [late, setLate] = useState(false);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    if (!down) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), REALTIME_GRACE_MS);
    return () => clearTimeout(t);
  }, [down]);

  useEffect(() => {
    if (!late) {
      setReachable(true);
      return;
    }
    let stopped = false;
    /** Probe of the current round; a round never starts while the previous one is still waiting. */
    let probe: AbortController | null = null;

    const refresh = async () => {
      // A hidden page does not need fresh data; the reconnection refreshes everything when it comes back.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (probe) return;
      const ctrl = new AbortController();
      probe = ctrl;
      const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      let ok = true;
      try {
        await get(PROBE_PATH, undefined, ctrl.signal);
      } catch {
        ok = false;
      } finally {
        clearTimeout(timeout);
        probe = null;
      }
      if (stopped) return;
      setReachable(ok);
      if (!ok) return;
      for (const queryKey of POLLED_KEYS) void qc.invalidateQueries({ queryKey });
    };

    void refresh();
    const t = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
      probe?.abort();
    };
  }, [late, qc]);

  if (!late) return null;
  return reachable ? 'polling' : 'unreachable';
}

/** Shown on every layout (the status dot of the icon rail does not exist on phones). */
export function ConnectionBanner() {
  const state = useRealtimeFallback();
  if (!state) return null;
  return (
    <div role="status" className="border-b border-warning/40 bg-warning-soft px-4 py-2 text-[13px]">
      {state === 'unreachable' ? (
        <>
          <span className="font-semibold text-warning">Serveur injoignable</span>{' '}
          <span className="text-fg">Nouvel essai en cours… Ce qui est affiché peut ne plus être à jour.</span>
        </>
      ) : (
        <>
          <span className="font-semibold text-warning">Connexion temps réel perdue</span>{' '}
          <span className="text-fg">Reconnexion en cours… En attendant, les conversations sont rafraîchies toutes les 15 secondes.</span>
        </>
      )}
    </div>
  );
}
