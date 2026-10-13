/**
 * Capacités des agents (team D): handoff with return, web extraction, X drafts, page/RSS watches.
 * Contract: docs/API.md « Brouillons X et veilles ».
 */

/** Answer of a silent run (trigger `watch`, routines « silencieux si rien ») meaning « nothing to report ». */
export const SILENT_NOTHING = 'RIEN';

/**
 * True when a silent run's final answer means « nothing to report »: `RIEN`, case, spaces, punctuation and Markdown
 * marks ignored (« Rien. », « **RIEN** », « rien ! »). Anything else, an empty answer included, is a real answer.
 * Shared by the completion push (no push) and the silent answer (no message): both must agree.
 */
export function isSilentNothing(text: string): boolean {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase() === SILENT_NOTHING;
}

/** Each delegate's final answer passed back to the delegating bot (handoff with return). */
export const HANDOFF_REPORT_MAX_CHARS = 3_000;
/** Longest answer of web_extract given back to the bot. */
export const WEB_EXTRACT_MAX_CHARS = 3_000;

/** X counts every URL as 23 characters and a post up to 280 weighted characters. */
export const X_MAX_WEIGHTED_LENGTH = 280;
export const X_URL_WEIGHT = 23;
/** Web intent: opens X (the app on a phone) with the text prefilled; the owner publishes himself. */
export const X_INTENT_URL = 'https://x.com/intent/post';

export const WATCH_LIMITS = {
  minIntervalMin: 15,
  /** Normalised text kept to compare the next check against. */
  maxSnapshotBytes: 200_000,
  /** Diff given to the bot and shown in the UI. */
  maxDiffBytes: 8_000,
  /** Fetches running at the same time on the computer. */
  maxParallelChecks: 3,
  maxPerBot: 30,
} as const;
