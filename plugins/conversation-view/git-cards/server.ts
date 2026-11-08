import type { HistoryEntry, ServerPluginContext, TranscriptEnricher } from '../../../plugin-api/server.ts';
import { commitDiff, parseGitOps, resolveGitOps, type GitOp } from './gitOps.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The core types `HistoryEntry.git` opaquely; this plugin is the one that writes it. */
const opsOf = (e: HistoryEntry): GitOp[] | undefined => e.git as GitOp[] | undefined;

/** Git operations in Bash commands: parsed when the call is made, resolved (reflog commits, push refs) once it has a result. */
export const gitEnricher: TranscriptEnricher<{ pending: Map<string, HistoryEntry> }> = {
  id: 'git',
  init: () => ({ pending: new Map() }),
  onToolUse(entry, tool, state) {
    const input = (tool.input ?? {}) as Record<string, unknown>;
    const cwd = isObj(tool.raw) ? tool.raw.cwd : undefined;
    const git: GitOp[] = tool.name === 'Bash' && typeof input.command === 'string' && typeof cwd === 'string' ? parseGitOps(input.command, cwd) : [];
    if (!git.length) return undefined;
    if (entry.id) state.pending.set(entry.id, entry);
    return { git };
  },
  /** Fills in finished Bash calls' git operations (commits from the reflog, push refs from the output), once each. */
  async resolve(_sid, _entries, state) {
    const ready = [...state.pending].filter(([, e]) => e.result !== undefined);
    for (const [id] of ready) state.pending.delete(id);
    await Promise.all(
      ready.map(async ([, e]) => {
        const ops = opsOf(e);
        if (!ops) return;
        e.git = await resolveGitOps(ops, e.result ?? '', e.at, e.doneAt ?? null).catch(() => ops);
      }),
    );
    return ready.length > 0;
  },
};

export default function register(ctx: ServerPluginContext): void {
  ctx.transcript.addEnricher(gitEnricher);
  ctx.revalidate(['/api/sessions/:id/commit-diff']);

  /** Whether the session's log shows commit `sha` in repo `dir` (every page of its history, newest first). */
  async function sessionShowsCommit(sessionId: string, dir: string, sha: string): Promise<boolean> {
    let before: number | undefined;
    for (;;) {
      const page = await ctx.sessions.readHistory(sessionId, { before, limit: 500 }).catch(() => null);
      if (!page) return false;
      if (page.entries.some((e) => opsOf(e)?.some((o) => o.dir === dir && o.commits?.some((k) => k.sha === sha)))) return true;
      if (page.start <= 0) return false;
      before = page.start;
    }
  }

  /** The file diffs of a commit shown in the session's log (only those; see gitOps.ts). */
  ctx.app.get('/api/sessions/:id/commit-diff', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const dir = c.req.query('dir') ?? '';
    const sha = c.req.query('sha') ?? '';
    if (!(await sessionShowsCommit(s.sessionId, dir, sha))) return c.json({ error: 'commit not in this session' }, 404);
    return c.json({ files: await commitDiff(dir, sha).catch(() => []) });
  });
}
