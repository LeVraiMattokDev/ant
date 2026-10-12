import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { RunContext } from '../run-context';
import { approvalTools } from './approvals';
import { computerTools } from './computer';
import { memoryTools } from './memory';
import { messagingTools } from './messaging';
import { nudgeTools } from './nudges';
import { routineTools } from './routines';
import { taskTools } from './tasks';

export const ANT_SERVER = 'ant';

export function mcpToolName(name: string): string {
  return `mcp__${ANT_SERVER}__${name}`;
}

/** Tools a light sub-agent may use (read-only). */
export const LIGHT_SUBAGENT_TOOLS = ['memory_search', 'search_messages', 'file_read', 'file_list', 'task_list'];

/** Tool definitions available to a run (depends on the bot's permissions and the trigger). */
export function antTools(rc: RunContext) {
  return [
    ...messagingTools(rc),
    ...memoryTools(rc),
    ...taskTools(rc),
    ...computerTools(rc),
    ...approvalTools(rc),
    ...routineTools(rc),
    ...(rc.run.trigger === 'heartbeat' ? nudgeTools(rc) : []),
  ];
}

export function createAntServer(rc: RunContext) {
  const tools = antTools(rc);
  const server = createSdkMcpServer({ name: ANT_SERVER, version: '0.1.0', tools });
  return { server, toolNames: tools.map((t) => t.name) };
}
