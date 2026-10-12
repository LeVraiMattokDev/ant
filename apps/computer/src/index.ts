import { mkdir } from 'node:fs/promises';
import { BrowserManager } from './browser/browser';
import { ConfigError, loadConfig, type Config } from './config';
import { createComputerServer } from './server';

let cfg: Config;
try {
  cfg = loadConfig(process.env);
} catch (err) {
  console.error(`[computer] ${err instanceof ConfigError ? err.message : String(err)}`);
  process.exit(1);
}
// Children get an explicit minimal env anyway; also drop the token from our own env as a precaution.
delete process.env.COMPUTER_RPC_TOKEN;

await mkdir(cfg.workspaceRoot, { recursive: true });

const browser = new BrowserManager(cfg);
const server = createComputerServer({ cfg, browser });

server.listen(cfg.port, () => {
  console.log(
    `[computer] à l'écoute sur :${cfg.port} — espace de travail ${cfg.workspaceRoot}, écran ${cfg.display}${cfg.headless ? ' (navigateur headless)' : ''}`,
  );
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[computer] ${signal} reçu, arrêt…`);
  const force = setTimeout(() => process.exit(0), 10_000);
  force.unref();
  server.close();
  server.closeAllConnections();
  await browser.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
