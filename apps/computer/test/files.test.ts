import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FileEntry, FileReadResponse } from '@ant/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, countOccurrences, numberLine, splitCappedLines, type CappedLine } from '../src/files';
import { createComputerServer } from '../src/server';
import { auth, close, listen, post, tempDir } from './helpers';
import { testConfig } from './helpers';

let server: Server;
let base: string;
let root: string;
let outside: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const t = await tempDir();
  const o = await tempDir('ant-outside-');
  cleanups.push(t.cleanup, o.cleanup);
  root = t.dir;
  outside = o.dir;
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'evil-link'));
  server = createComputerServer({ cfg: testConfig(root) });
  base = await listen(server);
});
afterAll(async () => {
  await close(server);
  for (const c of cleanups) await c();
});

describe('helpers', () => {
  it('numbers lines like cat -n', () => {
    expect(numberLine(1, 'abc')).toBe('     1\tabc');
    expect(numberLine(123456, 'x')).toBe('123456\tx');
  });
  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('abc', 'd')).toBe(0);
    expect(countOccurrences('abc', '')).toBe(0);
  });
  it('builds a safe content-disposition', () => {
    expect(contentDisposition('rapport été.pdf')).toBe(`attachment; filename="rapport _t_.pdf"; filename*=UTF-8''rapport%20%C3%A9t%C3%A9.pdf`);
    expect(contentDisposition('a"b.txt')).toContain('filename="a_b.txt"');
  });
});

describe('splitCappedLines', () => {
  async function split(chunks: Buffer[], cap: number): Promise<CappedLine[]> {
    const out: CappedLine[] = [];
    for await (const line of splitCappedLines(Readable.from(chunks), cap)) out.push(line);
    return out;
  }
  async function viaReadline(chunks: Buffer[]): Promise<string[]> {
    const out: string[] = [];
    const rl = createInterface({ input: Readable.from(chunks).setEncoding('utf8'), crlfDelay: Infinity });
    for await (const line of rl) out.push(line);
    return out;
  }
  /** Deterministic pseudo-random generator (mulberry32). */
  function rng(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('splits like readline (\\n, \\r\\n, lone \\r), even across chunk boundaries and inside UTF-8 sequences', async () => {
    const rand = rng(42);
    const pieces = ['a', 'b', 'é', '€', '😀', '\n', '\r', '\r\n', ' '];
    for (let round = 0; round < 400; round++) {
      let text = '';
      const n = Math.floor(rand() * 40);
      for (let k = 0; k < n; k++) text += pieces[Math.floor(rand() * pieces.length)];
      const bytes = Buffer.from(text, 'utf8');
      const chunks: Buffer[] = [];
      for (let at = 0; at < bytes.length; ) {
        const size = 1 + Math.floor(rand() * 5);
        chunks.push(bytes.subarray(at, at + size));
        at += size;
      }
      const cap = 1 + Math.floor(rand() * 6);
      const expected = await viaReadline(chunks);
      const got = await split(chunks, cap);
      expect(got.map((l) => l.length), JSON.stringify(text)).toEqual(expected.map((l) => l.length));
      expect(got.map((l) => l.head), JSON.stringify(text)).toEqual(expected.map((l) => l.slice(0, cap)));
    }
  });

  it('keeps only the head of a long line but reports its full length', async () => {
    const chunks = [Buffer.from('x'.repeat(70_000)), Buffer.from('y'.repeat(70_000)), Buffer.from('\nfin')];
    expect(await split(chunks, 5)).toEqual([
      { head: 'xxxxx', length: 140_000 },
      { head: 'fin', length: 3 },
    ]);
    expect(await split([], 5)).toEqual([]);
    expect(await split([Buffer.from('\n\n')], 5)).toEqual([
      { head: '', length: 0 },
      { head: '', length: 0 },
    ]);
  });
});

describe('files/read on a huge single-line file', () => {
  it('does not buffer the line: a heap far smaller than the file is enough', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    // 64 MB, no newline and no NUL byte (so not « binary »): a minified bundle, a log without newline…
    const fh = await open(path.join(t.dir, 'one-line.txt'), 'w');
    const block = Buffer.alloc(1024 * 1024, 'a');
    for (let i = 0; i < 64; i++) await fh.write(block);
    await fh.close();
    const filesModule = fileURLToPath(new URL('../src/files.ts', import.meta.url));
    const script = path.join(t.dir, 'read.mjs');
    await writeFile(
      script,
      `import { readWorkspaceFile } from ${JSON.stringify(filesModule)};\n` +
        `const r = await readWorkspaceFile(${JSON.stringify(t.dir)}, { path: 'one-line.txt' });\n` +
        `process.stdout.write(JSON.stringify(r));\n`,
    );
    // Heap capped at 32 MB: buffering the whole line (what readline does) crashes the process.
    const run = spawnSync(process.execPath, ['--max-old-space-size=32', '--import', 'tsx', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status, run.stderr.slice(-2000)).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      path: path.join(t.dir, 'one-line.txt'),
      content: numberLine(1, `${'a'.repeat(2000)}… [ligne tronquée, 67108864 caractères]`),
      totalLines: 1,
      truncated: true,
      binary: false,
    });
  }, 60_000);
});

describe('files endpoints', () => {
  it('writes (creating parent dirs), appends and reads with numbering', async () => {
    const w = await post<{ path: string; size: number }>(base, '/files/write', { path: 'notes/today/a.txt', content: 'ligne 1\nligne 2\n' });
    expect(w.status).toBe(200);
    expect(w.body).toEqual({ path: path.join(root, 'notes/today/a.txt'), size: 16 });
    const a = await post<{ size: number }>(base, '/files/write', { path: '/notes/today/a.txt'.replace('/notes', `${root}/notes`), content: 'ligne 3', append: true });
    expect(a.body.size).toBe(23);

    const r = await post<FileReadResponse>(base, '/files/read', { path: 'notes/today/a.txt' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      path: path.join(root, 'notes/today/a.txt'),
      content: '     1\tligne 1\n     2\tligne 2\n     3\tligne 3',
      totalLines: 3,
      truncated: false,
      binary: false,
    });
  });

  it('supports offset/limit, caps long lines and reports truncation', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`);
    lines[9] = 'x'.repeat(3000);
    await writeFile(path.join(root, 'big.txt'), `${lines.join('\n')}\n`);
    const def = await post<FileReadResponse>(base, '/files/read', { path: 'big.txt' });
    expect(def.body.totalLines).toBe(2500);
    expect(def.body.truncated).toBe(true);
    const shown = def.body.content.split('\n');
    expect(shown).toHaveLength(2000);
    expect(shown[1999]).toBe('  2000\tl2000');
    expect(shown[9]!.length).toBeLessThan(2100);
    expect(shown[9]).toContain('ligne tronquée');

    const slice = await post<FileReadResponse>(base, '/files/read', { path: 'big.txt', offset: 2499, limit: 10 });
    expect(slice.body.content).toBe('  2499\tl2499\n  2500\tl2500');
    expect(slice.body.truncated).toBe(false);
  });

  it('detects binary files', async () => {
    await writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
    const r = await post<FileReadResponse>(base, '/files/read', { path: 'bin.dat' });
    expect(r.body).toMatchObject({ binary: true, totalLines: 5, content: '' });
  });

  it('refuses reads and writes outside the workspace', async () => {
    for (const p of ['../x.txt', '/etc/passwd', 'evil-link']) {
      const r = await post<{ error: string; message: string }>(base, '/files/read', { path: p });
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('path_forbidden');
    }
    const w = await post(base, '/files/write', { path: 'evil-link', content: 'pwned' });
    expect(w.status).toBe(403);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('caps writes at 2 MB', async () => {
    const r = await post(base, '/files/write', { path: 'huge.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(r.status).toBe(413);
  });

  it('404 on missing files', async () => {
    const r = await post<{ error: string }>(base, '/files/read', { path: 'nope.txt' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('edits: unique match, missing, ambiguous, replaceAll', async () => {
    await writeFile(path.join(root, 'edit.txt'), 'foo bar foo $& baz');
    const missing = await post<{ message: string }>(base, '/files/edit', { path: 'edit.txt', oldString: 'qux', newString: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/introuvable/);
    const ambiguous = await post<{ message: string }>(base, '/files/edit', { path: 'edit.txt', oldString: 'foo', newString: 'x' });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.message).toMatch(/2 fois/);
    const unique = await post(base, '/files/edit', { path: 'edit.txt', oldString: 'bar', newString: '$1' });
    expect(unique.body).toEqual({ path: path.join(root, 'edit.txt'), replacements: 1 });
    const all = await post(base, '/files/edit', { path: 'edit.txt', oldString: 'foo', newString: 'qux', replaceAll: true });
    expect(all.body).toEqual({ path: path.join(root, 'edit.txt'), replacements: 2 });
    expect(await readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('qux $1 qux $& baz');
  });

  it('lists dirs first, sorted, with metadata', async () => {
    await mkdir(path.join(root, 'list/zdir'), { recursive: true });
    await mkdir(path.join(root, 'list/adir'), { recursive: true });
    await writeFile(path.join(root, 'list/b.txt'), 'bb');
    await writeFile(path.join(root, 'list/a.txt'), 'a');
    await symlink(path.join(root, 'list/adir'), path.join(root, 'list/link-to-dir'));
    const r = await post<FileEntry[]>(base, '/files/list', { path: 'list' });
    expect(r.status).toBe(200);
    expect(r.body.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:adir', 'dir:link-to-dir', 'dir:zdir', 'file:a.txt', 'file:b.txt']);
    const b = r.body.find((e) => e.name === 'b.txt')!;
    expect(b).toMatchObject({ path: path.join(root, 'list/b.txt'), size: 2 });
    expect(new Date(b.modifiedAt).toString()).not.toBe('Invalid Date');

    const rootList = await post<FileEntry[]>(base, '/files/list', {});
    expect(rootList.body.some((e) => e.name === 'list' && e.type === 'dir')).toBe(true);
    const evil = rootList.body.find((e) => e.name === 'evil-link');
    expect(evil?.type).toBe('file');
  });

  it('caps listings at 1000 entries', async () => {
    await mkdir(path.join(root, 'many'));
    await Promise.all(Array.from({ length: 1005 }, (_, i) => writeFile(path.join(root, 'many', `f${String(i).padStart(4, '0')}`), '')));
    const r = await post<FileEntry[]>(base, '/files/list', { path: 'many' });
    expect(r.body).toHaveLength(1000);
  });

  it('downloads files with content-disposition', async () => {
    await writeFile(path.join(root, 'résumé.txt'), 'contenu');
    const res = await fetch(`${base}/files/download?path=${encodeURIComponent('résumé.txt')}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
    expect(await res.text()).toBe('contenu');
    const outsideRes = await fetch(`${base}/files/download?path=evil-link`, { headers: auth });
    expect(outsideRes.status).toBe(403);
    const dirRes = await fetch(`${base}/files/download?path=list`, { headers: auth });
    expect(dirRes.status).toBe(400);
  });

  it('deletes files, dirs and links (never their target), never the root', async () => {
    await mkdir(path.join(root, 'trash/deep'), { recursive: true });
    await writeFile(path.join(root, 'trash/deep/f.txt'), 'x');
    expect((await post(base, '/files/delete', { path: 'trash' })).body).toEqual({ ok: true });
    expect(existsSync(path.join(root, 'trash'))).toBe(false);

    expect((await post(base, '/files/delete', { path: 'evil-link' })).status).toBe(200);
    expect(existsSync(path.join(outside, 'secret.txt'))).toBe(true);

    for (const p of ['', '.', '/', root, '..', 'list/..']) {
      const r = await post(base, '/files/delete', { path: p });
      expect([400, 403], `delete « ${p} »`).toContain(r.status);
    }
    expect(existsSync(root)).toBe(true);
    expect((await post(base, '/files/delete', { path: 'nope' })).status).toBe(404);
  });
});
