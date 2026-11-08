import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileSnap } from './since.ts';
import type { Thread } from './types.ts';

/**
 * One folder per PR under the plugin's state dir: `<root>/<host>/<owner>/<repo>/<number>/`, holding `summary.md` (the
 * document, addenda and rewrites included), `meta.json` (when and at which head it was written, the file snapshot for
 * "changed since", the question threads) and `history/` (earlier versions, kept when a summary is regenerated).
 */

export interface PrKey {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface Meta {
  version: 1;
  generatedAt: string | null;
  /** When the latest Update brought it to `headOid` (null until one has). */
  updatedAt: string | null;
  headOid: string | null;
  mergeBase: string | null;
  mode: 'git' | 'inline' | null;
  model: string | null;
  title: string;
  stats: { files: number; additions: number; deletions: number } | null;
  files: FileSnap[];
  threads: Thread[];
}

export const emptyMeta = (): Meta => ({
  version: 1,
  generatedAt: null,
  updatedAt: null,
  headOid: null,
  mergeBase: null,
  mode: null,
  model: null,
  title: '',
  stats: null,
  files: [],
  threads: [],
});

const SAFE = /^[A-Za-z0-9_.-]{1,100}$/;

export const keyId = (k: PrKey) => `${k.host}/${k.owner}/${k.repo}#${k.number}`;

export function prDir(root: string, k: PrKey): string {
  for (const part of [k.host, k.owner, k.repo]) if (!SAFE.test(part) || part === '.' || part === '..') throw new Error(`bad PR reference part: ${part}`);
  if (!Number.isInteger(k.number) || k.number <= 0) throw new Error('bad PR number');
  return join(root, k.host, k.owner, k.repo, String(k.number));
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

async function readOr<T>(path: string, fallback: T, parse: (s: string) => T): Promise<T> {
  try {
    return parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

export class SummaryStore {
  private locks = new Map<string, Promise<unknown>>();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  dir(k: PrKey): string {
    return prDir(this.root, k);
  }
  summaryPath(k: PrKey): string {
    return join(this.dir(k), 'summary.md');
  }

  readMeta(k: PrKey): Promise<Meta> {
    return readOr(join(this.dir(k), 'meta.json'), emptyMeta(), (s) => ({ ...emptyMeta(), ...(JSON.parse(s) as Partial<Meta>) }));
  }
  readSummary(k: PrKey): Promise<string | null> {
    return readOr<string | null>(this.summaryPath(k), null, (s) => s);
  }

  /** Read-modify-write of one PR's files, one at a time per PR (a regeneration and answers may finish together). */
  update<T>(k: PrKey, fn: (cur: { meta: Meta; summary: string | null }) => Promise<{ meta: Meta; summary?: string | null; result: T }> | { meta: Meta; summary?: string | null; result: T }): Promise<T> {
    const id = keyId(k);
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const cur = { meta: await this.readMeta(k), summary: await this.readSummary(k) };
      const out = await fn(cur);
      if (out.summary != null) {
        if (cur.summary !== null && (out.meta.generatedAt !== cur.meta.generatedAt || out.meta.headOid !== cur.meta.headOid)) {
          // A regeneration or an update: keep the old version (with its addenda) beside it.
          const stamp = (cur.meta.updatedAt ?? cur.meta.generatedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
          await writeAtomic(join(this.dir(k), 'history', `summary-${stamp}.md`), cur.summary);
        }
        if (out.summary !== cur.summary) await writeAtomic(this.summaryPath(k), out.summary);
      }
      await writeAtomic(join(this.dir(k), 'meta.json'), JSON.stringify(out.meta, null, 1));
      return out.result;
    });
    this.locks.set(id, next.catch(() => {}));
    return next;
  }
}
