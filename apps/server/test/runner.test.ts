import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentSessions, approvals, auditLog, handoffs, jobs, messages, runModelUsage, runs } from '../src/db/schema';
import { updateSettings } from '../src/lib/settings';
import { createBot } from '../src/services/bots';
import { createGroupChannel } from '../src/services/channels';
import { createMessage } from '../src/services/messages';
import { getComputeState, patchComputeState } from '../src/services/quota';
import { dispatchUserMessage, requestRun } from '../src/services/runs';
import { executeApproval } from '../src/worker/approvals-exec';
import { executeRun } from '../src/worker/runner';
import { antTools } from '../src/worker/tools';
import type { RunContext } from '../src/worker/run-context';
import { setApprovalStatus } from '../src/services/approvals';
import { DEFAULT_BOT_PERMISSIONS, DEFAULT_SETTINGS } from '@ant/shared';
import { createTestDb, databaseAvailable, fakeQuery, sdk, stubComputer, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();

describe.skipIf(!hasDb)('bot runs', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, handoffs, channel_members, channels, bots, compute_state, budget_alerts, subscription_events, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
  });

  async function dmRun(prompt = 'Bonjour') {
    const bot = await createBot(t.ctx, { name: 'Chef de cabinet', role: 'Assistant principal' });
    const msg = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: prompt });
    const [run] = await dispatchUserMessage(t.ctx, msg);
    return { bot, run: run! };
  }

  it('completes a DM run on the subscription, streams and records usage', async () => {
    const { bot, run } = await dmRun();
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-a');
      yield sdk.delta('Bonjour ', 'sess-a');
      yield sdk.delta('!', 'sess-a');
      yield sdk.assistant('Bonjour !', 'sess-a');
      yield sdk.result('Bonjour !', 0.0123, 'claude-sonnet-5-5', 'sess-a');
    });
    const deps = workerDeps(t.ctx, query);
    const res = await executeRun(deps, run.id, new AbortController().signal);
    expect(res.outcome).toBe('done');

    expect(calls).toHaveLength(1);
    const opts = calls[0]!.options;
    expect(opts.model).toBe('claude-sonnet-5-5');
    expect(opts.effort).toBe('medium');
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.env?.DATABASE_URL).toBeUndefined();
    expect(opts.tools).toEqual(['WebSearch', 'Agent']);
    expect(opts.settingSources).toEqual([]);
    expect(Object.keys(opts.agents as object)).toEqual(['leger', 'expert']);

    const row = await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run.id) });
    expect(row?.status).toBe('done');
    expect(row?.computeSource).toBe('subscription');
    const reply = await t.ctx.db.query.messages.findFirst({ where: and(eq(messages.runId, run.id), eq(messages.authorKind, 'bot')) });
    expect(reply?.content).toBe('Bonjour !');
    expect(reply?.status).toBe('done');
    expect(reply?.meta.computeSource).toBe('subscription');
    const usage = await t.ctx.db.select().from(runModelUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.computeSource).toBe('subscription');
    const session = await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) });
    expect(session?.sdkSessionId).toBe('sess-a');
    expect(session?.approxTokens).toBe(10_500);
  });

  it('resumes the session on the next message', async () => {
    const { bot, run } = await dmRun();
    const first = fakeQuery(async function* () {
      yield sdk.init('sess-r');
      yield sdk.assistant('Un', 'sess-r');
      yield sdk.result('Un', 0.01, 'claude-sonnet-5-5', 'sess-r');
    });
    await executeRun(workerDeps(t.ctx, first.query), run.id, new AbortController().signal);
    const msg = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: 'Et ensuite ?' });
    const [run2] = await dispatchUserMessage(t.ctx, msg);
    const second = fakeQuery(async function* () {
      yield sdk.assistant('Deux', 'sess-r');
      yield sdk.result('Deux', 0.01, 'claude-sonnet-5-5', 'sess-r');
    });
    await executeRun(workerDeps(t.ctx, second.query), run2!.id, new AbortController().signal);
    expect(second.calls[0]!.options.resume).toBe('sess-r');
    expect(second.calls[0]!.prompt).toContain('Et ensuite ?');
  });

  it('switches to API credits when the subscription is rejected mid-run, then resumes', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const { run } = await dmRun();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const { query, calls } = fakeQuery(async function* (_call, index) {
      if (index === 0) {
        yield sdk.init('sess-s');
        yield sdk.delta('Je commence', 'sess-s');
        yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-s');
        yield sdk.result('', 0.002, 'claude-sonnet-5-5', 'sess-s');
        return;
      }
      yield sdk.assistant('Terminé sur les crédits API.', 'sess-s');
      yield sdk.result('Terminé sur les crédits API.', 0.03, 'claude-sonnet-5-5', 'sess-s');
    });
    const res = await executeRun(workerDeps(t.ctx, query), run.id, new AbortController().signal);
    expect(res.outcome).toBe('done');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.env?.ANTHROPIC_API_KEY).toBeDefined();
    expect(calls[1]!.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(calls[1]!.options.resume).toBe('sess-s');
    expect(calls[1]!.options.maxBudgetUsd).toBe(2);

    const state = await getComputeState(t.ctx);
    expect(state.subLimitedUntil?.getTime()).toBe(resetsAt * 1000);
    const switchMsg = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    expect(switchMsg.some((m) => m.meta.kind === 'compute_switch' && m.content.includes('crédits API'))).toBe(true);
    const usage = await t.ctx.db.select().from(runModelUsage);
    expect(usage.map((u) => u.computeSource).sort()).toEqual(['api', 'subscription']);
    const row = await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run.id) });
    expect(row?.computeSource).toBe('api');
  });

  it('pauses and defers when no compute source is available', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const { run } = await dmRun();
    await patchComputeState(t.ctx, { subLimitedUntil: new Date(Date.now() + 3600_000) });
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0, 'x');
    });
    const deps = workerDeps(t.ctx, query, { cfg: { ANTHROPIC_API_KEY: undefined } });
    const res = await executeRun(deps, run.id, new AbortController().signal);
    expect(res.outcome).toBe('deferred');
    expect(calls).toHaveLength(0);
    const row = await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run.id) });
    expect(row?.status).toBe('paused');
    const state = await getComputeState(t.ctx);
    expect(state.allPausedReason).toBeTruthy();
    const info = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    expect(info.some((m) => m.content.startsWith('⏸️'))).toBe(true);
  });

  it('hybrid mode routes autonomous work to the API and drops heartbeats when impossible', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const routineRun = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      trigger: 'routine',
      priority: 'background',
      origin: 'autonomous',
      prompt: 'Point hebdo',
    });
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.assistant('Point fait.');
      yield sdk.result('Point fait.', 0.02);
    });
    await executeRun(workerDeps(t.ctx, query), routineRun!.id, new AbortController().signal);
    expect(calls[0]!.options.env?.ANTHROPIC_API_KEY).toBeDefined();

    const hb = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      threadKey: `heartbeat:${bot.id}`,
      trigger: 'heartbeat',
      priority: 'background',
      origin: 'autonomous',
      prompt: 'hb',
    });
    const res = await executeRun(workerDeps(t.ctx, query, { cfg: { ANTHROPIC_API_KEY: undefined } }), hb!.id, new AbortController().signal);
    expect(res.outcome).toBe('cancelled');
  });

  it('enforces the sub-agent rules in the PreToolUse hook', async () => {
    await updateSettings(t.ctx.db, { expertDailyLimit: 1 });
    const { run } = await dmRun();
    const decisions: unknown[] = [];
    const { query } = fakeQuery(async function* (call) {
      const hook = call.options.hooks!.PreToolUse![0]!.hooks[0]!;
      const fire = (input: Record<string, unknown>) =>
        hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' }, 't', { signal: new AbortController().signal });
      decisions.push(await fire({ subagent_type: 'expert', description: 'Analyse du bug', prompt: 'x' }));
      decisions.push(await fire({ subagent_type: 'general-purpose', description: 'x — raison : y', prompt: 'x' }));
      decisions.push(await fire({ subagent_type: 'expert', description: 'Revue d’architecture — raison : décision difficile à défaire', prompt: 'x', model: 'haiku', run_in_background: true }));
      decisions.push(await fire({ subagent_type: 'expert', description: 'Encore — raison : test de limite', prompt: 'x' }));
      decisions.push(await fire({ subagent_type: 'leger', description: 'Tri des mails — raison : tâche mécanique', prompt: 'x' }));
      yield sdk.assistant('ok');
      yield sdk.result('ok', 0.01);
    });
    await executeRun(workerDeps(t.ctx, query), run.id, new AbortController().signal);
    const d = decisions as { hookSpecificOutput: { permissionDecision: string; updatedInput?: Record<string, unknown> } }[];
    expect(d[0]!.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(d[1]!.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(d[2]!.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(d[2]!.hookSpecificOutput.updatedInput).toEqual({
      description: 'Revue d’architecture — raison : décision difficile à défaire',
      prompt: 'x',
      subagent_type: 'expert',
      run_in_background: false,
    });
    expect(d[3]!.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(d[4]!.hookSpecificOutput.permissionDecision).toBe('allow');
    const delegations = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    const labels = delegations.filter((m) => m.meta.kind === 'delegation').map((m) => m.meta.subagent?.model);
    expect(labels).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    const auditRows = await t.ctx.db.select().from(auditLog).where(eq(auditLog.event, 'subagent.start'));
    expect(auditRows).toHaveLength(2);
  });

  it('turns @mentions in a group channel into hand-offs, with the loop guard', async () => {
    await updateSettings(t.ctx.db, { maxHandoffHops: 1 });
    const a = await createBot(t.ctx, { name: 'Chef', role: 'coordination' });
    const b = await createBot(t.ctx, { name: 'Dev', role: 'développement' });
    const channel = await createGroupChannel(t.ctx, { name: 'projet', botIds: [a.id, b.id] });
    const msg = await createMessage(t.ctx, { channelId: channel.id, authorKind: 'user', content: '@chef organise le travail' });
    const [run] = await dispatchUserMessage(t.ctx, msg);
    expect(run?.botId).toBe(a.id);
    const { query } = fakeQuery(async function* () {
      yield sdk.assistant('@dev peux-tu corriger le bug de connexion ?');
      yield sdk.result('', 0.01);
    });
    await executeRun(workerDeps(t.ctx, query), run!.id, new AbortController().signal);
    const devRun = await t.ctx.db.query.runs.findFirst({ where: and(eq(runs.botId, b.id), eq(runs.trigger, 'handoff')) });
    expect(devRun?.hop).toBe(1);
    const chefRun = await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) });
    expect(devRun?.chainId).toBe(chefRun?.chainId);
    expect(devRun?.origin).toBe('user');
    expect(await t.ctx.db.select().from(handoffs)).toHaveLength(1);

    // Dev answers by mentioning Chef: hop limit (1) reached → blocked.
    const back = fakeQuery(async function* () {
      yield sdk.assistant('@chef c’est corrigé, à toi.');
      yield sdk.result('', 0.01);
    });
    await executeRun(workerDeps(t.ctx, back.query), devRun!.id, new AbortController().signal);
    const blocked = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    expect(blocked.some((m) => m.content.includes('bloqué'))).toBe(true);
    expect(await t.ctx.db.select().from(handoffs)).toHaveLength(1);
  });

  it('sends risky commands and sensitive clicks to approval, then executes exactly what was approved', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    const execCalls: unknown[] = [];
    const computer = stubComputer({
      exec: async (req: unknown) => {
        execCalls.push(req);
        return { exitCode: 0, stdout: 'pushed', stderr: '', timedOut: false, truncated: false, durationMs: 3 };
      },
      browser: async () => ({ ok: true, url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' }),
      inspect: async () => ({ url: 'https://www.linkedin.com/feed/', title: 'LinkedIn', elementLabel: 'Publier', screenshotPng: 'iVBOR' }),
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    const runRow = (await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) }))!;
    const botRow = (await t.ctx.db.query.bots.findFirst())!;
    const rc: RunContext = {
      deps,
      settings: DEFAULT_SETTINGS,
      run: runRow,
      bot: botRow,
      permissions: DEFAULT_BOT_PERMISSIONS,
      channel: null,
      computeSource: 'subscription',
      pendingApprovals: [],
      botsBySlug: new Map(),
      setActivity: async () => undefined,
    };
    const tools = antTools(rc);
    const exec = tools.find((x) => x.name === 'computer_exec')!;
    const safe = await exec.handler({ command: 'ls -la' }, {});
    expect(JSON.stringify(safe)).toContain('pushed');
    const risky = await exec.handler({ command: 'git push origin main' }, {});
    expect(JSON.stringify(risky)).toContain('validation');
    expect(execCalls).toHaveLength(1);
    const browser = tools.find((x) => x.name === 'browser')!;
    const click = await browser.handler({ action: 'click', ref: 'e7' }, {});
    expect(JSON.stringify(click)).toContain('validation');
    const pending = await t.ctx.db.select().from(approvals);
    expect(pending.map((p) => p.category).sort()).toEqual(['commande_risquee', 'navigateur_sensible']);
    const clickApproval = pending.find((p) => p.tool === 'browser')!;
    expect(clickApproval.payload.expectedLabel).toBe('Publier');
    expect(clickApproval.screenshotPng).toBe('iVBOR');

    const execApproval = pending.find((p) => p.tool === 'computer_exec')!;
    await setApprovalStatus(t.ctx, execApproval.id, 'approved');
    expect(await executeApproval(deps, execApproval.id)).toBe('executed');
    expect(execCalls[1]).toMatchObject({ command: 'git push origin main' });
    const followUp = await t.ctx.db.query.runs.findFirst({ where: eq(runs.trigger, 'approval') });
    expect(followUp?.prompt).toContain('pushed');
    // An approval cannot be executed twice.
    expect(await executeApproval(deps, execApproval.id)).toContain('rien à exécuter');
    expect(await t.ctx.db.select().from(jobs)).not.toHaveLength(0);
  });

  it('records rate-limit utilisation from events', async () => {
    const { run } = await dmRun();
    const { query } = fakeQuery(async function* (): AsyncGenerator<SDKMessage> {
      yield sdk.rateLimit('allowed_warning', { rateLimitType: 'five_hour', utilization: 0.62, resetsAt: Math.floor(Date.now() / 1000) + 600 });
      yield sdk.rateLimit('allowed', { rateLimitType: 'seven_day', utilization: 0.3 });
      yield sdk.assistant('ok');
      yield sdk.result('ok', 0.01);
    });
    await executeRun(workerDeps(t.ctx, query), run.id, new AbortController().signal);
    const state = await getComputeState(t.ctx);
    expect(state.subFiveHourUtil).toBe(62);
    expect(state.subSevenDayUtil).toBe(30);
  });
});
