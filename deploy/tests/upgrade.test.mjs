// deploy/upgrade.sh dans un vrai dépôt git (clone d'un dépôt local), avec un faux « docker » qui note
// les commandes et simule l'état des conteneurs.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEPLOY_DIR, run, runScript, tempDir, writeExecutable } from './helpers.mjs';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
  const r = run('git', args, { cwd, env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')} : ${r.stderr}`);
  return r.stdout.trim();
}

/** Dépôt d'origine + clone de déploiement (avec .env), puis une nouvelle version publiée sur l'origine. */
function fixture(t, envFile = 'TRUST_PROXY=true\nBACKUP_DIR=/srv/ant-backups\n') {
  const dir = tempDir(t);
  const seed = join(dir, 'seed');
  mkdirSync(join(seed, 'deploy'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', seed);
  copyFileSync(join(DEPLOY_DIR, 'upgrade.sh'), join(seed, 'deploy/upgrade.sh'));
  writeFileSync(join(seed, '.gitignore'), '.env\n');
  writeFileSync(join(seed, 'VERSION'), '1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'v1');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  const work = join(dir, 'ant');
  git(dir, 'clone', '-q', origin, work);
  writeFileSync(join(work, '.env'), envFile);
  const v1 = git(work, 'rev-parse', 'HEAD');

  writeFileSync(join(seed, 'VERSION'), '2\n');
  git(seed, 'commit', '-q', '-am', 'v2');
  git(seed, 'push', '-q', origin, 'main');
  const v2 = git(seed, 'rev-parse', 'HEAD');

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'docker.log');
  writeExecutable(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  "compose build --pull") exit "\${FAKE_BUILD_RC:-0}" ;;
  "compose pull postgres backup") exit "\${FAKE_PULL_RC:-0}" ;;
  "compose run --rm -T backup --once "*) exit "\${FAKE_DUMP_RC:-0}" ;;
  "compose ps -q web") echo cid-web ;;
  "compose ps -q worker") echo cid-worker ;;
  "inspect "*cid-web) echo "\${FAKE_WEB_HEALTH:-healthy}" ;;
  "inspect "*cid-worker) echo running ;;
esac
exit 0
`,
  );
  const upgrade = (extraEnv = {}, args = []) =>
    runScript('bash', [join(work, 'deploy/upgrade.sh'), ...args], {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, ANT_HEALTH_POLL: '0', ANT_HEALTH_TIMEOUT: '0', ...extraEnv },
    });
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const dumps = () => calls().filter((c) => c.startsWith('compose run --rm -T backup --once ')).map((c) => c.split(' ').pop());
  const state = () => {
    try {
      return readFileSync(join(work, '.git/ant-upgrade'), 'utf8');
    } catch {
      return null;
    }
  };
  return { work, v1, v2, upgrade, calls, dumps, state };
}

const short = (sha) => sha.slice(0, 7);

test('mise à jour : sauvegarde vérifiée avant le redémarrage, puis nettoyage et commande de retour', async (t) => {
  const f = fixture(t);
  const r = await f.upgrade();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), f.v2);

  const calls = f.calls().filter((c) => !c.startsWith('compose ps') && !c.startsWith('inspect'));
  assert.equal(calls[0], 'compose build --pull');
  assert.match(calls[1], new RegExp(`^compose run --rm -T backup --once ant-avant-maj-\\d{4}-\\d{2}-\\d{2}-\\d{6}-${f.v1.slice(0, 7)}`));
  assert.deepEqual(calls.slice(2), [
    'compose pull postgres backup',
    'compose up -d --remove-orphans',
    'image prune -f',
    'builder prune -f --filter until=168h',
  ]);
  // Retour arrière : restauration sans redémarrage AVANT de revenir à l'ancien code (qui n'a pas forcément restore.sh).
  const restoreLine = r.stdout.indexOf('./deploy/restore.sh /srv/ant-backups/ant-avant-maj-');
  const checkoutLine = r.stdout.indexOf(`git checkout ${f.v1}`);
  assert.ok(restoreLine >= 0 && checkoutLine > restoreLine, r.stdout);
  assert.match(r.stdout, /restore\.sh \S+\.dump --sans-redemarrage/);
  assert.match(readFileSync(`${f.work}/.env`, 'utf8'), /^TRUST_PROXY=loopback,linklocal,uniquelocal$/m, 'TRUST_PROXY=true corrigé');
});

test('sauvegarde en échec : rien n\'est redémarré, et la relance garde l\'ancienne version comme retour', async (t) => {
  const f = fixture(t);
  const r = await f.upgrade({ FAKE_DUMP_RC: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /la sauvegarde a échoué : mise à jour interrompue/);
  assert.ok(!f.calls().some((c) => c.startsWith('compose up') || c.startsWith('compose pull')));
  // Le code est déjà en v2 : l'avertissement le dit, et la relance suffit (pas besoin de --depuis).
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), f.v2);
  assert.match(r.stderr, new RegExp(`Ant tourne toujours sur la version ${short(f.v1)}`));
  assert.match(r.stderr, new RegExp(`déjà en version ${short(f.v2)}`));
  assert.match(r.stderr, /ne lance pas\s+« docker compose up »/);
  assert.match(r.stderr, /relance \.\/deploy\/upgrade\.sh/);
  assert.match(r.stderr, new RegExp(`git checkout ${f.v1} && docker compose build`));

  // Relance, puis web ne démarre pas : le retour arrière vise v1 (et non HEAD, déjà en v2).
  const again = await f.upgrade({ FAKE_WEB_HEALTH: 'unhealthy' });
  assert.notEqual(again.status, 0);
  assert.match(again.stdout, new RegExp(`Mise à jour précédente inachevée : le retour arrière vise toujours la version ${short(f.v1)}`));
  assert.match(again.stderr, new RegExp(`git checkout ${f.v1}\n`));
  assert.doesNotMatch(again.stderr, new RegExp(`git checkout ${f.v2}`));
  const dumps = f.dumps();
  assert.equal(dumps.length, 2);
  assert.ok(dumps[1].endsWith(`-${short(f.v1)}`), dumps[1]);
  assert.match(again.stderr, new RegExp(`restore\\.sh /srv/ant-backups/${dumps[1]}\\.dump --sans-redemarrage`));
});

test('construction en échec : la relance reprend le point de retour, qui est oublié une fois la mise à jour réussie', async (t) => {
  const f = fixture(t);
  const r = await f.upgrade({ FAKE_BUILD_RC: '1' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(f.dumps(), [], 'aucune sauvegarde ni redémarrage');
  assert.ok(!f.calls().some((c) => c.startsWith('compose up')));
  assert.match(r.stderr, /ne lance pas\s+« docker compose up »/);
  assert.equal(f.state(), `depuis=${f.v1}\n`);

  const ok = await f.upgrade();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`Ant est à jour : ${short(f.v1)} → ${short(f.v2)}`));
  assert.match(ok.stdout, new RegExp(`git checkout ${f.v1}\n`));
  assert.equal(f.state(), null, 'point de retour supprimé après la réussite');

  // Mise à jour suivante : le retour arrière vise la version qui tourne désormais (v2).
  const next = await f.upgrade();
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stdout, /inachevée/);
  assert.match(next.stdout, new RegExp(`git checkout ${f.v2}\n`));
});

test('image PostgreSQL non téléchargée (Docker Hub) : la mise à jour continue avec l\'image locale', async (t) => {
  const f = fixture(t);
  const r = await f.upgrade({ FAKE_PULL_RC: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /image PostgreSQL non mise à jour/);
  assert.ok(f.calls().includes('compose up -d --remove-orphans'));
  assert.equal(f.state(), null);
});

test('web ne démarre pas, puis relance sans retour arrière : le dump d\'avant la première tentative reste la référence', async (t) => {
  const f = fixture(t);
  const failed = await f.upgrade({ FAKE_WEB_HEALTH: 'unhealthy' });
  assert.notEqual(failed.status, 0);
  const [first] = f.dumps();
  assert.equal(f.state(), `depuis=${f.v1}\nsauvegarde=${first}\n`);

  // La base a pu recevoir les migrations de v2 : la nouvelle sauvegarde porte le nom de v2, et le
  // retour vers v1 passe toujours par le dump pris avant la première tentative.
  const r = await f.upgrade();
  assert.equal(r.status, 0, r.stderr);
  const second = f.dumps()[1];
  assert.ok(second.endsWith(`-${short(f.v2)}`), second);
  assert.match(r.stdout, new RegExp(`Sauvegarde d'avant mise à jour : /srv/ant-backups/${first}\\.dump`));
  assert.match(r.stdout, new RegExp(`juste avant cette relance : /srv/ant-backups/${second}\\.dump`));
  assert.match(r.stdout, new RegExp(`restore\\.sh /srv/ant-backups/${first}\\.dump --sans-redemarrage\n  git checkout ${f.v1}\n`));
  assert.equal(f.state(), null);
});

test('web ne démarre pas, retour arrière, puis nouvelle mise à jour : retour vers v1 avec une sauvegarde fraîche', async (t) => {
  const f = fixture(t);
  assert.notEqual((await f.upgrade({ FAKE_WEB_HEALTH: 'unhealthy' })).status, 0);
  const [first] = f.dumps();
  // Marche à suivre affichée : restore.sh --sans-redemarrage (qui oublie le dump noté), git checkout v1, puis
  // plus tard retour sur la branche.
  writeFileSync(join(f.work, '.git/ant-upgrade'), f.state().replace(/^sauvegarde=.*\n/m, ''));
  git(f.work, 'checkout', '-q', '--detach', f.v1);
  git(f.work, 'checkout', '-q', 'main');

  assert.equal(f.state(), `depuis=${f.v1}\n`);

  const r = await f.upgrade();
  assert.equal(r.status, 0, r.stderr);
  const second = f.dumps()[1];
  assert.ok(first && second.endsWith(`-${short(f.v1)}`), second);
  assert.doesNotMatch(r.stdout, /première tentative/, 'pas de renvoi vers le dump d\'avant le retour arrière');
  assert.match(r.stdout, new RegExp(`restore\\.sh /srv/ant-backups/${second}\\.dump --sans-redemarrage\n  git checkout ${f.v1}\n`));
});

test('web ne démarre pas : échec avec la marche à suivre pour revenir en arrière', async (t) => {
  const f = fixture(t);
  const r = await f.upgrade({ FAKE_WEB_HEALTH: 'unhealthy' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /web ne démarre pas correctement \(état : unhealthy\)/);
  assert.match(r.stderr, new RegExp(`git checkout ${f.v1}`));
  assert.ok(!f.calls().includes('image prune -f'), 'les anciennes images restent disponibles');
});

test('modifications locales ou version figée : refus avant toute action', async (t) => {
  const f = fixture(t, 'TRUST_PROXY=192.168.1.10\n');
  writeFileSync(join(f.work, 'deploy/upgrade.sh'), `${readFileSync(join(f.work, 'deploy/upgrade.sh'), 'utf8')}\n# local\n`);
  const dirty = await f.upgrade();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /modifications locales/);
  git(f.work, 'checkout', '-q', '--', 'deploy/upgrade.sh');

  git(f.work, 'checkout', '-q', '--detach', 'HEAD');
  const detached = await f.upgrade();
  assert.notEqual(detached.status, 0);
  assert.match(detached.stderr, /version figée/);

  assert.deepEqual(f.calls(), []);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), f.v1);
  assert.equal(readFileSync(join(f.work, '.env'), 'utf8'), 'TRUST_PROXY=192.168.1.10\n', 'TRUST_PROXY explicite conservé');
});

test('--depuis : code déjà récupéré à la main, le retour arrière vise la version d\'avant', async (t) => {
  const f = fixture(t);
  git(f.work, 'pull', '-q', '--ff-only');
  const r = await f.upgrade({}, ['--depuis', f.v1]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`git checkout ${f.v1}`));
  assert.ok(f.calls().some((c) => c.includes(`--once ant-avant-maj-`) && c.endsWith(f.v1.slice(0, 7))));
  const unknown = await f.upgrade({}, ['--depuis', 'pas-un-commit']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /commit inconnu/);
});
