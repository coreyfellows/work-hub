import { readJson, type ServerPluginContext } from '../../../plugin-api/server.ts';
import { allowedRoots, readFileForView, resolveFileRef } from './fileView.ts';

export default function register(ctx: ServerPluginContext): void {
  /** Where a session's relative paths are tried (cwd first, then its workspace's worktrees) and what it may show. */
  function fileScope(s: { sessionId: string; cwd: string }): { bases: string[]; allowed: string[] } {
    const wsId = ctx.store.sessionOwners().get(s.sessionId);
    const trees = (wsId ? ctx.store.getWorkspace(wsId)?.worktrees ?? [] : []).map((t) => t.path);
    const bases = [...new Set([s.cwd, ...trees])];
    return { bases, allowed: allowedRoots(s.cwd, trees, { worktreesRoot: ctx.paths.worktreesDir, reposRoot: ctx.paths.reposDir, extraRoots: ctx.files.roots() }) };
  }

  /** Which of these path-looking strings from a message are real files this session may show: raw -> {path, line} | null. */
  ctx.app.post('/api/sessions/:id/files/resolve', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const { paths } = await readJson<{ paths?: string[] }>(c);
    if (!Array.isArray(paths) || paths.length > 50) return c.json({ error: 'paths required (max 50)' }, 400);
    const scope = fileScope(s);
    const out: Record<string, { path: string; line?: number } | null> = {};
    await Promise.all(paths.filter((p) => typeof p === 'string').map(async (p) => (out[p] = await resolveFileRef(p, scope.bases, scope.allowed))));
    return c.json({ files: out });
  });

  /** A file named in the session's messages (read-only; must resolve under the session's folders, see fileView.ts). */
  ctx.app.get('/api/sessions/:id/file', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const scope = fileScope(s);
    const hit = await resolveFileRef(c.req.query('path') ?? '', scope.bases, scope.allowed);
    if (!hit) return c.json({ error: 'file not found' }, 404);
    return c.json({ ...(await readFileForView(hit.path)), line: hit.line });
  });
}
