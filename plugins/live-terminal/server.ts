import { join } from 'node:path';
import { ansiToHtml, type ServerPluginContext } from '../../plugin-api/server.ts';
import { registerLiveTerminal } from './live.ts';

export default function register(ctx: ServerPluginContext): void {
  // The snapshot is polled by the Terminal view's fallback and the Chat view's working bubble.
  ctx.revalidate(['/api/sessions/:id/screen']);

  /** The current screen as HTML: `claude logs` (the raw terminal stream) replayed through a headless xterm. */
  ctx.app.get('/api/sessions/:id/screen', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const lines = Math.min(Number(c.req.query('lines') ?? 120), 2000);
    try {
      // Background jobs: `claude logs` is the raw terminal stream, so colours come out exact.
      if (s.kind === 'background') {
        const raw = await ctx.exec.run('claude', ['logs', s.shortId], { timeoutMs: 10_000 }).catch(() => null);
        if (raw) return c.json({ source: 'logs', exact: true, html: await ansiToHtml(raw, lines) });
      }
      return c.json({ source: 'none', exact: false, html: '' });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  registerLiveTerminal({
    app: ctx.app,
    upgradeWebSocket: ctx.upgradeWebSocket,
    bridge: join(ctx.paths.repoRoot, 'server', 'lib', 'ptybridge.py'),
    findSession: ctx.sessions.find,
  });
}
