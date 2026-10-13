import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { routines } from '../src/db/schema';
import { createBot } from '../src/services/bots';
import { archiveChannel, createGroupChannel } from '../src/services/channels';
import { canPostRoutine, createRoutine, minGapMinutes, updateRoutine, validateCron } from '../src/services/routines';
import { createTestDb, databaseAvailable, type TestDb } from './helpers';

const TZ = 'Europe/Zurich';

describe('routine schedule validation', () => {
  it('measures the smallest gap over the whole schedule, whatever the current time', () => {
    expect(minGapMinutes('0,58 8,9 * * *', TZ)).toBe(2);
    expect(minGapMinutes('0,5 9 * * *', TZ)).toBe(5);
    expect(minGapMinutes('0-58 9 * * *', TZ)).toBe(1);
    expect(minGapMinutes('59,0 23,0 * * *', TZ)).toBe(1);
    expect(minGapMinutes('*/15 * * * *', TZ)).toBe(15);
    expect(minGapMinutes('0,30 9 * * 1-5', TZ)).toBe(30);
    expect(minGapMinutes('30 7,12,18 * * *', TZ)).toBe(300);
    expect(minGapMinutes('0 8 * * 1', TZ)).toBe(1440);
  });

  it('refuses schedules that fire twice within 15 minutes, even when the next two runs are far apart', () => {
    // Validated at 09:30, the next two runs of this one are 09:58 and 08:00 tomorrow: the old check let it through.
    for (const cron of ['0,58 8,9 * * *', '0,5 9 * * *', '0-58 9 * * *', '10,20 9 * * *', '*/5 * * * *']) {
      expect(() => validateCron(cron, TZ), cron).toThrowError(/15 minutes/);
    }
    for (const cron of ['*/15 * * * *', '0,30 9 * * 1-5', '0 8 * * 1', '30 18 * * *', '0 10 1 * *']) {
      expect(validateCron(cron, TZ)).toBe(cron);
    }
  });
});

const hasDb = await databaseAvailable();

describe.skipIf(!hasDb)('routine target', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate routines, channel_members, channels, bots cascade`;
  });

  const input = (botId: string) => ({ botId, sourceText: 'chaque lundi', cron: '0 8 * * 1', instruction: 'Point hebdo' });

  it('follows the bot when it changes, and maps channelId null to the bot’s private conversation', async () => {
    const a = await createBot(t.ctx, { name: 'Alpha', role: 'a' });
    const b = await createBot(t.ctx, { name: 'Bravo', role: 'b' });
    const routine = await createRoutine(t.ctx, input(a.id), TZ);
    expect(routine.channelId).toBe(a.dmChannelId);

    // A new bot without a channel: its own DM, not the previous bot's private conversation.
    const moved = await updateRoutine(t.ctx, routine.id, { botId: b.id });
    expect(moved.botId).toBe(b.id);
    expect(moved.channelId).toBe(b.dmChannelId);

    const group = await createGroupChannel(t.ctx, { name: 'Équipe', botIds: [a.id, b.id] });
    expect((await updateRoutine(t.ctx, routine.id, { channelId: group.id })).channelId).toBe(group.id);
    // The new bot is a member of the group: the routine stays there.
    expect((await updateRoutine(t.ctx, routine.id, { botId: a.id })).channelId).toBe(group.id);
    // null = back to the bot's DM.
    expect((await updateRoutine(t.ctx, routine.id, { channelId: null })).channelId).toBe(a.dmChannelId);
  });

  it('answers 400 instead of 500 for unknown or foreign targets', async () => {
    const a = await createBot(t.ctx, { name: 'Alpha', role: 'a' });
    const b = await createBot(t.ctx, { name: 'Bravo', role: 'b' });
    const outsider = await createGroupChannel(t.ctx, { name: 'Sans Alpha', botIds: [b.id] });
    const routine = await createRoutine(t.ctx, input(a.id), TZ);
    const unknown = '00000000-0000-4000-8000-000000000000';

    const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
    expect(await status(updateRoutine(t.ctx, routine.id, { botId: unknown }))).toBe(400);
    expect(await status(updateRoutine(t.ctx, routine.id, { channelId: unknown }))).toBe(400);
    expect(await status(updateRoutine(t.ctx, routine.id, { channelId: b.dmChannelId }))).toBe(400);
    expect(await status(updateRoutine(t.ctx, routine.id, { channelId: outsider.id }))).toBe(400);
    expect(await status(createRoutine(t.ctx, input(unknown), TZ))).toBe(400);
    expect(await status(createRoutine(t.ctx, { ...input(a.id), channelId: b.dmChannelId }, TZ))).toBe(400);
    const row = await t.ctx.db.query.routines.findFirst({ where: eq(routines.id, routine.id) });
    expect(row?.channelId).toBe(a.dmChannelId);
    expect(row?.botId).toBe(a.id);
  });

  it('tells a bot where it may propose a routine, so a handoff in another bot’s conversation falls back to its own', async () => {
    const a = await createBot(t.ctx, { name: 'Alpha', role: 'a' });
    const b = await createBot(t.ctx, { name: 'Bravo', role: 'b' });
    const shared = await createGroupChannel(t.ctx, { name: 'Équipe', botIds: [a.id, b.id] });
    const outsider = await createGroupChannel(t.ctx, { name: 'Sans Bravo', botIds: [a.id] });
    const archived = await createGroupChannel(t.ctx, { name: 'Ancien', botIds: [b.id] });
    await archiveChannel(t.ctx, archived.id);

    expect(await canPostRoutine(t.ctx, b.id, b.dmChannelId)).toBe(true);
    expect(await canPostRoutine(t.ctx, b.id, shared.id)).toBe(true);
    expect(await canPostRoutine(t.ctx, b.id, a.dmChannelId)).toBe(false);
    expect(await canPostRoutine(t.ctx, b.id, outsider.id)).toBe(false);
    expect(await canPostRoutine(t.ctx, b.id, archived.id)).toBe(false);
    // What routine_propose does for Bravo, handed a task in Alpha's DM: its own DM, and the proposal succeeds.
    const channelId = (await canPostRoutine(t.ctx, b.id, a.dmChannelId)) ? a.dmChannelId : null;
    const proposed = await createRoutine(t.ctx, { ...input(b.id), channelId, enabled: false }, TZ);
    expect(proposed.channelId).toBe(b.dmChannelId);
  });

  it('checks the schedule again when a routine is enabled', async () => {
    const a = await createBot(t.ctx, { name: 'Alpha', role: 'a' });
    const routine = await createRoutine(t.ctx, { ...input(a.id), enabled: false }, TZ);
    // A schedule stored before the stricter check (or written directly) cannot be switched on.
    await t.ctx.db.update(routines).set({ cron: '0,58 8,9 * * *' }).where(eq(routines.id, routine.id));
    await expect(updateRoutine(t.ctx, routine.id, { enabled: true })).rejects.toMatchObject({ status: 400, code: 'too_frequent' });
  });
});
