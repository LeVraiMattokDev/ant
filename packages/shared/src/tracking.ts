/**
 * Notifications & suivi (team A): limits shared by the server (followup tools, presence, completion push)
 * and the UI. Contract: docs/API.md « Suivi et notifications ».
 */

export const FOLLOWUP_LIMITS = {
  /** Earliest a bot may schedule a followup, in minutes from now (the owner may pick any future time). */
  minDelayMinutes: 5,
  /** Latest a followup may be scheduled, in days from now. */
  maxDelayDays: 90,
  /** Pending followups per bot. */
  maxPendingPerBot: 20,
  /** Followups a bot may chain (a followup run scheduling the next one) without a message from the owner. */
  maxChainDepth: 5,
  instructionMaxChars: 2000,
} as const;

/** The browser re-sends its `focus` presence at this interval while the page is visible. */
export const PRESENCE_REFRESH_MS = 30_000;
/** A connection whose presence was not refreshed for this long counts as gone (mobile sockets die silently). */
export const PRESENCE_TTL_MS = 60_000;
