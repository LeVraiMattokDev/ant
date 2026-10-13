// deploy/ant-firewall.sh, exécuté avec le vrai iptables dans un espace réseau isolé (unshare --net) :
// les règles produites sont ensuite évaluées paquet par paquet (premier filtre qui correspond).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEPLOY_DIR, run, tempDir } from './helpers.mjs';

const SCRIPT = join(DEPLOY_DIR, 'ant-firewall.sh');

const skip =
  process.getuid?.() === 0 && run('unshare', ['--net', 'iptables', '-S']).status === 0
    ? false
    : 'nécessite root, unshare et iptables';

/** Exécute le script (deux fois si demandé) dans un espace réseau neuf et renvoie les chaînes obtenues. */
function applyFirewall(t, resolvContents, { runs = 1 } = {}) {
  const dir = tempDir(t);
  const files = resolvContents.map((content, i) => {
    const f = join(dir, `resolv${i}.conf`);
    writeFileSync(f, content);
    return f;
  });
  const once = 'bash "$0" >/dev/null';
  const r = run(
    'unshare',
    [
      '--net',
      'bash',
      '-c',
      `set -e; iptables -N DOCKER-USER; ${Array(runs).fill(once).join('; ')}; ` +
        'for c in ANT-ISOLATION DOCKER-USER INPUT; do echo "### $c"; iptables -S "$c"; done',
      SCRIPT,
    ],
    { env: { ...process.env, ANT_RESOLV_CONF: [...files, join(dir, 'absent.conf')].join(' ') } },
  );
  assert.equal(r.status, 0, r.stderr);
  const chains = {};
  let current;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('### ')) chains[(current = line.slice(4))] = [];
    else if (line.startsWith('-A ')) chains[current].push(line);
  }
  return chains;
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}
function inCidr(ip, cidr) {
  const [base, bits = '32'] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(base) / size);
}

/** Cible du premier filtre d'une chaîne iptables (format iptables -S) qui correspond au paquet. */
function verdict(rules, pkt) {
  for (const rule of rules) {
    const tok = rule.split(/\s+/).slice(2);
    let ok = true;
    let target;
    for (let i = 0; i < tok.length; i++) {
      let neg = false;
      if (tok[i] === '!') {
        neg = true;
        i++;
      }
      const opt = tok[i];
      const val = tok[i + 1];
      let m;
      switch (opt) {
        case '-d': m = inCidr(pkt.dst, val); break;
        case '-i': m = pkt.in === val; break;
        case '-o': m = pkt.out === val; break;
        case '-p': m = pkt.proto === val; break;
        case '--dport': m = pkt.dport === Number(val); break;
        case '--ctstate': m = val.split(',').includes(pkt.state); break;
        case '-j': target = val; i++; continue;
        default: i++; continue; // -m, --reject-with…
      }
      i++;
      if (m === neg) ok = false;
    }
    if (ok) return target;
  }
  return 'RETURN';
}

const fromWorker = (dst, proto, dport) => ({ in: 'ant-egress', out: 'eth0', dst, proto, dport, state: 'NEW' });

test('les requêtes DNS vers le résolveur du LAN passent, le reste du LAN reste bloqué', { skip }, (t) => {
  const { 'ANT-ISOLATION': rules } = applyFirewall(t, ['# CT Proxmox\nsearch lan\nnameserver 192.168.1.1\n']);
  for (const proto of ['udp', 'tcp']) {
    assert.equal(verdict(rules, fromWorker('192.168.1.1', proto, 53)), 'RETURN', `DNS ${proto} vers 192.168.1.1`);
    assert.equal(verdict(rules, { ...fromWorker('192.168.1.1', proto, 53), in: 'ant-sandbox' }), 'RETURN');
  }
  assert.equal(verdict(rules, fromWorker('192.168.1.1', 'tcp', 80)), 'REJECT', 'interface web du routeur');
  assert.equal(verdict(rules, fromWorker('192.168.1.50', 'udp', 53)), 'REJECT', 'autre machine du LAN, même sur le port 53');
  assert.equal(verdict(rules, fromWorker('10.0.0.5', 'tcp', 22)), 'REJECT');
  assert.equal(verdict(rules, fromWorker('1.1.1.1', 'tcp', 443)), 'RETURN', 'Internet');
});

test('systemd-resolved : les serveurs réels sont lus dans le second fichier', { skip }, (t) => {
  const { 'ANT-ISOLATION': rules } = applyFirewall(t, [
    'nameserver 127.0.0.53\noptions edns0\n',
    'nameserver 10.0.0.53\nnameserver fd00::53\nnameserver pihole.lan\n',
  ]);
  assert.equal(verdict(rules, fromWorker('10.0.0.53', 'udp', 53)), 'RETURN');
  assert.ok(!rules.some((r) => r.includes('127.0.0.53') || r.includes('fd00')), 'ni boucle locale ni IPv6 ni nom');
});

test('un DNS public n\'ouvre rien vers le LAN, et relancer le script ne duplique rien', { skip }, (t) => {
  const chains = applyFirewall(t, ['nameserver 1.1.1.1\n'], { runs: 2 });
  assert.equal(verdict(chains['ANT-ISOLATION'], fromWorker('192.168.1.1', 'udp', 53)), 'REJECT');
  assert.equal(chains['ANT-ISOLATION'].filter((r) => r.includes('--dport 53')).length, 6, '3 ponts × udp/tcp');
  assert.equal(chains['ANT-ISOLATION'].filter((r) => r.includes('REJECT')).length, 18, '3 ponts × 6 plages');
  assert.deepEqual(chains['DOCKER-USER'], ['-A DOCKER-USER -j ANT-ISOLATION']);
  assert.equal(chains.INPUT.length, 6, '2 règles par pont, une seule fois');
});
