import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function okWithImage(text: string, base64: string, mimeType = 'image/png'): CallToolResult {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: base64, mimeType },
    ],
  };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Runs a tool body and turns thrown errors into tool errors the model can read. */
export async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(`Erreur : ${(err as Error).message}`);
  }
}

export function clip(text: string, max = 30_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} caractères tronqués]` : text;
}
