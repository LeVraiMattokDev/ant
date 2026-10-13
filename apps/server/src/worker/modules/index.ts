import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings, BotPermissions } from '@ant/shared';
import type { JobKind, JobRow } from '../../lib/jobs';
import { logger } from '../../lib/logger';
import type { BotRow } from '../../services/bots';
import type { RunRow } from '../../services/runs';
import type { WorkerDeps } from '../deps';
import type { RunContext } from '../run-context';
import { capabilitiesModule } from './capabilities';
import { inputsModule } from './inputs';
import { opsModule } from './ops';
import { trackingModule } from './tracking';
import type { AntTool, FinishedRun, WorkerModule } from './types';

export type { AntTool, FinishedRun, WorkerModule } from './types';

/** The feature modules, in a fixed order (tracking, ops, inputs, capabilities). */
export const WORKER_MODULES: readonly WorkerModule[] = [trackingModule, opsModule, inputsModule, capabilitiesModule];

async function guard<T>(module: WorkerModule, hook: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, module: module.name, hook }, 'feature module hook failed');
    return fallback;
  }
}

/** Same isolation for the synchronous hooks: one module's bug must not fail every run of every bot. */
function guardSync<T>(module: WorkerModule, hook: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    logger.error({ err, module: module.name, hook }, 'feature module hook failed');
    return fallback;
  }
}

export function moduleTools(rc: RunContext, modules: readonly WorkerModule[] = WORKER_MODULES): AntTool[] {
  return modules.flatMap((m) => (m.tools ? guardSync(m, 'tools', () => m.tools!(rc) ?? [], []) : []));
}

export function moduleLightSubagentTools(modules: readonly WorkerModule[] = WORKER_MODULES): string[] {
  return modules.flatMap((m) => guardSync(m, 'lightSubagentTools', () => [...(m.lightSubagentTools ?? [])], []));
}

export function moduleToolActivity(toolName: string, modules: readonly WorkerModule[] = WORKER_MODULES): string | null {
  for (const m of modules) {
    const label = guardSync(m, 'toolActivity', () => m.toolActivity?.[toolName], undefined);
    if (label) return label;
  }
  return null;
}

export function moduleSystemPromptSections(bot: BotRow, permissions: BotPermissions, modules: readonly WorkerModule[] = WORKER_MODULES): string[] {
  return modules
    .map((m) => (m.systemPromptSection ? guardSync(m, 'systemPromptSection', () => m.systemPromptSection!(bot, permissions), null) : null))
    .filter((s): s is string => Boolean(s?.trim()));
}

export function moduleDescribeTrigger(run: RunRow, modules: readonly WorkerModule[] = WORKER_MODULES): string | null {
  for (const m of modules) {
    const d = m.describeTrigger ? guardSync(m, 'describeTrigger', () => m.describeTrigger!(run), null) : null;
    if (d) return d;
  }
  return null;
}

export function moduleBuildPrompt(run: RunRow, head: string, modules: readonly WorkerModule[] = WORKER_MODULES): string | null {
  for (const m of modules) {
    const p = m.buildPrompt ? guardSync(m, 'buildPrompt', () => m.buildPrompt!(run, head), null) : null;
    if (p !== null && p !== undefined) return p;
  }
  return null;
}

export async function moduleSilentRun(deps: WorkerDeps, run: RunRow, modules: readonly WorkerModule[] = WORKER_MODULES): Promise<boolean> {
  for (const m of modules) {
    if (!m.silentRun) continue;
    if (await guard(m, 'silentRun', () => m.silentRun!(deps, run), false)) return true;
  }
  return false;
}

/** The first module that turns the prompt into SDK user messages wins; otherwise the text prompt is sent. */
export async function moduleUserMessage(
  rc: RunContext,
  prompt: string,
  modules: readonly WorkerModule[] = WORKER_MODULES,
): Promise<AsyncIterable<SDKUserMessage> | null> {
  for (const m of modules) {
    if (!m.userMessage) continue;
    const input = await guard(m, 'userMessage', () => m.userMessage!(rc, prompt), null);
    if (input) return input;
  }
  return null;
}

export async function runAfterRunHooks(deps: WorkerDeps, settings: AppSettings, finished: FinishedRun, modules: readonly WorkerModule[] = WORKER_MODULES): Promise<void> {
  for (const m of modules) {
    if (m.afterRun) await guard(m, 'afterRun', () => m.afterRun!(deps, settings, finished), undefined);
  }
}

export async function runSchedulerHooks(deps: WorkerDeps, settings: AppSettings, now: Date, modules: readonly WorkerModule[] = WORKER_MODULES): Promise<void> {
  for (const m of modules) {
    if (m.onSchedulerTick) await guard(m, 'onSchedulerTick', () => m.onSchedulerTick!(deps, settings, now), undefined);
  }
}

export async function runMaintenanceHooks(deps: WorkerDeps, settings: AppSettings, now: Date, modules: readonly WorkerModule[] = WORKER_MODULES): Promise<void> {
  for (const m of modules) {
    if (m.onMaintenance) await guard(m, 'onMaintenance', () => m.onMaintenance!(deps, settings, now), undefined);
  }
}

export async function runStartHooks(deps: WorkerDeps, modules: readonly WorkerModule[] = WORKER_MODULES): Promise<void> {
  for (const m of modules) {
    if (m.onStart) await guard(m, 'onStart', () => m.onStart!(deps), undefined);
  }
}

/** Job kinds some module handles (claimed with the auxiliary jobs). */
export function moduleJobKinds(modules: readonly WorkerModule[] = WORKER_MODULES): JobKind[] {
  return [...new Set(modules.flatMap((m) => Object.keys(m.jobs ?? {}) as JobKind[]))];
}

/** Unlike the other hooks, a job handler's error propagates: the job queue records it and retries. */
export function moduleJobHandler(kind: JobKind, modules: readonly WorkerModule[] = WORKER_MODULES): ((deps: WorkerDeps, job: JobRow) => Promise<void>) | null {
  for (const m of modules) {
    const handler = m.jobs?.[kind];
    if (handler) return handler;
  }
  return null;
}
