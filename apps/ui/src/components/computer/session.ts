import type { QueryClient } from '@tanstack/react-query';
import { fetchAuthState, qk } from '../../lib/queries';

/**
 * The terminal and screen sockets close with 4401 when the session ends (revoked, expired, logout elsewhere).
 * Asks the server whether the session is really over: only a definite `authenticated: false` updates the auth state,
 * which takes the app back to the login screen. Resolves true in that case (stop reconnecting); false when the
 * session is still valid or the server cannot tell (network error, restart): keep retrying as usual.
 */
export async function confirmSessionEnded(qc: QueryClient): Promise<boolean> {
  try {
    const state = await fetchAuthState();
    if (state.authenticated !== false) return false;
    qc.setQueryData(qk.authState, state);
    return true;
  } catch {
    return false;
  }
}
