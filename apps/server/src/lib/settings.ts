import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, appSettingsSchema, mergeSettings, type AppSettings, type SettingsPatch } from '@ant/shared';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

const KEY = 'app';

export async function getSettings(db: Db): Promise<AppSettings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, KEY) });
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...(row.value as Partial<AppSettings>) };
  const parsed = appSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export async function updateSettings(db: Db, patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings(db);
  const next = mergeSettings(current, patch);
  await db
    .insert(settings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}
