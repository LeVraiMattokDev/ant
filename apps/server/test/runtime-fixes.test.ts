import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_BOT_PERMISSIONS, DEFAULT_SETTINGS, localMinutes, type BrowserRequest, type ServerEvent } from '@ant/shared';
import { agentSessions, approvals, budgetAlerts, messages, runs } from '../src/db/schema';
import { DELTA_PIECE_UNITS, publish, splitText, subscribe, type WireEvent } from '../src/lib/events';
import { updateSettings } from '../src/lib/settings';
import { setApprovalStatus } from '../src/services/approvals';
import { createBot } from '../src/services/bots';
import { archiveChannel, createGroupChannel } from '../src/services/channels';
import { ComputerClient } from '../src/services/computer-client';
import { patchComputeState } from '../src/services/quota';
import { requestRun } from '../src/services/runs';
import { executeApproval } from '../src/worker/approvals-exec';
import { agentClaimOptions } from '../src/worker/main';
import { rotateSession } from '../src/worker/rotate';
import type { RunContext } from '../src/worker/run-context';
import { executeRun } from '../src/worker/runner';
import { antTools } from '../src/worker/tools';
import { createTestDb, databaseAvailable, fakeQuery, sdk, stubComputer, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Neither the subscription nor the API configured: every run pauses. */
const NO_CREDENTIALS = { CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined };
type Delta = Extract<ServerEvent, { type: 'message.delta' }>;

describe('worker slots', () => {
  it('keeps the last agent slot for the owner’s requests, unless there is only one', () => {
    expect(agentClaimOptions(0, 3).onlyInteractive).toBe(false);
    expect(agentClaimOptions(1, 3).onlyInteractive).toBe(false);
    expect(agentClaimOptions(2, 3).onlyInteractive).toBe(true);
    expect(agentClaimOptions(1, 2).onlyInteractive).toBe(true);
    // A single slot: background work must still run.
    expect(agentClaimOptions(0, 1).onlyInteractive).toBe(false);
  });
});

describe('splitText', () => {
  it('cuts at the size asked, never between the halves of a surrogate pair', () => {
    expect(splitText('abcdef', 4)).toEqual(['abcd', 'ef']);
    const emoji = 'ab😀cd';
    const pieces = splitText(emoji, 3);
    expect(pieces.join('')).toBe(emoji);
    expect(pieces[0]).toBe('ab');
    expect(pieces.every((p) => !/[\ud800-\udbff]$/.test(p))).toBe(true);
  });
});

describe('computer client download', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('silent')) return; // never answers
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('début-');
      // The body takes longer than the headers timeout: it must still arrive in full.
      setTimeout(() => res.end('fin'), 400);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('bounds only the wait for the headers, not the reading of the body', async () => {
    const client = new ComputerClient(base, 'token-0123456789-0123456789');
    const res = await client.download('/workspace/gros.bin', 150);
    expect(await res.text()).toBe('début-fin');
    await expect(client.download('/workspace/silent', 150)).rejects.toThrow();
  });
});

describe.skipIf(!hasDb)('runs and approvals: follow-up fixes', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, handoffs, routines, channel_members, channels, bots, compute_state, budget_alerts, subscription_events, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
  });

  async function collect(): Promise<{ events: WireEvent[]; stop: () => Promise<void> }> {
    const events: WireEvent[] = [];
    const stop = await subscribe(t.ctx.sql, (e) => events.push(e));
    return { events, stop };
  }

  it('sends each streamed chunk with its position in the message', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    const { query } = fakeQuery(async function* () {
      yield sdk.init('s');
      for (const part of ['Bonjour, ', 'voici ', 'la réponse.']) {
        yield sdk.delta(part, 's');
        await sleep(180);
      }
      yield sdk.assistant('Bonjour, voici la réponse.', 's');
      yield sdk.result('Bonjour, voici la réponse.', 0.01, 'claude-sonnet-5-5', 's');
    });
    const { events, stop } = await collect();
    await executeRun(workerDeps(t.ctx, query), run!.id, new AbortController().signal);
    await sleep(100);
    await stop();
    const deltas = events.filter((e): e is Delta => e.type === 'message.delta');
    expect(deltas.length).toBeGreaterThan(1);
    let text = '';
    for (const d of deltas) {
      expect(d.offset).toBe(text.length);
      text += d.delta;
    }
    expect(text).toBe('Bonjour, voici la réponse.');
  });

  it('splits an oversized chunk into pieces that fit a NOTIFY, each with its own position', async () => {
    const { events, stop } = await collect();
    // 3 bytes per character in UTF-8: far over the 8000-byte limit while under 7500 UTF-16 units.
    const delta = '€'.repeat(2500) + 'é'.repeat(1200);
    await publish(t.ctx.sql, { type: 'message.delta', messageId: crypto.randomUUID(), channelId: crypto.randomUUID(), delta, offset: 42 });
    await sleep(100);
    await stop();
    const pieces = events.filter((e): e is Delta => e.type === 'message.delta');
    expect(pieces.length).toBe(Math.ceil(delta.length / DELTA_PIECE_UNITS));
    expect(pieces.map((p) => p.delta).join('')).toBe(delta);
    let offset = 42;
    for (const p of pieces) {
      expect(p.offset).toBe(offset);
      offset += p.delta.length;
    }
  });

  it('marks a routine’s answer with its routine', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'v' });
    const routineId = crypto.randomUUID();
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'routine', priority: 'background', origin: 'autonomous', prompt: 'x', payload: { routineId } });
    const { query } = fakeQuery(async function* () {
      yield sdk.assistant('Rien de neuf.');
      yield sdk.result('Rien de neuf.', 0.01);
    });
    await executeRun(workerDeps(t.ctx, query), run!.id, new AbortController().signal);
    const answer = await t.ctx.db.query.messages.findFirst({ where: eq(messages.runId, run!.id) });
    expect(answer?.meta).toMatchObject({ kind: 'chat', routineId });
  });

  it('cancels a run whose conversation was archived while it waited, without calling the model', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const group = await createGroupChannel(t.ctx, { name: 'Projet', botIds: [bot.id] });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: group.id, threadRootId: null, trigger: 'mention', priority: 'interactive', origin: 'user', prompt: 'x' });
    await archiveChannel(t.ctx, group.id);
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0);
    });
    expect((await executeRun(workerDeps(t.ctx, query), run!.id, new AbortController().signal)).outcome).toBe('cancelled');
    expect(calls).toHaveLength(0);
    expect(await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) })).toMatchObject({ status: 'cancelled', error: 'conversation archivée' });
  });

  it('wakes the owner about a pause during quiet hours only when he is waiting for an answer', async () => {
    const m = localMinutes(new Date(), DEFAULT_SETTINGS.timezone);
    const hhmm = (x: number) => `${String(Math.floor(((x + 1440) % 1440) / 60)).padStart(2, '0')}:${String((x + 1440) % 60).padStart(2, '0')}`;
    await updateSettings(t.ctx.db, { quietHours: { start: hhmm(m - 60), end: hhmm(m + 60) }, urgentPushDuringQuietHours: true });
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const paused = async (origin: 'user' | 'autonomous') => {
      const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: origin === 'user' ? 'user' : 'routine', priority: origin === 'user' ? 'interactive' : 'background', origin, prompt: 'x' });
      const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { cfg: NO_CREDENTIALS });
      expect((await executeRun(deps, run!.id, new AbortController().signal)).outcome).toBe('deferred');
    };
    await paused('autonomous');
    expect(await t.ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.scope, 'all_paused'))).toHaveLength(0);
    await paused('user');
    expect(await t.ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.scope, 'all_paused'))).toHaveLength(1);
  });

  it('fails the rotation job on a real summary failure, not when compute is merely paused', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const [session] = await t.ctx.db.insert(agentSessions).values({ botId: bot.id, threadKey: bot.dmChannelId, sdkSessionId: 'old', approxTokens: 200_000 }).returning();
    const broken = fakeQuery(async function* (): AsyncGenerator<SDKMessage> {
      yield sdk.assistant('', 's', 'server_error');
      yield sdk.result('', 0.001, 'claude-haiku-5-5', 's');
    });
    await expect(rotateSession(workerDeps(t.ctx, broken.query), session!.id)).rejects.toThrow(/résumé de la session impossible/);
    expect(await rotateSession(workerDeps(t.ctx, fakeQuery(async function* () {}).query, { cfg: NO_CREDENTIALS }), session!.id)).toMatch(/^résumé reporté/);
    // The session is still the active one, to be rotated later.
    expect((await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.id, session!.id) }))?.active).toBe(true);
  });

  it('replays an approved click or key on the very element shown on the card (its pin)', async () => {
    const bot = await createBot(t.ctx, { name: 'Social', role: 'x' });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    const browserCalls: BrowserRequest[] = [];
    const inspectCalls: Record<string, unknown>[] = [];
    let label = 'Publier';
    const computer = stubComputer({
      browser: async (req: BrowserRequest) => {
        browserCalls.push(req);
        return { ok: true, url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' };
      },
      inspect: async (req: Record<string, unknown>) => {
        inspectCalls.push(req);
        if (req.ref === 'e404') return { url: 'https://www.linkedin.com/feed/', title: 'LinkedIn', elementLabel: null };
        return { url: 'https://www.linkedin.com/feed/', title: 'LinkedIn', elementLabel: label, pin: '0f6d2a4e-6b1c-4f7a-9a51-1f0c2d3e4b5a', screenshotPng: 'iVBOR' };
      },
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    const rc: RunContext = {
      deps,
      settings: { ...DEFAULT_SETTINGS, sensitiveDomains: ['linkedin.com'] },
      run: (await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) }))!,
      bot: (await t.ctx.db.query.bots.findFirst())!,
      permissions: { ...DEFAULT_BOT_PERMISSIONS, browser: true },
      channel: null,
      computeSource: 'subscription',
      pendingApprovals: [],
      outputs: { attachments: [] },
      botsBySlug: new Map(),
      setActivity: async () => undefined,
    };
    const browser = antTools(rc).find((x) => x.name === 'browser')!;
    const call = (args: Record<string, unknown>) => (browser.handler as (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>)(args, {});

    // An element that no longer exists: no card that could never be executed.
    const missing = await call({ action: 'click', ref: 'e404' });
    expect(missing.isError).toBe(true);
    expect(await t.ctx.db.select().from(approvals)).toHaveLength(0);

    await call({ action: 'click', ref: 'e7' });
    await call({ action: 'press', ref: 'e8', key: 'Enter' });
    const cards = await t.ctx.db.select().from(approvals);
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.payload).toMatchObject({ pin: '0f6d2a4e-6b1c-4f7a-9a51-1f0c2d3e4b5a', expectedLabel: 'Publier' });

    // Later reads gave e7 to another element: the approved click still goes to the pinned node.
    const click = cards.find((c) => c.payload.action === 'click')!;
    await setApprovalStatus(t.ctx, click.id, 'approved');
    inspectCalls.length = 0;
    browserCalls.length = 0;
    expect(await executeApproval(deps, click.id)).toBe('executed');
    expect(inspectCalls).toEqual([{ pin: '0f6d2a4e-6b1c-4f7a-9a51-1f0c2d3e4b5a' }]);
    expect(browserCalls.at(-1)).toMatchObject({ action: 'click', pin: '0f6d2a4e-6b1c-4f7a-9a51-1f0c2d3e4b5a' });
    expect(browserCalls.at(-1)?.ref).toBeUndefined();

    // A key sent to an element whose label changed is not executed.
    const press = cards.find((c) => c.payload.action === 'press')!;
    await setApprovalStatus(t.ctx, press.id, 'approved');
    label = 'Supprimer le compte';
    browserCalls.length = 0;
    expect(await executeApproval(deps, press.id)).toBe('failed');
    expect(browserCalls.filter((b) => b.action === 'press')).toHaveLength(0);
    expect((await t.ctx.db.query.approvals.findFirst({ where: eq(approvals.id, press.id) }))?.result).toContain('l’élément ciblé a changé');
  });

  it('treats an empty ref or selector as no target, the same way when asking and when executing', async () => {
    const bot = await createBot(t.ctx, { name: 'Social', role: 'x' });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    const browserCalls: BrowserRequest[] = [];
    const inspectCalls: Record<string, unknown>[] = [];
    const computer = stubComputer({
      browser: async (req: BrowserRequest) => {
        browserCalls.push(req);
        return { ok: true, url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' };
      },
      inspect: async (req: Record<string, unknown>) => {
        inspectCalls.push(req);
        // The page navigated while the element was being pinned: a pin, but no label.
        return { url: 'https://www.linkedin.com/feed/', title: 'LinkedIn', elementLabel: null, pin: '0f6d2a4e-6b1c-4f7a-9a51-1f0c2d3e4b5a' };
      },
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    const rc: RunContext = {
      deps,
      settings: { ...DEFAULT_SETTINGS, sensitiveDomains: ['linkedin.com'] },
      run: (await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) }))!,
      bot: (await t.ctx.db.query.bots.findFirst())!,
      permissions: { ...DEFAULT_BOT_PERMISSIONS, browser: true },
      channel: null,
      computeSource: 'subscription',
      pendingApprovals: [],
      outputs: { attachments: [] },
      botsBySlug: new Map(),
      setActivity: async () => undefined,
    };
    const browser = antTools(rc).find((x) => x.name === 'browser')!;
    const call = (args: Record<string, unknown>) => (browser.handler as (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>)(args, {});

    // An element that could not be identified: no card that could never run.
    const unidentified = await call({ action: 'click', selector: '#publier' });
    expect(unidentified.isError).toBe(true);
    expect(unidentified.content[0]!.text).toContain('n’a pas pu être identifié');
    expect(await t.ctx.db.select().from(approvals)).toHaveLength(0);

    // `ref: ''` (a model filling an optional parameter): a key pressed on the page, not on an element.
    inspectCalls.length = 0;
    await call({ action: 'press', key: 'Enter', ref: '', selector: '' });
    expect(inspectCalls).toHaveLength(0);
    const [card] = await t.ctx.db.select().from(approvals);
    expect(card!.summary).toContain('Appuyer sur la touche « Entrée » — ');
    expect(card!.payload).toMatchObject({ targeted: false, pin: null });
    expect(card!.payload.ref).toBeUndefined();
    await setApprovalStatus(t.ctx, card!.id, 'approved');
    browserCalls.length = 0;
    expect(await executeApproval(deps, card!.id)).toBe('executed');
    expect(inspectCalls).toHaveLength(0);
    expect(browserCalls.at(-1)).toMatchObject({ action: 'press', key: 'Enter' });
    expect(browserCalls.at(-1)?.ref).toBeUndefined();
    expect(browserCalls.at(-1)?.selector).toBeUndefined();

    // A card written before `targeted` existed is judged by the same rule.
    const [legacy] = await t.ctx.db
      .insert(approvals)
      .values({
        botId: bot.id,
        channelId: bot.dmChannelId,
        category: 'navigateur_sensible',
        tool: 'browser',
        title: 'Appuyer',
        summary: 'Appuyer sur Entrée',
        payload: { action: 'press', key: 'Enter', ref: '', expectedUrl: 'https://www.linkedin.com/feed/', expectedLabel: null, pin: null },
        status: 'approved',
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    browserCalls.length = 0;
    expect(await executeApproval(deps, legacy!.id)).toBe('executed');
    expect(browserCalls.at(-1)).toMatchObject({ action: 'press', key: 'Enter' });
  });

  it('refuses to replay an element action approved without a pin', async () => {
    const bot = await createBot(t.ctx, { name: 'Social', role: 'x' });
    const browserCalls: BrowserRequest[] = [];
    const computer = stubComputer({
      browser: async (req: BrowserRequest) => {
        browserCalls.push(req);
        return { ok: true, url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' };
      },
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    const [legacy] = await t.ctx.db
      .insert(approvals)
      .values({
        botId: bot.id,
        channelId: bot.dmChannelId,
        category: 'navigateur_sensible',
        tool: 'browser',
        title: 'Cliquer',
        summary: 'Cliquer sur « Publier »',
        payload: { action: 'click', ref: 'e7', expectedUrl: 'https://www.linkedin.com/feed/', expectedLabel: null },
        status: 'approved',
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    expect(await executeApproval(deps, legacy!.id)).toBe('failed');
    expect(browserCalls.filter((b) => b.action === 'click')).toHaveLength(0);
    expect((await t.ctx.db.query.approvals.findFirst({ where: eq(approvals.id, legacy!.id) }))?.result).toContain('élément non identifié');
  });
});
