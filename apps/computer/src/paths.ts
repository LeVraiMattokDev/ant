import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors';

/**
 * Path confinement to the workspace.
 *
 * A requested path (relative to the workspace, or absolute under it) is accepted only if:
 *  1. once normalised lexically, it stays under the workspace root (`..` escapes rejected);
 *  2. the real path of its deepest existing ancestor (symlinks resolved) is still under the
 *     real workspace root, and no not-yet-existing component is a dangling symlink
 *     (which a later write would follow outside).
 */

export class PathError extends HttpError {
  constructor(message: string) {
    super(403, 'path_forbidden', message);
  }
}

export interface ResolvedPath {
  /** Path on disk to operate on (symlinks resolved, except the last component with `followLast: false`). */
  abs: string;
  /** Relative to the workspace root ('' for the root itself), with '/' separators. */
  rel: string;
  /** Path to show to the agents: logical workspace root + rel (e.g. "/workspace/notes/a.md"). */
  display: string;
}

export interface ResolveOptions {
  /**
   * Resolve symlinks on the last component too (default true). Use false for operations that act
   * on the link itself (delete), so deleting a link never deletes its target.
   */
  followLast?: boolean;
  /** Refuse the workspace root itself (delete). */
  forbidRoot?: boolean;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function cleanRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

const rootRealCache = new Map<string, string>();

async function realRoot(root: string): Promise<string> {
  const cached = rootRealCache.get(root);
  if (cached) return cached;
  const real = await realpath(root);
  rootRealCache.set(root, real);
  return real;
}

/** Lexical resolution: requested path → absolute path under `root`, or PathError. */
export function resolveLexical(root: string, requested: string | undefined | null): string {
  const raw = (requested ?? '').trim();
  if (raw.includes('\0')) throw new PathError('Chemin invalide (caractère nul).');
  const logicalRoot = path.resolve(root);
  const abs = raw === '' ? logicalRoot : path.resolve(logicalRoot, raw);
  if (!isInside(logicalRoot, abs)) {
    throw new PathError(`Chemin hors de l'espace de travail refusé : « ${raw} ».`);
  }
  return abs;
}

/** Real path of `abs`: realpath of the deepest existing ancestor + the missing components. */
async function realOfDeepestExisting(abs: string): Promise<string> {
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? path.join(real, ...missing) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      // A component that "does not exist" for realpath but exists for lstat is a dangling symlink:
      // writing through it would create its target, possibly outside the workspace.
      const st = await lstat(current).catch(() => null);
      if (st?.isSymbolicLink()) throw new PathError('Lien symbolique cassé dans le chemin : refusé.');
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveWorkspacePath(
  root: string,
  requested: string | undefined | null,
  opts: ResolveOptions = {},
): Promise<ResolvedPath> {
  const logicalRoot = path.resolve(root);
  const rootReal = await realRoot(logicalRoot);
  const abs = resolveLexical(logicalRoot, requested);
  const rel = cleanRel(logicalRoot, abs);
  if (opts.forbidRoot && rel === '') throw new PathError("Impossible d'agir sur la racine de l'espace de travail.");

  let real: string;
  if (opts.followLast === false && rel !== '') {
    const parentReal = await realOfDeepestExisting(path.dirname(abs));
    real = path.join(parentReal, path.basename(abs));
  } else {
    real = await realOfDeepestExisting(abs);
  }
  if (!isInside(rootReal, real)) {
    throw new PathError(`Le chemin « ${requested ?? ''} » mène hors de l'espace de travail (lien symbolique) : refusé.`);
  }
  if (opts.forbidRoot && real === rootReal) {
    throw new PathError("Impossible d'agir sur la racine de l'espace de travail.");
  }
  const realRel = cleanRel(rootReal, real);
  return { abs: real, rel: realRel, display: realRel ? path.posix.join(logicalRoot, realRel) : logicalRoot };
}
