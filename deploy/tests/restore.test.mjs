// deploy/restore.sh contre le PostgreSQL de test, avec les vraies migrations d'Ant. Un faux « docker »
// exécute les commandes « docker compose exec -T postgres … » sur ce PostgreSQL et note les autres.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEPLOY_DIR,
  PG_ENV,
  REPO_ROOT,
  createTestDb,
  hasPostgres,
  psql,
  run,
  runScript,
  tempDir,
  writeExecutable,
} from './helpers.mjs';

const SCRIPT = join(DEPLOY_DIR, 'restore.sh');
const MIGRATIONS = join(REPO_ROOT, 'apps/server/drizzle');
const skip = hasPostgres() ? false : 'PostgreSQL de test indisponible (localhost:5432, utilisateur postgres)';

function fakeDocker(dir) {
  const log = join(dir, 'docker.log');
  writeExecutable(
    join(dir, 'docker'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
[ "$1" = compose ] || exit 1
shift
if [ "$1" = exec ]; then
  shift
  [ "$1" = -T ] && shift
  [ "$1" = postgres ] || exit 1
  shift
  exec "$@"
fi
exit 0
`,
  );
  return () => readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.startsWith('compose exec'));
}

/** Base au schéma réel d'Ant (toutes les migrations), avec la table de suivi de drizzle. */
function antDb(t) {
  const db = createTestDb(t, 'ant_restore_test', ['_restauration', '_precedente']);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const r = run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', join(MIGRATIONS, f)], { env: { ...process.env, ...PG_ENV } });
    assert.equal(r.status, 0, `${f} : ${r.stderr}`);
  }
  psql(
    db,
    `CREATE SCHEMA drizzle;
     CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
     INSERT INTO drizzle.__drizzle_migrations (hash, created_at) SELECT 'm' || g, g FROM generate_series(1, ${files.length}) g;
     CREATE TABLE test_rows (id int PRIMARY KEY);
     INSERT INTO test_rows VALUES (1);`,
  );
  return db;
}

function dumpTo(db, file) {
  const r = run('pg_dump', ['--format=custom', '--compress=9', `--file=${file}`, '-d', db], { env: { ...process.env, ...PG_ENV } });
  assert.equal(r.status, 0, r.stderr);
}

function restore(dir, db, file, ...options) {
  return restoreWith(SCRIPT, dir, db, file, ...options);
}

function restoreWith(script, dir, db, file, ...options) {
  return runScript('bash', [script, file, '--oui', ...options], {
    env: { ...process.env, ...PG_ENV, PATH: `${dir}:${process.env.PATH}`, ANT_DB: db, ANT_DB_USER: PG_ENV.PGUSER },
  });
}

test('restauration après une mise à jour : la base revient à l\'état du dump, l\'ancienne est conservée', { skip }, async (t) => {
  const dir = tempDir(t);
  const calls = fakeDocker(dir);
  const db = antDb(t);
  const dump = join(dir, 'ant-2026-10-12.dump');
  dumpTo(db, dump);

  // Mise à jour ratée : une nouvelle migration ajoute une table qui dépend de « bots », puis de nouvelles données.
  // (C'est ce cas qui cassait l'ancienne commande du README, pg_restore --clean dans la base existante.)
  psql(db, `CREATE TABLE bot_notes (id serial PRIMARY KEY, bot_id uuid REFERENCES bots(id));
            INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('nouvelle', 999);
            INSERT INTO test_rows VALUES (2);`);

  const r = await restore(dir, db, dump);
  assert.equal(r.status, 0, r.stderr);

  assert.equal(psql(db, 'SELECT string_agg(id::text, \',\' ORDER BY id) FROM test_rows'), '1');
  assert.equal(psql(db, "SELECT to_regclass('public.bot_notes') IS NULL"), 't', 'table de la migration plus récente absente');
  assert.equal(psql(db, "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash = 'nouvelle'"), '0');
  assert.equal(psql(db, "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'audit_log_no_%'"), '2', 'triggers de l\'audit restaurés');
  assert.equal(psql(`${db}_precedente`, 'SELECT count(*) FROM test_rows'), '2', 'ancienne base conservée telle quelle');
  assert.equal(psql('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${db}_restauration'`), '0');
  assert.deepEqual(calls(), ['compose stop web worker backup', 'compose up -d']);
  assert.match(r.stdout, /dropdb -U postgres .*_precedente/);

  // Retour à une version précédente (--sans-redemarrage) : les services restent arrêtés, et la copie
  // « _precedente » est remplacée.
  const again = await restore(dir, db, dump, '--sans-redemarrage');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(psql(`${db}_precedente`, 'SELECT count(*) FROM test_rows'), '1');
  assert.deepEqual(calls().slice(2), ['compose stop web worker backup'], 'aucun redémarrage');
  assert.match(again.stdout, /restent arrêtés/);
});

test('archive invalide : refus avant d\'arrêter quoi que ce soit', { skip }, async (t) => {
  const dir = tempDir(t);
  const calls = fakeDocker(dir);
  const db = antDb(t);
  const bad = join(dir, 'tronque.dump');
  dumpTo(db, bad);
  writeFileSync(bad, readFileSync(bad).subarray(0, 600));

  const r = await restore(dir, db, bad);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /archive (illisible|corrompue)/);
  assert.deepEqual(calls(), [], 'aucun service arrêté');
  assert.equal(psql(db, 'SELECT count(*) FROM test_rows'), '1');
});

test('échec pendant la restauration : la base actuelle reste intacte et les services redémarrent', { skip }, async (t) => {
  const dir = tempDir(t);
  const calls = fakeDocker(dir);
  const db = antDb(t);
  // Archive valide mais impossible à restaurer ici : un objet appartient à un rôle qui n'existe plus.
  const role = `${db}_proprietaire`;
  psql('postgres', `CREATE ROLE "${role}"`);
  t.after(() => psql('postgres', `DROP ROLE IF EXISTS "${role}"`));
  psql(db, `CREATE TABLE a_role (id int); ALTER TABLE a_role OWNER TO "${role}";`);
  const dump = join(dir, 'ant-role.dump');
  dumpTo(db, dump);
  psql(db, `DROP TABLE a_role; INSERT INTO test_rows VALUES (2);`);
  psql('postgres', `DROP ROLE "${role}"`);

  const r = await restore(dir, db, dump);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ÉCHEC, la base .* n'a pas été modifiée/);
  assert.equal(psql(db, 'SELECT count(*) FROM test_rows'), '2', 'base actuelle intacte');
  assert.equal(psql('postgres', `SELECT count(*) FROM pg_database WHERE datname IN ('${db}_restauration', '${db}_precedente')`), '0');
  assert.deepEqual(calls(), ['compose stop web worker backup', 'compose up -d']);
});

test('retour arrière après une mise à jour ratée : le dump noté par upgrade.sh est oublié, pas la version', { skip }, async (t) => {
  const dir = tempDir(t);
  const calls = fakeDocker(dir);
  const db = antDb(t);
  const dump = join(dir, 'ant-avant-maj-2026-10-12-101500-aaaaaaa.dump');
  dumpTo(db, dump);
  // Installation dans un dépôt git, avec le point de retour d'une mise à jour inachevée (deploy/upgrade.sh).
  const repo = join(dir, 'ant');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  assert.equal(run('git', ['init', '-q', repo]).status, 0);
  copyFileSync(SCRIPT, join(repo, 'deploy/restore.sh'));
  const state = join(repo, '.git/ant-upgrade');
  writeFileSync(state, 'depuis=aaaaaaa1111\nsauvegarde=ant-avant-maj-2026-10-12-101500-aaaaaaa\n');

  // Restauration avec redémarrage : la version présente démarre sur la base restaurée, le dump noté reste la référence.
  const kept = await restoreWith(join(repo, 'deploy/restore.sh'), dir, db, dump);
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(readFileSync(state, 'utf8'), 'depuis=aaaaaaa1111\nsauvegarde=ant-avant-maj-2026-10-12-101500-aaaaaaa\n');

  const r = await restoreWith(join(repo, 'deploy/restore.sh'), dir, db, dump, '--sans-redemarrage');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(state, 'utf8'), 'depuis=aaaaaaa1111\n');
  assert.deepEqual(calls().slice(-1), ['compose stop web worker backup']);
});
