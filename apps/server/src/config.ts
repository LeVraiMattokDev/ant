import { z } from 'zod';

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  MIGRATIONS_DIR: z.string().default(new URL('../drizzle', import.meta.url).pathname),
  COMPUTER_URL: z.string().url().default('http://computer:7000'),
  COMPUTER_RPC_TOKEN: optionalSecret,
  VAPID_PUBLIC_KEY: optionalSecret,
  VAPID_PRIVATE_KEY: optionalSecret,
  VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:8080'),
});

const webSchema = baseSchema.extend({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY doit contenir au moins 32 caractères'),
  SETUP_TOKEN: optionalSecret,
  UI_DIST: z.string().default(new URL('../../ui/dist', import.meta.url).pathname),
  /** Trust X-Forwarded-For: 'true', 'false', or the IP/CIDR of Nginx Proxy Manager (recommended). */
  TRUST_PROXY: z.string().default('true'),
  SESSION_IDLE_HOURS: z.coerce.number().default(12),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().default(30),
});

const workerSchema = baseSchema.extend({
  CLAUDE_CODE_OAUTH_TOKEN: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  /** Where Claude Code keeps its configuration and session transcripts (persistent volume). */
  CLAUDE_CONFIG_DIR: z.string().default('/data/claude'),
  /** Empty working directory for agent runs: agents never touch the worker's filesystem. */
  AGENT_CWD: z.string().default('/data/agent-cwd'),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  /** Optional absolute path to a Claude Code executable (defaults to the one bundled with the SDK). */
  CLAUDE_CODE_EXECUTABLE: optionalSecret,
});

export type WebConfig = z.infer<typeof webSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type BaseConfig = z.infer<typeof baseSchema>;

function parse<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${issues}`);
  }
  return result.data;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  return parse(webSchema, env);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return parse(workerSchema, env);
}

export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  return parse(baseSchema, env);
}

/** Values that must never appear in logs or the audit log. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ENCRYPTION_KEY',
    'COMPUTER_RPC_TOKEN',
    'VAPID_PRIVATE_KEY',
    'SETUP_TOKEN',
    'POSTGRES_PASSWORD',
  ];
  const values = keys.map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v.length >= 6);
  const dbUrl = env.DATABASE_URL;
  if (dbUrl) {
    try {
      const pw = new URL(dbUrl).password;
      if (pw.length >= 6) values.push(decodeURIComponent(pw));
    } catch {
      // ignore malformed URL, config validation reports it
    }
  }
  return values;
}
