import { BROWSER_ACTIONS } from '@ant/shared';
import { z } from 'zod';

/** Runtime validation of the RPC bodies (types mirror `@ant/shared` computer.ts). */

const path = z.string().max(4096);

export const execSchema = z.object({
  command: z.string().min(1, 'commande vide').max(1_000_000),
  cwd: path.optional(),
  timeoutSec: z.number().positive().optional(),
});

export const fileReadSchema = z.object({
  path: path.min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});

export const fileWriteSchema = z.object({
  path: path.min(1),
  content: z.string(),
  append: z.boolean().optional(),
});

export const fileEditSchema = z.object({
  path: path.min(1),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const fileListSchema = z.object({ path: path.optional() });

export const fileDeleteSchema = z.object({ path: path.min(1) });

const target = {
  ref: z.string().max(32).optional(),
  selector: z.string().max(2000).optional(),
  /** From a previous `inspect` (format checked by `pinSelector`). */
  pin: z.string().max(64).optional(),
};

export const browserSchema = z.object({
  action: z.enum(BROWSER_ACTIONS),
  url: z.string().max(8192).optional(),
  ...target,
  text: z.string().max(100_000).optional(),
  key: z.string().max(64).optional(),
  direction: z.enum(['up', 'down']).optional(),
  screenshot: z.boolean().optional(),
});

export const inspectSchema = z.object(target);

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join('.') : 'corps'} : ${i.message}`)
    .slice(0, 5)
    .join(' ; ');
}
