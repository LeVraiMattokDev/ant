process.env.ANT_SERVICE ??= 'worker';
const { loadWorkerConfig } = await import('./config');
const { logger } = await import('./lib/logger');
const { startWorker } = await import('./worker/main');

const cfg = loadWorkerConfig();
if (!cfg.CLAUDE_CODE_OAUTH_TOKEN && !cfg.ANTHROPIC_API_KEY) {
  logger.warn('Aucun identifiant Claude (CLAUDE_CODE_OAUTH_TOKEN ni ANTHROPIC_API_KEY) : les bots resteront en pause.');
}
const handle = await startWorker(cfg);

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker stopping');
    handle
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, 'worker stop failed');
        process.exit(1);
      });
  });
}
export {};
