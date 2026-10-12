import { createReadStream, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile as fsReadFile, rm, stat, writeFile as fsWriteFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { FileEditRequest, FileEntry, FileReadRequest, FileReadResponse, FileWriteRequest } from '@ant/shared';
import { badRequest, HttpError, toHttpError } from './errors';
import { resolveWorkspacePath, type ResolvedPath } from './paths';

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_READ_LIMIT = 10_000;
export const MAX_LINE_CHARS = 2000;
export const BINARY_SNIFF_BYTES = 8192;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/** Files edited in memory (oldString/newString) are capped. */
export const MAX_EDIT_BYTES = 10 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 1000;

async function resolve(root: string, p: string | undefined, opts?: Parameters<typeof resolveWorkspacePath>[2]): Promise<ResolvedPath> {
  return resolveWorkspacePath(root, p, opts);
}

async function statOrThrow(target: ResolvedPath): Promise<Stats> {
  try {
    return await stat(target.abs);
  } catch (err) {
    throw toHttpError(err, target.display);
  }
}

async function isBinaryFile(abs: string): Promise<boolean> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/** cat -n style numbering: 6-wide right-aligned number, a tab, the line. */
export function numberLine(n: number, line: string): string {
  return `${String(n).padStart(6, ' ')}\t${line}`;
}

export async function readWorkspaceFile(root: string, req: FileReadRequest): Promise<FileReadResponse> {
  const target = await resolve(root, req.path);
  const st = await statOrThrow(target);
  if (st.isDirectory()) throw badRequest(`« ${target.display} » est un dossier : utilise la liste des fichiers.`);
  if (!st.isFile()) throw badRequest(`« ${target.display} » n'est pas un fichier ordinaire.`);

  if (await isBinaryFile(target.abs)) {
    return { path: target.display, content: '', totalLines: st.size, truncated: false, binary: true };
  }

  const offset = Math.max(1, Math.floor(req.offset ?? 1));
  const limit = Math.min(Math.max(1, Math.floor(req.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
  const last = offset + limit - 1;
  const out: string[] = [];
  let total = 0;
  let cut = false;

  const rl = createInterface({ input: createReadStream(target.abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    total++;
    if (total < offset || total > last) continue;
    let text = line;
    if (text.length > MAX_LINE_CHARS) {
      text = `${text.slice(0, MAX_LINE_CHARS)}… [ligne tronquée, ${line.length} caractères]`;
      cut = true;
    }
    out.push(numberLine(total, text));
  }
  return {
    path: target.display,
    content: out.join('\n'),
    totalLines: total,
    truncated: cut || total > last,
    binary: false,
  };
}

export async function writeWorkspaceFile(root: string, req: FileWriteRequest): Promise<{ path: string; size: number }> {
  if (Buffer.byteLength(req.content, 'utf8') > MAX_WRITE_BYTES) {
    throw new HttpError(413, 'payload_too_large', `Contenu trop volumineux (2 Mo maximum par écriture ; utilise append pour continuer).`);
  }
  const target = await resolve(root, req.path, { forbidRoot: true });
  const existing = await stat(target.abs).catch(() => null);
  if (existing?.isDirectory()) throw badRequest(`« ${target.display} » est un dossier.`);
  if (existing && !existing.isFile()) throw badRequest(`« ${target.display} » n'est pas un fichier ordinaire.`);
  try {
    await mkdir(path.dirname(target.abs), { recursive: true });
    if (req.append) await appendFile(target.abs, req.content, 'utf8');
    else await fsWriteFile(target.abs, req.content, 'utf8');
    const after = await stat(target.abs);
    return { path: target.display, size: after.size };
  } catch (err) {
    throw toHttpError(err, target.display);
  }
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count++;
    from = i + needle.length;
  }
}

export async function editWorkspaceFile(root: string, req: FileEditRequest): Promise<{ path: string; replacements: number }> {
  if (req.oldString === '') throw badRequest('oldString ne peut pas être vide.');
  if (req.oldString === req.newString) throw badRequest('oldString et newString sont identiques : rien à modifier.');
  const target = await resolve(root, req.path, { forbidRoot: true });
  const st = await statOrThrow(target);
  if (!st.isFile()) throw badRequest(`« ${target.display} » n'est pas un fichier.`);
  if (st.size > MAX_EDIT_BYTES) throw badRequest('Fichier trop volumineux pour être modifié ainsi (10 Mo maximum).');
  if (await isBinaryFile(target.abs)) throw badRequest(`« ${target.display} » est un fichier binaire.`);

  const content = await fsReadFile(target.abs, 'utf8');
  const count = countOccurrences(content, req.oldString);
  if (count === 0) {
    throw badRequest(`Texte à remplacer introuvable dans « ${target.display} » (vérifie espaces, indentation et retours à la ligne).`);
  }
  if (count > 1 && !req.replaceAll) {
    throw badRequest(
      `Texte à remplacer trouvé ${count} fois dans « ${target.display} » : ajoute du contexte pour le rendre unique, ou utilise replaceAll.`,
    );
  }
  // split/join: no `$&`-style replacement patterns.
  const updated = content.split(req.oldString).join(req.newString);
  try {
    await fsWriteFile(target.abs, updated, 'utf8');
  } catch (err) {
    throw toHttpError(err, target.display);
  }
  return { path: target.display, replacements: count };
}

export async function listWorkspaceDir(root: string, requested: string | undefined): Promise<FileEntry[]> {
  const dir = await resolve(root, requested);
  const st = await statOrThrow(dir);
  if (!st.isDirectory()) throw badRequest(`« ${dir.display} » n'est pas un dossier.`);

  let dirents;
  try {
    dirents = await readdir(dir.abs, { withFileTypes: true });
  } catch (err) {
    throw toHttpError(err, dir.display);
  }

  // Classify cheaply first (dirent types; symlinks followed only if they stay inside the workspace),
  // sort dirs first then by name, cap, and only then stat the kept entries.
  const classified = await Promise.all(
    dirents.map(async (d) => {
      const rel = dir.rel ? `${dir.rel}/${d.name}` : d.name;
      let isDir = d.isDirectory();
      let statPath: string | null = path.join(dir.abs, d.name);
      let followed = false;
      if (d.isSymbolicLink()) {
        const target = await resolveWorkspacePath(root, rel).catch(() => null);
        if (target) {
          const ts = await stat(target.abs).catch(() => null);
          isDir = Boolean(ts?.isDirectory());
          statPath = ts ? target.abs : statPath;
          followed = Boolean(ts);
        }
      }
      return { name: d.name, rel, isDir, statPath, followed };
    }),
  );
  classified.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'fr') : a.isDir ? -1 : 1));
  const kept = classified.slice(0, MAX_LIST_ENTRIES);

  const logicalRoot = path.resolve(root);
  const entries = await Promise.all(
    kept.map(async (e): Promise<FileEntry | null> => {
      const s = await (e.followed ? stat(e.statPath!) : lstat(e.statPath!)).catch(() => null);
      if (!s) return null; // vanished meanwhile
      return {
        name: e.name,
        path: path.posix.join(logicalRoot, e.rel),
        type: e.isDir ? 'dir' : 'file',
        size: e.isDir ? 0 : s.size,
        modifiedAt: s.mtime.toISOString(),
      };
    }),
  );
  return entries.filter((e): e is FileEntry => e !== null);
}

export async function deleteWorkspacePath(root: string, requested: string): Promise<{ ok: true }> {
  // followLast: false → deleting a symlink removes the link, never its target.
  const target = await resolve(root, requested, { followLast: false, forbidRoot: true });
  const st = await lstat(target.abs).catch(() => null);
  if (!st) throw toHttpError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), target.display);
  try {
    await rm(target.abs, { recursive: true, force: false });
  } catch (err) {
    throw toHttpError(err, target.display);
  }
  return { ok: true };
}

export interface DownloadTarget {
  abs: string;
  name: string;
  size: number;
}

export async function prepareDownload(root: string, requested: string | undefined): Promise<DownloadTarget> {
  if (!requested) throw badRequest('Paramètre « path » requis.');
  const target = await resolve(root, requested);
  const st = await statOrThrow(target);
  if (!st.isFile()) throw badRequest(`« ${target.display} » n'est pas un fichier.`);
  return { abs: target.abs, name: path.basename(target.abs), size: st.size };
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
