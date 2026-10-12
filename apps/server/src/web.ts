process.env.ANT_SERVICE ??= 'web';
const { loadWebConfig } = await import('./config');
const { createDatabase, runMigrations } = await import('./db/client');
const { logger } = await import('./lib/logger');
const { randomToken } = await import('./lib/crypto');
const { ComputerClient } = await import('./services/computer-client');
const { PushSender } = await import('./services/push');
const { buildApp } = await import('./web/app');
const { owner } = await import('./db/schema');
const { eq } = await import('drizzle-orm');

const cfg = loadWebConfig();
await runMigrations(cfg.DATABASE_URL, cfg.MIGRATIONS_DIR);
const database = createDatabase(cfg.DATABASE_URL, 15);
const ctx = { db: database.db, sql: database.sql };
const origin = new URL(cfg.PUBLIC_ORIGIN);

const existing = await ctx.db.query.owner.findFirst({ where: eq(owner.id, 1) });
const setupToken = { value: existing?.totpEnabled ? null : (cfg.SETUP_TOKEN ?? randomToken(18)) };
if (setupToken.value) {
  logger.warn(`Ant n’est pas encore configuré. Ouvre ${cfg.PUBLIC_ORIGIN}/setup avec le jeton d’initialisation : ${setupToken.value}`);
}
if (origin.protocol !== 'https:') {
  logger.warn('PUBLIC_ORIGIN n’est pas en HTTPS : cookies non sécurisés et passkeys indisponibles hors localhost. Réservé au développement.');
}

const { app, hub } = await buildApp({
  ctx,
  cfg,
  session: { secureCookies: origin.protocol === 'https:', idleHours: cfg.SESSION_IDLE_HOURS, absoluteDays: cfg.SESSION_ABSOLUTE_DAYS },
  push: new PushSender(ctx, { publicKey: cfg.VAPID_PUBLIC_KEY, privateKey: cfg.VAPID_PRIVATE_KEY, subject: cfg.VAPID_SUBJECT }),
  computer: new ComputerClient(cfg.COMPUTER_URL, cfg.COMPUTER_RPC_TOKEN),
  setupToken,
  rpID: origin.hostname,
});

await app.listen({ port: cfg.PORT, host: cfg.HOST });

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void (async () => {
      await hub.close().catch(() => undefined);
      await app.close().catch(() => undefined);
      await database.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}
export {};
