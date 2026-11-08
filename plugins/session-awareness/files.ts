import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Digest } from './digest.ts';

/**
 * Where the digests live, so the hook (a separate process, no HTTP) can read them:
 *   <dir>/digests/<workspaceId>.json and .md   the digest and its Markdown
 *   <dir>/sessions/<sessionId>.json             { workspaceId } for every session in a digest
 *   <dir>/seen/<sessionId>.json                 written by the hook only (what it has already reported)
 */
export function digestPaths(dir: string, workspaceId: string): { json: string; md: string } {
  return { json: join(dir, 'digests', `${workspaceId}.json`), md: join(dir, 'digests', `${workspaceId}.md`) };
}

export function sessionMapPath(dir: string, sessionId: string): string {
  return join(dir, 'sessions', `${sessionId}.json`);
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

/** Session ids whose map file points at `workspaceId`. */
async function mappedSessions(dir: string, workspaceId: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(join(dir, 'sessions'));
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const m = JSON.parse(await readFile(join(dir, 'sessions', n), 'utf8')) as { workspaceId?: string };
      if (m.workspaceId === workspaceId) out.push(n.slice(0, -5));
    } catch {
      /* unreadable: leave it */
    }
  }
  return out;
}

/** A session's map file and the hook's `seen` file. */
async function dropSession(dir: string, sid: string): Promise<void> {
  await rm(sessionMapPath(dir, sid), { force: true });
  await rm(join(dir, 'seen', `${sid}.json`), { force: true });
}

/** Write a workspace's digest (atomically) and point every session in it at the workspace; sessions that left lose their map. */
export async function writeDigest(dir: string, digest: Digest, md: string): Promise<void> {
  await mkdir(join(dir, 'digests'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  const { json, md: mdPath } = digestPaths(dir, digest.workspaceId);
  await writeAtomic(json, JSON.stringify(digest));
  await writeAtomic(mdPath, md);
  const keep = new Set(digest.blocks.map((b) => b.sessionId));
  for (const sid of await mappedSessions(dir, digest.workspaceId)) if (!keep.has(sid)) await dropSession(dir, sid);
  for (const sid of keep) await writeAtomic(sessionMapPath(dir, sid), JSON.stringify({ workspaceId: digest.workspaceId }));
}

export async function removeDigest(dir: string, workspaceId: string): Promise<void> {
  for (const sid of await mappedSessions(dir, workspaceId)) await dropSession(dir, sid);
  const { json, md } = digestPaths(dir, workspaceId);
  await rm(json, { force: true });
  await rm(md, { force: true });
}

export async function readDigest(dir: string, workspaceId: string): Promise<Digest | null> {
  try {
    return JSON.parse(await readFile(digestPaths(dir, workspaceId).json, 'utf8')) as Digest;
  } catch {
    return null;
  }
}
