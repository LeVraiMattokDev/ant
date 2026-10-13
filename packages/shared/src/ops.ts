/**
 * Santé & confiance (team B): thresholds shared by the server (health, watchdog) and the UI (Santé screen).
 * Contract: docs/API.md « Santé, arrêt d’urgence, coûts, premier démarrage ».
 */

/** The worker counts as alive when its `service_status` row is younger than this (it writes every ~30 s). */
export const WORKER_ALIVE_MS = 120_000;
/** The web service alerts (push + `health.updated`) once the worker has been silent this long. */
export const WORKER_DOWN_ALERT_MS = 3 * 60_000;
/** A backup older than this is shown as late (daily backups plus margin). */
export const BACKUP_STALE_HOURS = 26;
