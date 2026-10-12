import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInside, PathError, resolveLexical, resolveWorkspacePath } from '../src/paths';
import { tempDir } from './helpers';

let root: string;
let outside: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const a = await tempDir('ant-ws-');
  const b = await tempDir('ant-outside-');
  cleanups.push(a.cleanup, b.cleanup);
  root = a.dir;
  outside = b.dir;
  await mkdir(path.join(root, 'docs/sub'), { recursive: true });
  await writeFile(path.join(root, 'docs/a.txt'), 'a');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(root, 'escape-dir'));
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape-file'));
  await symlink(path.join(root, 'docs'), path.join(root, 'docs-link'));
  await symlink(path.join(outside, 'not-yet.txt'), path.join(root, 'dangling'));
  await symlink('../a.txt', path.join(root, 'docs/sub/rel-link'));
});

afterAll(async () => {
  for (const c of cleanups) await c();
});

describe('isInside', () => {
  it('handles prefixes and dot-dot correctly', () => {
    expect(isInside('/workspace', '/workspace')).toBe(true);
    expect(isInside('/workspace', '/workspace/a/b')).toBe(true);
    expect(isInside('/workspace', '/workspace/..foo')).toBe(true);
    expect(isInside('/workspace', '/workspace2/a')).toBe(false);
    expect(isInside('/workspace', '/')).toBe(false);
    expect(isInside('/workspace', '/etc/passwd')).toBe(false);
  });
});

describe('resolveLexical', () => {
  it('resolves relative and absolute paths under the root', () => {
    expect(resolveLexical('/workspace', 'a/b.txt')).toBe('/workspace/a/b.txt');
    expect(resolveLexical('/workspace', '/workspace/a')).toBe('/workspace/a');
    expect(resolveLexical('/workspace', '')).toBe('/workspace');
    expect(resolveLexical('/workspace', undefined)).toBe('/workspace');
    expect(resolveLexical('/workspace', 'a/../b')).toBe('/workspace/b');
  });

  it('rejects escapes', () => {
    expect(() => resolveLexical('/workspace', '../etc/passwd')).toThrow(PathError);
    expect(() => resolveLexical('/workspace', 'a/../../etc')).toThrow(PathError);
    expect(() => resolveLexical('/workspace', '/etc/passwd')).toThrow(PathError);
    expect(() => resolveLexical('/workspace', '/workspace-other/x')).toThrow(PathError);
    expect(() => resolveLexical('/workspace', 'a\0b')).toThrow(PathError);
  });
});

describe('resolveWorkspacePath', () => {
  it('accepts existing and not-yet-existing paths inside', async () => {
    const r = await resolveWorkspacePath(root, 'docs/a.txt');
    expect(r.abs).toBe(path.join(root, 'docs/a.txt'));
    expect(r.rel).toBe('docs/a.txt');
    expect(r.display).toBe(path.join(root, 'docs/a.txt'));
    const n = await resolveWorkspacePath(root, 'new/dir/file.txt');
    expect(n.abs).toBe(path.join(root, 'new/dir/file.txt'));
    const abs = await resolveWorkspacePath(root, path.join(root, 'docs'));
    expect(abs.rel).toBe('docs');
    const r0 = await resolveWorkspacePath(root, '');
    expect(r0.rel).toBe('');
  });

  it('follows symlinks that stay inside', async () => {
    const r = await resolveWorkspacePath(root, 'docs-link/a.txt');
    expect(r.abs).toBe(path.join(root, 'docs/a.txt'));
    const rel = await resolveWorkspacePath(root, 'docs/sub/rel-link');
    expect(rel.abs).toBe(path.join(root, 'docs/a.txt'));
  });

  it('rejects .. and absolute escapes', async () => {
    await expect(resolveWorkspacePath(root, '../x')).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, path.join(outside, 'secret.txt'))).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, 'docs/../../x')).rejects.toBeInstanceOf(PathError);
  });

  it('rejects symlinks resolving outside (dir, file, new file below, dangling)', async () => {
    await expect(resolveWorkspacePath(root, 'escape-dir')).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, 'escape-dir/secret.txt')).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, 'escape-dir/new/file.txt')).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, 'escape-file')).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, 'dangling')).rejects.toBeInstanceOf(PathError);
  });

  it('followLast: false targets the link itself (delete) and forbidRoot protects the root', async () => {
    const link = await resolveWorkspacePath(root, 'escape-file', { followLast: false });
    expect(link.abs).toBe(path.join(root, 'escape-file'));
    await expect(resolveWorkspacePath(root, 'escape-dir/secret.txt', { followLast: false })).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, '', { forbidRoot: true })).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, '.', { forbidRoot: true })).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, 'docs/..', { forbidRoot: true, followLast: false })).rejects.toBeInstanceOf(PathError);
    await expect(resolveWorkspacePath(root, root, { forbidRoot: true })).rejects.toBeInstanceOf(PathError);
  });
});
