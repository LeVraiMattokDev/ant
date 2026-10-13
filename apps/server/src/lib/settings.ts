import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, appSettingsSchema, mergeSettings, type AppSettings, type SettingsPatch } from '@ant/shared';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

const KEY = 'app';

/** Stored value → settings (defaults for missing keys; all defaults if the stored value is invalid). */
function parseStored(value: unknown): AppSettings {
  if (!value) return structuredClone(DEFAULT_SETTINGS);
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...(value as Partial<AppSettings>) };
  const parsed = appSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export async function getSettings(db: Db): Promise<AppSettings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, KEY) });
  return parseStored(row?.value);
}

/**
 * Merges and saves settings. Routes pass what settingsPatchSchema accepted; server code may also write the
 * server-managed keys (emergencyStop, grantsRevokedAt).
 * Read, merge and write happen under a lock on the row: an owner's PATCH that started before an emergency stop
 * cannot write back the old `emergencyStop: null` over it (nor two writers lose each other's keys).
 */
export async function updateSettings(db: Db, patch: SettingsPatch | Partial<AppSettings>): Promise<AppSettings> {
  return db.transaction(async (tx) => {
    // The row must exist to be locked; an empty value means « all defaults ».
    await tx.insert(settings).values({ key: KEY, value: {} }).onConflictDoNothing({ target: settings.key });
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).for('update');
    const next = mergeSettings(parseStored(row?.value), patch);
    await tx.update(settings).set({ value: next, updatedAt: new Date() }).where(eq(settings.key, KEY));
    return next;
  });
}
