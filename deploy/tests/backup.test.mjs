// deploy/backup.sh, exécuté avec /bin/sh contre le PostgreSQL de test (busybox ash dans l'image postgres:17-alpine).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEPLOY_DIR,
  PG_ENV,
  createTestDb,
  exitsWithin,
  hasPostgres,
  psql,
  run,
  runScript,
  sleep,
  start,
  tempDir,
  waitFor,
  which,
  writeExecutable,
} from './helpers.mjs';

const SCRIPT = join(DEPLOY_DIR, 'backup.sh');
const noPg = hasPostgres() ? false : 'PostgreSQL de test indisponible (localhost:5432, utilisateur postgres)';
const today = run('date', ['+%F']).stdout.trim();

/** Base qui ressemble à celle d'Ant : table des migrations de drizzle et une table de données. */
function antLikeDb(t) {
  const db = createTestDb(t, 'ant_backup_test');
  psql(
    db,
    `CREATE SCHEMA drizzle;
     CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
     INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('0000', 1);
     CREATE TABLE notes (id int PRIMARY KEY, body text);
     INSERT INTO notes VALUES (1, 'avant');`,
  );
  return db;
}

/** Dossiers de travail + un pg_dump de remplacement qui compte ses appels. */
function setup(t, pgDumpBody) {
  const dir = tempDir(t);
  const backups = join(dir, 'backups');
  const state = join(dir, 'state');
  const bin = join(dir, 'bin');
  for (const d of [backups, state, bin]) mkdirSync(d);
  const calls = join(dir, 'pg_dump.calls');
  if (pgDumpBody) {
    writeExecutable(
      join(bin, 'pg_dump'),
      `#!/bin/sh\necho call >> "${calls}"\nn=$(wc -l < "${calls}")\nREAL_PG_DUMP="${which('pg_dump') ?? 'pg_dump'}"\n${pgDumpBody}\n`,
    );
  }
  const env = (db, extra = {}) => ({
    ...process.env,
    ...PG_ENV,
    PGDATABASE: db,
    PATH: `${bin}:${process.env.PATH}`,
    BACKUP_PATH: backups,
    BACKUP_STATE_DIR: state,
    BACKUP_HOUR: '0',
    BACKUP_INTERVAL: '0.2',
    ...extra,
  });
  const callCount = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  return { dir, backups, state, env, callCount };
}

const check = (env) => runScript('sh', [SCRIPT, '--check'], { env }, 10_000);

test('un pg_dump en échec est retenté, puis la sauvegarde est vérifiée et réservée à root', { skip: noPg }, async (t) => {
  const db = antLikeDb(t);
  // 1er appel : base injoignable (redémarrage pendant une mise à jour) ; ensuite, le vrai pg_dump.
  const s = setup(t, 'if [ "$n" -eq 1 ]; then echo "connexion refusée" >&2; exit 1; fi\nexec "$REAL_PG_DUMP" "$@"');
  const proc = start('sh', [SCRIPT], { env: s.env(db) });
  t.after(() => proc.kill());
  const dump = join(s.backups, `ant-${today}.dump`);
  await waitFor(() => existsSync(dump), 15_000, 'sauvegarde du jour après la nouvelle tentative');
  await sleep(300);
  proc.child.kill('SIGTERM');
  assert.ok(await exitsWithin(proc, 3000), 'arrêt sur SIGTERM');
  assert.equal(proc.code, 0);

  assert.equal(s.callCount(), 2, 'une seule nouvelle tentative, puis plus rien une fois la sauvegarde faite');
  assert.match(proc.stderr, /ÉCHEC du pg_dump/);
  assert.match(proc.stdout, /archive vérifiée/);
  assert.equal(statSync(dump).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(s.backups), [`ant-${today}.dump`], 'aucun fichier temporaire');
  const toc = run('pg_restore', ['--list', dump]).stdout;
  assert.match(toc, /TABLE DATA public notes/);
  const health = await check(s.env(db));
  assert.equal(health.status, 0, health.stdout);
});

test('une archive invalide n\'est jamais gardée, et le service abandonne après BACKUP_MAX_ATTEMPTS', { skip: noPg }, async (t) => {
  const db = antLikeDb(t);
  // pg_dump « réussit » mais écrit une archive tronquée.
  const s = setup(t, 'for a; do case "$a" in --file=*) f="${a#--file=}";; esac; done\nprintf "PGDMP tronqué" > "$f"');
  const proc = start('sh', [SCRIPT], { env: s.env(db, { BACKUP_MAX_ATTEMPTS: '2' }) });
  t.after(() => proc.kill());
  await waitFor(() => proc.stderr.includes('ABANDON'), 15_000, 'abandon après 2 tentatives');
  await sleep(800);
  proc.child.kill('SIGTERM');
  assert.ok(await exitsWithin(proc, 3000));

  assert.equal(s.callCount(), 2, 'pas de troisième tentative le même jour');
  assert.match(proc.stderr, /archive illisible|archive corrompue/);
  assert.deepEqual(readdirSync(s.backups), [], 'ni sauvegarde invalide ni fichier temporaire');
  const health = await check(s.env(db));
  assert.equal(health.status, 1);
  assert.match(health.stdout, /dernière tentative en échec .*archive invalide \(tentative 2\/2\)/);
});

test('--once : sauvegarde nommée vérifiée, sans écraser, et refus d\'une base sans schéma Ant', { skip: noPg }, async (t) => {
  const db = antLikeDb(t);
  const s = setup(t);
  const once = (name, database = db) => runScript('sh', [SCRIPT, '--once', name], { env: s.env(database) }, 30_000);

  const ok = await once('ant-avant-maj-test');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(statSync(join(s.backups, 'ant-avant-maj-test.dump')).mode & 0o777, 0o600);
  assert.equal((await once('ant-avant-maj-test')).status, 1, 'refuse d\'écraser');
  assert.equal((await once('../evasion')).status, 2);

  const empty = createTestDb(t, 'ant_backup_empty');
  const wrong = await once('ant-vide', empty);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /pas de table des migrations/);
  assert.ok(!existsSync(join(s.backups, 'ant-vide.dump')));
});

test('--check : sain avec une sauvegarde récente ou juste après le démarrage, sinon « unhealthy »', async (t) => {
  const s = setup(t);
  const env = s.env('inutile');
  assert.equal((await check(env)).status, 1, 'ni sauvegarde ni démarrage récent');

  writeFileSync(join(s.state, 'ant-backup.started'), '');
  assert.equal((await check(env)).status, 0, 'service démarré récemment');

  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  utimesSync(join(s.state, 'ant-backup.started'), old, old);
  writeFileSync(join(s.backups, 'ant-2020-01-01.dump'), 'x');
  utimesSync(join(s.backups, 'ant-2020-01-01.dump'), old, old);
  const stale = await check(env);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /aucune sauvegarde réussie depuis plus de 36 h/);

  writeFileSync(join(s.backups, `ant-${today}.dump`), 'x');
  assert.equal((await check(env)).status, 0);
});

const noPidNs = run('unshare', ['--pid', '--fork', 'true']).status === 0 ? false : 'unshare --pid indisponible (root requis)';

test('PID 1 du conteneur : docker compose stop l\'arrête tout de suite au lieu d\'attendre 10 s', { skip: noPidNs }, async (t) => {
  const s = setup(t);
  // BACKUP_HOUR=24 : jamais l'heure, le script attend entre deux passages (sleep 600 par défaut).
  const env = { ...s.env('inutile', { BACKUP_HOUR: '24' }) };
  delete env.BACKUP_INTERVAL;
  const proc = start('unshare', ['--pid', '--fork', '--kill-child', 'sh', SCRIPT], { env });
  t.after(() => proc.kill());
  let pid1;
  await waitFor(() => {
    pid1 = run('pgrep', ['-P', String(proc.child.pid)]).stdout.trim();
    return pid1 !== '';
  }, 5000, 'processus PID 1');
  await waitFor(() => proc.stdout.includes('sauvegarde quotidienne'), 5000, 'démarrage du script');
  await sleep(200);
  process.kill(Number(pid1), 'SIGTERM');
  assert.ok(await exitsWithin(proc, 3000), 'SIGTERM ignoré par le PID 1');
  assert.equal(proc.code, 0);
});
