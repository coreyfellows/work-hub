import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { branchHasChanges, worktreeDiff, type DiffMode } from './worktreeDiff.ts';

export default function register(ctx: ServerPluginContext): void {
  ctx.revalidate(['/api/workspaces/:id/diff', '/api/workspaces/:id/pr-changes']);

  /** For each recorded worktree (by id): would a PR from its branch have changes? null = unknown. Drives "Create PR". */
  ctx.app.get('/api/workspaces/:id/pr-changes', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    const entries = await Promise.all(ws.worktrees.map(async (t) => [t.id, await branchHasChanges(t)] as const));
    return c.json(Object.fromEntries(entries));
  });

  /** Diff of one of the workspace's worktrees: vs its base branch, the last commit, or what's staged. */
  ctx.app.get('/api/workspaces/:id/diff', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    const mode = c.req.query('mode') ?? 'base';
    if (mode !== 'base' && mode !== 'commit' && mode !== 'staged') return c.json({ error: 'mode must be base, commit or staged' }, 400);
    try {
      return c.json(await worktreeDiff(ws, c.req.query('path') ?? '', mode as DiffMode));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  ctx.services.expose('worktree-diff', { branchHasChanges });
}
