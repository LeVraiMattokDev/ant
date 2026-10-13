import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_BOT_PERMISSIONS, DEFAULT_SETTINGS, SEARCH_MARK_END as E, SEARCH_MARK_START as S, type ServerEvent } from '@ant/shared';
import type { WebConfig } from '../src/config';
import { authSessions, bots, routines } from '../src/db/schema';
import { randomToken, sha256 } from '../src/lib/crypto';
import { subscribe, type WireEvent } from '../src/lib/events';
import { activeBots, updateBot } from '../src/services/bots';
import { createMemory, findSimilarMemory, listMemory, searchMemoryForBot } from '../src/services/memory';
import { createMessage, searchMessages } from '../src/services/messages';
import { PushSender } from '../src/services/push';
import { buildApp } from '../src/web/app';
import { schedulerTick } from '../src/worker/scheduler';
import { memoryTools } from '../src/worker/tools/memory';
import type { RunContext } from '../src/worker/run-context';
import { createTestDb, databaseAvailable, fakeQuery, stubComputer, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const ORIGIN = 'https://ant.test';
const DOWNLOAD_SIZE = 3 * 1024 * 1024 + 17;

function webConfig(url: string): WebConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: url,
    MIGRATIONS_DIR: '',
    COMPUTER_URL: 'http://computer.test:7000',
    COMPUTER_RPC_TOKEN: 'test-computer-token-0123456789',
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: 'mailto:test@example.com',
    PUBLIC_ORIGIN: ORIGIN,
    PORT: 0,
    HOST: '127.0.0.1',
    ENCRYPTION_KEY: 'test-encryption-key-0123456789-abcdef',
    SETUP_TOKEN: undefined,
    UI_DIST: '/nonexistent',
    TRUST_PROXY: 'false',
    SESSION_IDLE_HOURS: 12,
    SESSION_ABSOLUTE_DAYS: 30,
  };
}

/** A large file served as a stream; reading it whole (arrayBuffer) is refused. */
function streamedDownload(): Response {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(chunk.length, DOWNLOAD_SIZE - sent);
      if (n <= 0) return controller.close();
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
  const res = new Response(body, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(DOWNLOAD_SIZE), 'content-disposition': 'attachment; filename="gros.bin"' },
  });
  Object.defineProperty(res, 'arrayBuffer', { value: async () => Promise.reject(new Error('fichier chargé en mémoire')) });
  return res;
}

async function eventually(check: () => void | Promise<void>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe.skipIf(!hasDb)('web domain rules', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let cookie = '';
  const events: WireEvent[] = [];
  let unlisten: () => Promise<void> = async () => undefined;

  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}), headers: { 'x-requested-with': 'ant', origin: ORIGIN, cookie } });
  const newBot = async (name: string) => (await req('POST', '/api/bots', { name, role: 'Test' })).json() as { id: string; slug: string; dmChannelId: string };

  beforeAll(async () => {
    t = await createTestDb();
    const built = await buildApp(
      {
        ctx: t.ctx,
        cfg: webConfig(t.url),
        session: { secureCookies: true, idleHours: 12, absoluteDays: 30 },
        push: new PushSender(t.ctx, { subject: 'mailto:x@example.com' }),
        computer: stubComputer({
          health: async () => Promise.reject(new Error('injoignable')),
          download: async () => streamedDownload(),
        }),
        setupToken: { value: null },
        rpID: 'ant.test',
      },
      { serveUi: false, rpc: { parse: async () => ({ cron: '0 8 * * 1', timezone: 'Europe/Zurich', instruction: 'x', urgent: false, description: 'x', nextRuns: [] }) } },
    );
    app = built.app;
    await app.ready();
    const token = randomToken(32);
    await t.ctx.db.insert(authSessions).values({ id: sha256(token), stage: 'full', expiresAt: new Date(Date.now() + 86_400_000) });
    cookie = `__Host-ant_session=${token}`;
    unlisten = await subscribe(t.ctx.sql, (e) => events.push(e));
  });

  afterAll(async () => {
    await unlisten();
    await app?.close();
    await t?.drop();
  });

  it('refuses malformed quiet hours, and a bad stored value no longer stops the scheduler', async () => {
    const bot = await newBot('Veilleur');
    const bad = await req('PATCH', `/api/bots/${bot.id}`, { quietHours: { start: '', end: '07:30' } });
    expect(bad.statusCode).toBe(400);
    expect((await req('POST', '/api/bots', { name: 'Autre', role: 'x', quietHours: { start: '25:00', end: '07:00' } })).statusCode).toBe(400);
    const good = await req('PATCH', `/api/bots/${bot.id}`, { quietHours: { start: '22:00', end: '07:30' } });
    expect(good.json().quietHours).toEqual({ start: '22:00', end: '07:30' });

    // Same wording as the rest of the app when the service itself refuses it.
    await expect(updateBot(t.ctx, bot.id, { quietHours: { start: '7h', end: '22:00' } })).rejects.toThrow('Heures de silence invalides : format attendu HH:MM.');

    // A row written before validation existed.
    await t.ctx.db.update(bots).set({ quietHours: { start: '', end: '07:30' } }).where(eq(bots.id, bot.id));
    expect((await activeBots(t.ctx)).find((b) => b.id === bot.id)?.quietHours).toBeNull();
    await expect(schedulerTick(workerDeps(t.ctx, fakeQuery(async function* () {}).query))).resolves.toBeUndefined();
    // Repaired in the database too: code reading the raw row (the heartbeat job) no longer meets the bad value.
    expect((await t.ctx.db.query.bots.findFirst({ where: eq(bots.id, bot.id) }))?.quietHours).toBeNull();
  });

  it('keeps archived bots out of group members, so the group can still be saved', async () => {
    const a = await newBot('Alpha');
    const b = await newBot('Beta');
    const group = (await req('POST', '/api/channels', { name: 'projet', botIds: [a.id, b.id] })).json() as { id: string };
    expect((await req('DELETE', `/api/bots/${b.id}`)).statusCode).toBe(200);
    const listed = ((await req('GET', '/api/channels')).json() as { id: string; botIds: string[] }[]).find((c) => c.id === group.id)!;
    expect(listed.botIds).toEqual([a.id]);
    const saved = await req('PATCH', `/api/channels/${group.id}`, { name: 'projet-2', botIds: listed.botIds });
    expect(saved.statusCode).toBe(200);
  });

  it('stops the routines of an archived channel and refuses to point routines at it', async () => {
    const bot = await newBot('Routinier');
    const group = (await req('POST', '/api/channels', { name: 'veille', botIds: [bot.id] })).json() as { id: string };
    const routine = (await req('POST', '/api/routines', { botId: bot.id, channelId: group.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Veille' })).json() as { id: string };
    expect((await req('DELETE', `/api/channels/${group.id}`)).statusCode).toBe(200);
    const row = await t.ctx.db.query.routines.findFirst({ where: eq(routines.id, routine.id) });
    expect(row).toMatchObject({ enabled: false, nextRunAt: null });
    await eventually(() => expect(events.some((e) => e.type === 'routines.updated')).toBe(true));
    const create = await req('POST', '/api/routines', { botId: bot.id, channelId: group.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Veille' });
    expect(create.statusCode).toBe(400);
    expect(create.json().error).toBe('invalid_channel');
    expect((await req('PATCH', `/api/routines/${routine.id}`, { enabled: true })).statusCode).toBe(400);
    expect((await req('POST', `/api/routines/${routine.id}/run`)).statusCode).toBe(400);
  });

  it('rescues a routine stopped by an archived channel in one request, to its bot’s DM or another bot’s', async () => {
    const bot = await newBot('Sauveteur');
    const other = await newBot('Releve');
    const group = (await req('POST', '/api/channels', { name: 'temporaire', botIds: [bot.id] })).json() as { id: string };
    const create = () => req('POST', '/api/routines', { botId: bot.id, channelId: group.id, sourceText: 'x', cron: '0 9 * * 2', instruction: 'Point' });
    const first = (await create()).json() as { id: string };
    const second = (await create()).json() as { id: string };
    expect((await req('DELETE', `/api/channels/${group.id}`)).statusCode).toBe(200);

    const moved = await req('PATCH', `/api/routines/${first.id}`, { channelId: null, enabled: true });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ botId: bot.id, channelId: bot.dmChannelId, enabled: true });
    const handed = await req('PATCH', `/api/routines/${second.id}`, { botId: other.id, enabled: true });
    expect(handed.statusCode).toBe(200);
    expect(handed.json()).toMatchObject({ botId: other.id, channelId: other.dmChannelId, enabled: true });

    const unknown = await req('PATCH', `/api/routines/${first.id}`, { botId: crypto.randomUUID() });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('unknown_bot');
    const archived = await req('PATCH', `/api/routines/${first.id}`, { channelId: group.id });
    expect(archived.statusCode).toBe(400);
    expect(archived.json().error).toBe('invalid_channel');
  });

  it('refuses tasks, memory and routines for an unknown or archived bot', async () => {
    const gone = await newBot('Parti');
    await req('DELETE', `/api/bots/${gone.id}`);
    for (const botId of [crypto.randomUUID(), gone.id]) {
      const task = await req('POST', '/api/tasks', { botId, title: 'Relancer' });
      expect(task.statusCode).toBe(400);
      expect(task.json().error).toBe('unknown_bot');
      expect((await req('POST', '/api/memory', { scope: 'bot', botId, kind: 'fait', title: 'x', content: 'y' })).statusCode).toBe(400);
      expect((await req('POST', '/api/routines', { botId, sourceText: 'x', cron: '0 8 * * 1', instruction: 'x' })).statusCode).toBe(400);
    }
  });

  it('announces a new bot and, on archiving, its DM and disabled routines', async () => {
    events.length = 0;
    const bot = await newBot('Nouveau');
    await eventually(() => {
      expect(events).toContainEqual({ type: 'bot.updated', botId: bot.id });
      expect(events).toContainEqual({ type: 'channel.updated', channelId: bot.dmChannelId });
    });
    const routine = (await req('POST', '/api/routines', { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Point' })).json() as { id: string };
    events.length = 0;
    await req('DELETE', `/api/bots/${bot.id}`);
    expect(await t.ctx.db.query.routines.findFirst({ where: eq(routines.id, routine.id) })).toMatchObject({ enabled: false, nextRunAt: null });
    await eventually(() => {
      expect(events).toContainEqual({ type: 'channel.updated', channelId: bot.dmChannelId });
      expect(events).toContainEqual({ type: 'routines.updated' });
    });
  });

  it('never renames a handle the owner typed', async () => {
    const one = await newBot('Uno');
    const two = await newBot('Duo');
    const taken = await req('PATCH', `/api/bots/${two.id}`, { slug: one.slug });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('slug_taken');
    await req('DELETE', `/api/bots/${one.id}`);
    const archived = await req('PATCH', `/api/bots/${two.id}`, { slug: one.slug });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().message).toContain('archivé');
    expect((await req('PATCH', `/api/bots/${two.id}`, { slug: 'duo-bis' })).json().slug).toBe('duo-bis');
  });

  it('reports the real computer health when control changes hands', async () => {
    events.length = 0;
    const res = await req('POST', '/api/computer/control', { holder: 'user' });
    expect(res.json().online).toBe(false);
    await eventually(() => {
      const e = events.find((x): x is Extract<ServerEvent, { type: 'computer.updated' }> => x.type === 'computer.updated');
      expect(e?.status.online).toBe(false);
    });
  });

  it('streams file downloads instead of loading them in memory', async () => {
    const res = await req('GET', '/api/computer/files/download?path=/workspace/gros.bin');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(DOWNLOAD_SIZE));
    expect(res.rawPayload.length).toBe(DOWNLOAD_SIZE);
  });

  it('pages through messages written within the same millisecond without skipping any', async () => {
    const bot = await newBot('Bavard');
    const base = Date.UTC(2026, 0, 5, 10, 0, 0);
    // 30 messages: groups of three within one millisecond, two of them with the exact same timestamp.
    for (let i = 0; i < 30; i++) {
      const micros = (base + Math.floor(i / 3)) * 1000 + (i % 3 === 0 ? 100 : 400);
      await t.ctx.sql`insert into messages (channel_id, author_kind, content, created_at)
        values (${bot.dmChannelId}, 'user', ${`m${i}`}, to_timestamp(${micros / 1_000_000}))`;
    }
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const list = (await req('GET', `/api/channels/${bot.dmChannelId}/messages?limit=7${before ? `&before=${before}` : ''}`)).json() as { id: string; content: string }[];
      seen.push(...list.map((m) => m.content));
      if (list.length < 7) break;
      before = list[0]!.id;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('highlights accented words and keeps French quotes and cut emphasis clean', async () => {
    const bot = await newBot('Chercheur');
    const ch = bot.dmChannelId;
    await createMessage(t.ctx, { channelId: ch, authorKind: 'user', content: 'Réunion prévue demain avec l’équipe' });
    await createMessage(t.ctx, { channelId: ch, authorKind: 'user', content: 'Pour R1 enlève « usually ». Il a dit « bonjour » à Marie.' });
    await createMessage(t.ctx, {
      channelId: ch,
      authorKind: 'user',
      content: `${'mot '.repeat(60)}**Top post : « games are open source now », 196k vues** Pourquoi ça marche ${'fin '.repeat(60)}`,
    });
    const search = async (q: string) => (await req('GET', `/api/search?q=${encodeURIComponent(q)}&channelId=${ch}`)).json() as { snippet: string }[];
    expect((await search('reunion'))[0]!.snippet).toContain(`${S}Réunion${E} prévue`);
    expect((await search('équipe'))[0]!.snippet).toContain(`l’${S}équipe${E}`);
    const quoted = (await search('usually'))[0]!.snippet;
    expect(quoted).toContain(`enlève « ${S}usually${E} »`);
    expect(quoted).toContain('« bonjour »');
    const cut = (await search('games'))[0]!.snippet;
    expect(cut).toContain(`${S}games${E} are open source`);
    expect(cut).not.toContain('**');
  });

  it('keeps accents and tag-like text in snippets, and the bots’ bold markers paired', async () => {
    const bot = await newBot('Technicien');
    const ch = bot.dmChannelId;
    await createMessage(t.ctx, { channelId: ch, authorKind: 'user', content: 'Utilise `Promise<void>` pour la réunion de l’équipe' });
    await createMessage(t.ctx, { channelId: ch, authorKind: 'user', content: 'Le mot «gras» et <div class="x">la synthèse</div> du comité' });
    await createMessage(t.ctx, { channelId: ch, authorKind: 'user', content: 'Note \u0002brute\u0003 sur le budget' });
    await createMessage(t.ctx, { channelId: ch, authorKind: 'user', content: `début **${'mot '.repeat(40)}colloque important** suite ${'fin '.repeat(20)}` });
    const search = async (q: string) => (await req('GET', `/api/search?q=${encodeURIComponent(q)}&channelId=${ch}`)).json() as { snippet: string }[];

    expect((await search('reunion'))[0]!.snippet).toBe(`Utilise \`Promise<void>\` pour la ${S}réunion${E} de l’équipe`);
    expect((await search('synthese'))[0]!.snippet).toContain(`gras» et <div class="x">la ${S}synthèse${E}</div> du comité`);
    // Control characters of the message never pass for highlight markers.
    expect((await search('budget'))[0]!.snippet).toBe(`Note  brute  sur le ${S}budget${E}`);

    // Default marks ('**', the bots' tool): the excerpt starts inside a bold span, whose stray closing marker goes.
    const [hit] = await searchMessages(t.ctx, 'colloque', { channelId: ch });
    expect(hit!.snippet).toContain('**colloque** important suite');
    expect(hit!.snippet.split('**')).toHaveLength(3);
  });

  it('lets the bots find a fact by any of its words, while the search page keeps every word required', async () => {
    const bot = await newBot('Mémoire');
    await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: 'Projet Kozmo : lancement prévu en janvier 2027' });
    expect((await req('GET', `/api/search?q=${encodeURIComponent('Kozmo date de sortie')}`)).json()).toHaveLength(0);
    const found = await searchMessages(t.ctx, 'Kozmo date de sortie -brouillon');
    expect(found).toHaveLength(1);
    expect(found[0]!.snippet).toContain('**Kozmo**');
    expect(await searchMessages(t.ctx, 'Kozmo -lancement')).toHaveLength(0);

    await createMemory(t.ctx, { scope: 'shared', kind: 'projet', title: 'Projet Kozmo : lancement prévu en janvier 2027', content: 'Date annoncée au client.' }, { kind: 'user' });
    await createMemory(t.ctx, { scope: 'shared', kind: 'fait', title: 'Kozmo : date de sortie confirmée', content: 'Sortie le 12 janvier.' }, { kind: 'user' });
    const hits = await searchMemoryForBot(t.ctx, bot.id, 'Kozmo date de sortie');
    expect(hits.map((m) => m.title)).toEqual(['Kozmo : date de sortie confirmée', 'Projet Kozmo : lancement prévu en janvier 2027']);
    // The memory page keeps the strict search.
    expect(await listMemory(t.ctx, { q: 'Kozmo date de sortie' })).toHaveLength(1);
  });

  it('stops a bot from writing a memory item that already exists', async () => {
    const bot = (await activeBots(t.ctx)).find((b) => b.slug === 'memoire')!;
    expect(await findSimilarMemory(t.ctx, bot.id, 'Préférence de café du propriétaire')).toBeNull();
    expect((await findSimilarMemory(t.ctx, bot.id, 'Lancement du projet Kozmo'))?.title).toBe('Projet Kozmo : lancement prévu en janvier 2027');
    const run = { id: crypto.randomUUID() } as RunContext['run'];
    const rc = {
      deps: workerDeps(t.ctx, fakeQuery(async function* () {}).query),
      settings: DEFAULT_SETTINGS,
      run,
      bot,
      permissions: DEFAULT_BOT_PERMISSIONS,
    } as unknown as RunContext;
    const write = memoryTools(rc).find((x) => x.name === 'memory_write')!;
    const call = (args: Record<string, unknown>) =>
      (write.handler as unknown as (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>)(args, {});
    const dup = await call({ scope: 'bot', kind: 'projet', title: 'projet kozmo — lancement prévu en janvier 2027', content: 'doublon' });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toContain('Élément proche existant');
    const forced = await call({ scope: 'bot', kind: 'projet', title: 'Projet Kozmo : lancement prévu en janvier 2027', content: 'autre angle', force: true });
    expect(forced.isError).toBeFalsy();
    const fresh = await call({ scope: 'bot', kind: 'preference', title: 'Café sans sucre', content: 'Le propriétaire boit son café sans sucre.' });
    expect(fresh.content[0]!.text).toContain('Mémorisé');
  });
});
