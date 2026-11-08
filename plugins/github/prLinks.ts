import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReconcilePass } from '../../plugin-api/server.ts';
import type { PullRequest } from './types.ts';

/** Branches too generic to tie a PR to a workspace by name alone. */
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

/** `https://host/owner/repo/pull/12` → `repo#12`. */
export function prLabel(url: string): string | null {
  const m = url.match(/\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/);
  return m ? `${m[1]}#${m[2]}` : null;
}

const normUrl = (u: string) => u.replace(/\/+$/, '');

/** PR URLs a background job worked on: its `~/.claude/jobs/<shortId>/state.json` `children` of kind `pr`. */
async function prChildren(jobsDir: string, shortId: string): Promise<string[]> {
  try {
    const job = JSON.parse(await readFile(join(jobsDir, shortId, 'state.json'), 'utf8')) as { children?: Array<{ kind?: string; href?: string }> };
    return (job.children ?? []).filter((c) => c.kind === 'pr' && typeof c.href === 'string').map((c) => normUrl(c.href!));
  } catch {
    return [];
  }
}

/**
 * The reconcile pass linking PRs to workspaces: the ones each workspace job worked on (its state.json `children`), then
 * open PRs (mine and review-requested, from `prs()`) on a recorded worktree's branch. A URL some workspace already
 * links is never claimed again.
 */
export function linkPrsPass(prs: () => PullRequest[], jobsDir = join(homedir(), '.claude', 'jobs')): ReconcilePass {
  return async ({ sessions, store }) => {
    let changed = false;
    const owners = store.sessionOwners();
    const worktrees = store.allWorktrees();
    const linked = new Set([...store.linkedUrls()].map(normUrl));
    const link = (ws: string, url: string, why: string) => {
      if (linked.has(url)) return;
      store.addLink(ws, { kind: 'pr', url, label: prLabel(url) });
      store.logEvent(ws, 'link', `${prLabel(url) ?? url} (${why})`);
      linked.add(url);
      changed = true;
    };
    for (const s of sessions) {
      const ws = owners.get(s.sessionId);
      if (!ws || s.kind !== 'background') continue;
      for (const url of await prChildren(jobsDir, s.shortId)) link(ws, url, `from session ${s.shortId}`);
    }
    for (const pr of prs()) {
      if (SHARED_BRANCHES.has(pr.branch)) continue;
      const owner = new Set(worktrees.filter((w) => w.branch === pr.branch && w.repo?.toLowerCase() === pr.repo.toLowerCase()).map((w) => w.workspaceId));
      if (owner.size === 1) link([...owner][0], normUrl(pr.url), `branch ${pr.branch}`);
    }
    return changed;
  };
}
