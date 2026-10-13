/**
 * Pièces jointes, partage, « Approfondir » (team C): limits and model choices shared by the server and the UI.
 * Contract: docs/API.md « Pièces jointes, partage, Approfondir ».
 */
import type { RunDepth } from './api';
import { MODEL_IDS, type EffortLevel, type ModelId } from './models';

/** Root of the owner's uploads on the agents' computer: `<INBOX_DIR>/AAAA-MM-JJ/<uuid>-<nom>`. */
export const INBOX_DIR = '/workspace/inbox';
/** Largest upload (POST /api/channels/:id/attachments). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Attachments per message (owner or bot). */
export const ATTACHMENTS_PER_MESSAGE = 10;
/**
 * Types GET /api/computer/files/download?inline=1 may serve inline (preview); anything else is sent as a download.
 * Never SVG or HTML: files written by bots would run as scripts on Ant's origin.
 */
export const INLINE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'] as const;

/** Model and effort of a one-off run (PostMessageInput.depth). `expert` counts in settings.expertDailyLimit. */
export const RUN_DEPTH_MODELS: Record<RunDepth, { model: ModelId; effort: EffortLevel; label: string }> = {
  rapide: { model: MODEL_IDS.haiku, effort: 'low', label: 'Rapide (Haiku 5.5)' },
  expert: { model: MODEL_IDS.opus, effort: 'high', label: 'Approfondi (Opus 5.5)' },
};
