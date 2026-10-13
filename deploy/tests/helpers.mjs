// Outils communs aux tests des scripts de déploiement (node --test deploy/tests/*.test.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dossier des scripts testés (ANT_DEPLOY_DIR permet de rejouer les tests sur une autre version). */
export const DEPLOY_DIR = process.env.ANT_DEPLOY_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(DEPLOY_DIR, '..');

/** PostgreSQL de test : mêmes valeurs par défaut que les tests d'intégration du serveur. */
export const PG_ENV = {
  PGHOST: process.env.PGHOST ?? 'localhost',
  PGPORT: process.env.PGPORT ?? '5432',
  PGUSER: process.env.PGUSER ?? 'postgres',
};

export function tempDir(t, prefix = 'ant-deploy-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

export function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

export function psql(db, sql) {
  const r = run('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { env: { ...process.env, ...PG_ENV } });
  if (r.status !== 0) throw new Error(`psql ${db} : ${r.stderr}`);
  return r.stdout.trim();
}

let pgAvailable;
export function hasPostgres() {
  if (pgAvailable === undefined) {
    pgAvailable =
      !!which('pg_dump') &&
      !!which('pg_restore') &&
      run('psql', ['-X', '-tAc', 'select 1', '-d', 'postgres'], { env: { ...process.env, ...PG_ENV } }).stdout?.trim() === '1';
  }
  return pgAvailable;
}

/** Base de test au nom unique, supprimée (avec ses dérivées) à la fin du test. */
export function createTestDb(t, prefix, suffixes = []) {
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  psql('postgres', `CREATE DATABASE "${name}"`);
  t.after(() => {
    for (const db of [name, ...suffixes.map((s) => `${name}${s}`)]) {
      try {
        psql('postgres', `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      } catch {
        // déjà supprimée
      }
    }
  });
  return name;
}

/**
 * Lance une commande en arrière-plan dans son propre groupe de processus, en gardant sa sortie.
 * kill() vise tout le groupe : un sleep orphelin ne peut pas bloquer le test en gardant la sortie ouverte.
 */
export function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  const out = { stdout: '', stderr: '', code: undefined, signal: undefined, child };
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  out.exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      out.code = code;
      out.signal = signal;
      resolve();
    }),
  );
  // Sorties lues jusqu'au bout (après « exit », des données peuvent encore arriver).
  out.closed = new Promise((resolve) => child.on('close', resolve));
  out.kill = (signal = 'SIGKILL') => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // groupe déjà terminé
    }
  };
  return out;
}

/** Exécute un script jusqu'au bout (au plus timeoutMs) : { status, stdout, stderr }. */
export async function runScript(cmd, args, opts = {}, timeoutMs = 60_000) {
  const proc = start(cmd, args, opts);
  const finished = await Promise.race([proc.exited.then(() => true), deadline(timeoutMs).then(() => false)]);
  if (finished) await Promise.race([proc.closed, deadline(1000)]);
  proc.kill();
  if (!finished) throw new Error(`${cmd} ${args.join(' ')} : toujours en cours après ${timeoutMs} ms\n${proc.stderr}`);
  return { status: proc.code, stdout: proc.stdout, stderr: proc.stderr };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Délai qui ne retient pas le processus de test (pour les courses contre la fin d'une commande). */
const deadline = (ms) => new Promise((r) => setTimeout(r, ms).unref());

export async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`délai dépassé : ${what}`);
}

/** Attend la fin d'un processus lancé par start(), au plus timeoutMs ; renvoie false s'il tourne encore. */
export async function exitsWithin(proc, timeoutMs) {
  const exited = await Promise.race([proc.exited.then(() => true), deadline(timeoutMs).then(() => false)]);
  if (exited) await Promise.race([proc.closed, deadline(1000)]);
  return exited;
}
