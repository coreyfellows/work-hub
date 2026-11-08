import type { ServerPluginContext } from '../../../plugin-api/server.ts';
import { probeCommandNames, slashCommands } from './commands.ts';
import type { SlashCommand } from './shared/types.ts';

// Each probe starts every MCP server Claude is configured with (servers that cap sessions per account count them), so keep the answer a while.
const TTL_MS = 30 * 60_000;

export default function register(ctx: ServerPluginContext): void {
  // Polled by the prompt box's picker: unchanged answers are an empty 304.
  ctx.revalidate(['/api/sessions/:id/commands']);

  const cache = new Map<string, { at: number; commands: SlashCommand[] }>();
  const inflight = new Map<string, Promise<SlashCommand[]>>();

  /** The slash commands (skills, commands, plugin commands, built-ins) a session offers, for the prompt box's `/` picker. */
  ctx.app.get('/api/sessions/:id/commands', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const cwd = s.cwd;
    const hit = cache.get(cwd);
    if (hit && Date.now() - hit.at < TTL_MS) return c.json({ commands: hit.commands });
    // Names come from what Claude itself reports for the folder (a ~3s headless probe), descriptions from the files.
    let p = inflight.get(cwd);
    if (!p) {
      p = probeCommandNames(cwd).then((names) => slashCommands(cwd, undefined, names));
      inflight.set(cwd, p);
      void p.then((commands) => cache.set(cwd, { at: Date.now(), commands })).finally(() => inflight.delete(cwd));
    }
    return c.json({ commands: await p });
  });
}
