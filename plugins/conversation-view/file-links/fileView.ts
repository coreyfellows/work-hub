import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Files named in a session's messages, shown read-only in a modal. A path counts only if it resolves to a real file
 * under a folder the session works in (its cwd, the workspace's worktrees) or a few known scratch/notes folders.
 */

export const MAX_FILE_BYTES = 1024 * 1024;

export interface ResolvedFile {
  path: string;
  line?: number;
}

/** `path`, `path:12`, `path:12:3`, `path#L12`, `~/x`: the path part and the line, if any. */
export function splitPathRef(raw: string): { path: string; line?: number } {
  let p = raw.trim();
  let line: number | undefined;
  const m = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(p);
  if (m) {
    line = Number(m[1] ?? m[2]);
    p = p.slice(0, m.index);
  }
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  return { path: p, line };
}

/** Secrets and git internals are never served, whatever folder they sit in. */
export function isSensitive(path: string): boolean {
  const parts = path.split(sep);
  if (parts.some((s) => s === '.git' || s === '.ssh' || s === '.aws' || s === '.gnupg')) return true;
  const name = parts[parts.length - 1] ?? '';
  return /^\.env(\.|$)/.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || name === 'token' || name === 'credentials';
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The real file a reference points at, or null. `bases` are where relative paths are tried, in order (session cwd,
 * worktrees); `allowed` are the folders a result may live in.
 */
export async function resolveFileRef(raw: string, bases: string[], allowed: string[]): Promise<ResolvedFile | null> {
  if (!raw || raw.length > 400 || raw.includes('\0')) return null;
  const { path, line } = splitPathRef(raw);
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  const candidates = isAbsolute(path) ? [path] : bases.map((b) => resolve(b, path));
  const roots = (await Promise.all(allowed.map((a) => realpath(a).catch(() => null)))).filter((r): r is string => !!r);
  for (const c of candidates) {
    const real = await realpath(c).catch(() => null);
    if (!real || isSensitive(real) || !roots.some((r) => inside(r, real))) continue;
    const st = await stat(real).catch(() => null);
    if (st?.isFile()) return { path: real, line };
  }
  return null;
}

export interface FileContent {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

export async function readFileForView(path: string): Promise<FileContent> {
  const st = await stat(path);
  const buf = await readFile(path);
  const head = buf.subarray(0, 8192);
  const binary = head.includes(0);
  const truncated = buf.length > MAX_FILE_BYTES;
  return {
    path,
    size: st.size,
    truncated,
    binary,
    content: binary ? '' : buf.subarray(0, MAX_FILE_BYTES).toString('utf8'),
  };
}

/** The folders a session's files may live in (`extraRoots`: what plugins added via `ctx.files.addRoot`). */
export function allowedRoots(cwd: string, worktrees: string[], extra: { worktreesRoot: string; reposRoot?: string; extraRoots?: string[] }): string[] {
  return [...new Set([cwd, ...worktrees, extra.worktreesRoot, extra.reposRoot ?? '', join(homedir(), 'notes'), '/tmp', ...(extra.extraRoots ?? [])].filter(Boolean))];
}
