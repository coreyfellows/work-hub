import type { FileEdit, Session, Workspace } from '../../plugin-api/server.ts';
import { cleanPath, within } from './paths.ts';
import { buildDigest, type Digest, type DigestInput } from './digest.ts';

/** Gathers a workspace's digest inputs from the host (all local, no tokens) and builds the digest. */
export interface Collector {
  /** null when the workspace is missing or done. */
  collect(workspaceId: string): Promise<Digest | null>;
}

type Commit = { sha: string; subject: string };

const HIDDEN = new Set(['done', 'stopped']);
const MAX_DIGEST_CHARS = 4000;
/** `git rev-parse HEAD` runs at most this often per folder. */
const HEAD_MEMO_MS = 30_000;
const OVERLAP_WINDOW_MS = 2 * 3_600_000;

/** The recorded worktree a session runs in first, then the recorded ones it is bound to (matched by their exact path). */
export function sessionWorktrees(recorded: Workspace['worktrees'], cwd: string, bound: string[]): Workspace['worktrees'] {
  const start = recorded.find((t) => within(cwd, t.path));
  const more = bound.map((p) => recorded.find((t) => cleanPath(t.path) === cleanPath(p))).filter((t): t is Workspace['worktrees'][number] => !!t && t !== start);
  return [...(start ? [start] : []), ...more].filter((t, i, a) => a.indexOf(t) === i);
}

export function createCollector(deps: {
  getWorkspace: (id: string) => Workspace | null;
  listEvents: (id: string, o: { types: string[]; limit: number }) => Array<{ at: string; type: string; detail: string | null; sessionId: string | null }>;
  liveSessions: () => Session[];
  /** When the claude source last changed (status/PR facts are that fresh); null before it ever did. */
  liveAt: () => number | null;
  boundWorktrees: (sessionId: string) => string[];
  sessionEdits: (sessionId: string) => Promise<FileEdit[] | null>;
  /** [] when the github plugin is off. */
  prs: () => DigestInput['prs'];
  gitLog: (cwd: string, base: string | null) => Promise<Commit[]>;
  settings: () => { maxBlockChars: number };
  now?: () => number;
}): Collector {
  const now = deps.now ?? Date.now;
  return {
    async collect(workspaceId) {
      const ws = deps.getWorkspace(workspaceId);
      if (!ws || ws.status === 'done') return null;
      const empty = () => buildDigest({ workspaceId, now: now(), liveAt: deps.liveAt(), sessions: [], worktrees: {}, events: [], prs: [], commits: {}, edits: {}, maxBlockChars: deps.settings().maxBlockChars, maxDigestChars: MAX_DIGEST_CHARS, overlapWindowMs: OVERLAP_WINDOW_MS });
      // Cheap early-out: nobody recorded, nobody open: no events, transcripts or git.
      if (!ws.sessions.length) return empty();
      const live = new Map(deps.liveSessions().map((s) => [s.sessionId, s]));
      const sessions: DigestInput['sessions'] = [];
      const worktrees: DigestInput['worktrees'] = {};
      for (const rec of ws.sessions) {
        const s = live.get(rec.claudeSessionId);
        if (!s || HIDDEN.has(s.status)) continue;
        sessions.push({
          sessionId: s.sessionId,
          shortId: rec.shortId,
          name: rec.name ?? s.name ?? null,
          role: rec.role,
          status: s.status,
          intent: s.intent,
          startedAt: s.startedAt,
          lastActiveAt: s.lastActiveAt,
          branch: s.branch,
          repo: s.repo,
        });
        worktrees[s.sessionId] = sessionWorktrees(ws.worktrees, s.cwd, deps.boundWorktrees(s.sessionId)).map((t) => ({ path: t.path, repo: t.repo, branch: t.branch, baseBranch: t.baseBranch }));
      }
      if (!sessions.length) return empty();
      const events = deps.listEvents(workspaceId, { types: ['claim', 'done'], limit: 200 });
      const commits: DigestInput['commits'] = {};
      const edits: DigestInput['edits'] = {};
      await Promise.all(
        sessions.map(async (s) => {
          const wt = worktrees[s.sessionId]?.[0];
          if (wt && !(wt.path in commits)) commits[wt.path] = await deps.gitLog(wt.path, wt.baseBranch).catch(() => []);
          const list = await deps.sessionEdits(s.sessionId).catch(() => null);
          edits[s.sessionId] = (list ?? []).map((e) => ({ path: e.path, at: e.at ? Date.parse(e.at) || null : null }));
        }),
      );
      return buildDigest({
        workspaceId,
        now: now(),
        liveAt: deps.liveAt(),
        sessions,
        worktrees,
        events,
        prs: deps.prs(),
        commits,
        edits,
        maxBlockChars: deps.settings().maxBlockChars,
        maxDigestChars: MAX_DIGEST_CHARS,
        overlapWindowMs: OVERLAP_WINDOW_MS,
      });
    },
  };
}

/**
 * `git log` of a worktree's branch against its base, cached per folder by HEAD (one `rev-parse` per folder per 30 s, the log only
 * when HEAD moved). [] on any git failure (not a repo, no base).
 */
export function createGitLog(
  run: (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<string>,
  baseRef: (cwd: string, recorded: string | null) => Promise<string | null>,
  now: () => number = Date.now,
): (cwd: string, base: string | null) => Promise<Commit[]> {
  const cache = new Map<string, { head: string; commits: Commit[]; checkedAt: number }>();
  return async (cwd, base) => {
    try {
      // A burst of source changes asks again within moments: trust the last answer for a while.
      const recent = cache.get(cwd);
      if (recent && now() - recent.checkedAt < HEAD_MEMO_MS) return recent.commits;
      const head = (await run('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 5000 })).trim();
      const hit = cache.get(cwd);
      if (hit && hit.head === head) {
        hit.checkedAt = now();
        return hit.commits;
      }
      const ref = await baseRef(cwd, base);
      const range = ref ? `${ref}..HEAD` : 'HEAD';
      const out = await run('git', ['log', '--format=%h%x09%s', '-n', '3', range], { cwd, timeoutMs: 10_000 });
      const commits = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, ...rest] = l.split('\t');
          return { sha, subject: rest.join('\t') };
        });
      cache.set(cwd, { head, commits, checkedAt: now() });
      return commits;
    } catch {
      return [];
    }
  };
}
