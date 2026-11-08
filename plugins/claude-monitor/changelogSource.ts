/**
 * Where the changelog comes from: a copy of the published CHANGELOG.md cached in the plugin's cache dir (fetched again
 * only when it lacks a version we need, at most every 10 minutes), else Claude Code's own cached copy
 * (`<claude config dir>/cache/changelog.md`). Whichever names the newer version wins.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newestIn, parseChangelog, type ChangelogEntry } from './changelog.ts';
import { compareVersions } from './version.ts';

export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const REFETCH_MS = 10 * 60_000;

interface Parsed {
  entries: ChangelogEntry[];
  newest: string | null;
  mtimeMs: number;
}

export interface ChangelogLoader {
  /** Entries covering `need` if any source has it (else the newest there is), and where they came from. */
  load(need: string | null): Promise<{ entries: ChangelogEntry[]; from: 'remote' | 'local' | null; error: string | null }>;
}

export function changelogLoader(opts: {
  cacheDir: string;
  url: () => string;
  fetchText?: (url: string) => Promise<string>;
  localFile?: () => string;
  now?: () => number;
}): ChangelogLoader {
  const cacheFile = join(opts.cacheDir, 'CHANGELOG.md');
  const localFile = opts.localFile ?? (() => join(claudeConfigDir(), 'cache', 'changelog.md'));
  const now = opts.now ?? Date.now;
  const fetchText =
    opts.fetchText ??
    (async (url: string) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.text();
    });
  const memo = new Map<string, Parsed>();
  let lastFetch = 0;

  const read = (file: string): Parsed | null => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    const hit = memo.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit;
    try {
      const entries = parseChangelog(readFileSync(file, 'utf8'));
      const p = { entries, newest: newestIn(entries), mtimeMs };
      memo.set(file, p);
      return p;
    } catch {
      return null;
    }
  };

  const covers = (p: Parsed | null, need: string | null) => !!p?.newest && (need === null || compareVersions(p.newest, need) >= 0);

  return {
    async load(need) {
      let error: string | null = null;
      let remote = read(cacheFile);
      if (!covers(remote, need) && now() - lastFetch > REFETCH_MS) {
        lastFetch = now();
        try {
          const text = await fetchText(opts.url());
          if (!parseChangelog(text).length) throw new Error('the changelog has no version sections');
          mkdirSync(opts.cacheDir, { recursive: true });
          writeFileSync(cacheFile, text);
          remote = read(cacheFile);
        } catch (e) {
          error = `couldn't fetch the changelog: ${(e as Error).message}`;
        }
      }
      const local = read(localFile());
      const pick = !remote ? local : !local ? remote : compareVersions(local.newest, remote.newest) > 0 ? local : remote;
      if (!pick) return { entries: [], from: null, error: error ?? 'no changelog found' };
      return { entries: pick.entries, from: pick === remote ? 'remote' : 'local', error: covers(pick, need) ? null : error };
    },
  };
}
