import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { computeStats } from './stats.ts';

export default function register(ctx: ServerPluginContext): void {
  ctx.revalidate(['/api/sessions/:id/stats']);

  /** Tokens, API-equivalent cost and changed files for a session (from its transcript). */
  ctx.app.get('/api/sessions/:id/stats', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const [usage, edits] = await Promise.all([ctx.sessions.sessionUsage(s.sessionId), ctx.sessions.sessionEdits(s.sessionId)]);
    if (!usage || !edits) return c.json(null);
    return c.json(computeStats(usage, edits));
  });
}
