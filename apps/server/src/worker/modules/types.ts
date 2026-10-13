import type { SDKUserMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings, BotPermissions, MessageAttachment, RunTrigger } from '@ant/shared';
import type { JobKind, JobRow } from '../../lib/jobs';
import type { BotRow } from '../../services/bots';
import type { ChannelRow } from '../../services/channels';
import type { RunRow } from '../../services/runs';
import type { WorkerDeps } from '../deps';
import type { RunContext } from '../run-context';

/** An MCP tool offered to the bots (what `tool()` of the Agent SDK returns; same element type as createSdkMcpServer's `tools`). */
export type AntTool = SdkMcpToolDefinition<any>;

/**
 * A run that reached its final state, given to `afterRun`. Every final state goes through the hooks: the normal end
 * of a run, and the runs closed before or without executing — cancelled while queued or paused (by the owner, the
 * emergency stop, a newer routine occurrence), bot paused or archived, conversation archived, autonomous work dropped
 * after waiting for compute, job failed for good, orphan run. Those have no answer (`finalText` empty).
 */
export interface FinishedRun {
  run: RunRow;
  bot: BotRow;
  /** Null when the run has no conversation, or its conversation was archived. */
  channel: ChannelRow | null;
  status: 'done' | 'error' | 'cancelled';
  /** What started the work: `effectiveTrigger(run)` (services/runs.ts), the original trigger for a continuation. */
  trigger: RunTrigger;
  /** The bot's final answer (empty when it gave none). */
  finalText: string;
  error: string | null;
  /**
   * True when the runner posted no reply message (heartbeat, or a module's `silentRun`): the module that made the run
   * silent posts the answer itself (see docs/API.md « Exécutions silencieuses »), and the others must not announce it.
   */
  silent: boolean;
  /** Reply message posted in the conversation (null for silent runs, or when none was posted). */
  responseMessageId: string | null;
  /** Files the bot attached to its answer (rc.outputs.attachments); already in the reply's meta unless `silent`. */
  attachments: MessageAttachment[];
  /** Start of the work: the run's first start, or for a continuation that of the first run of the chain. */
  startedAt: Date;
  /** From `startedAt` to the end: the whole task, automatic continuations included. */
  durationMs: number;
  /** The step limit was reached and a follow-up run continues the work: the task is not over yet. */
  continued: boolean;
}

/**
 * A feature module of the worker (docs/ARCHITECTURE.md « Évolutions »). Each team fills in its own module file;
 * the runner, the scheduler and the job pump call every module through worker/modules/index.ts, so no team has to
 * edit those shared files. Every hook is optional, and a hook that throws is logged without stopping the others.
 * A module file must not import worker/tools/index.ts nor worker/runner.ts (they import the registry: import cycle);
 * tools/helpers.ts and the services are fine.
 */
export interface WorkerModule {
  readonly name: string;

  // ── Tools ──
  /** MCP tools offered to a run (check rc.permissions / rc.run.trigger yourself). */
  tools?(rc: RunContext): AntTool[];
  /** Names (without the mcp__ant__ prefix) of this module's read-only tools also given to the light sub-agent. */
  readonly lightSubagentTools?: readonly string[];
  /** « Dev <label> » activity shown while one of this module's tools runs, by tool name. */
  readonly toolActivity?: Readonly<Record<string, string>>;
  /**
   * Extra section of the bot's static system prompt (how and when to use this module's tools). It must depend only
   * on the bot and its permissions: the static prompt is cached across runs.
   */
  systemPromptSection?(bot: BotRow, permissions: BotPermissions): string | null;

  // ── Runs ──
  /** « Déclencheur » line of the run context for the triggers this module owns; null = not mine. */
  describeTrigger?(run: RunRow): string | null;
  /** Prompt body (after the conversation context `head`) for the triggers this module owns; null = not mine. */
  buildPrompt?(run: RunRow, head: string): string | null;
  /**
   * True when no reply message must be created up front: the module then posts the answer itself in its afterRun
   * (`finished.silent`), with `runId`, its attachments and `updateRun(responseMessageId)` — or nothing when
   * `isSilentNothing(finalText)` (docs/API.md « Exécutions silencieuses »).
   */
  silentRun?(deps: WorkerDeps, run: RunRow): Promise<boolean>;
  /** Replaces the text prompt by SDK user messages (images, PDF blocks); null = keep the text. */
  userMessage?(rc: RunContext, prompt: string): Promise<AsyncIterable<SDKUserMessage> | null>;
  /**
   * After a run reached its final state (completion push, handoff return, silent answer). Called for every final state,
   * runs closed without executing included (see FinishedRun); normally once per run, but a restart at the wrong moment
   * may call it again: keep it idempotent.
   */
  afterRun?(deps: WorkerDeps, settings: AppSettings, finished: FinishedRun): Promise<void>;

  // ── Background ──
  /** Handlers of this module's job kinds (claimed with the auxiliary jobs, 3 at a time). */
  readonly jobs?: Partial<Record<JobKind, (deps: WorkerDeps, job: JobRow) => Promise<void>>>;
  /** Every scheduler pass (30 s). Check settings.emergencyStop before starting any work. */
  onSchedulerTick?(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void>;
  /** Hourly maintenance (purges). */
  onMaintenance?(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void>;
  /** Once, when the worker starts (after the database is migrated). */
  onStart?(deps: WorkerDeps): Promise<void>;
}
