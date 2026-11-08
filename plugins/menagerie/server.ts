import { join } from 'node:path';
import { HOST_ENRICHER_ID, type ServerPluginContext } from '../../plugin-api/server.ts';
import { hostEnricher } from './hostEnricher.ts';
import { CastStore } from './castStore.ts';
import { createGenerator } from './generate.ts';
import { menagerieHosts } from './hosts.ts';
import { seedOnce } from './seed.ts';
import { BASE, registerRoutes } from './routes.ts';

export default function register(ctx: ServerPluginContext): void {
  // The user's cast: generated, imported or edited through the settings page (castStore.ts).
  const store = new CastStore(join(ctx.paths.pluginState, 'cast.json'));
  // Load the slim bundled mod into every session the app starts, pointed at the cast file. A user-scope `menagerie`
  // (the old full plugin) is turned off for those sessions, so the generated cast wins and asides don't double up.
  ctx.sessions.addLaunchArgs(menagerieLaunchArgs(ctx.pluginDir, store.path, () => ctx.claude.pluginId('menagerie')));
  // The resident host the transcript names, before any aside: `host` on GET /api/sessions/:id/history.
  ctx.transcript.addEnricher(hostEnricher(HOST_ENRICHER_ID));
  // The hosts, for styling their asides in the log ([]: no cast yet, nothing is themed).
  ctx.revalidate(['/api/menagerie/hosts']);
  ctx.app.get('/api/menagerie/hosts', async (c) => c.json(await menagerieHosts(store)));
  // Generating characters: user-triggered only, as background jobs, a headless run with no tools. Read per job, so a
  // change in Settings applies to the next one.
  const model = () => ctx.config.get('model', 'opus');
  const gen = createGenerator({
    store,
    model,
    startJob: ctx.jobs.start,
    ask: (prompt) => ctx.headless.askClaudeJson('menagerie', prompt, { model: model(), tools: 'none', maxTurns: 2, timeoutMs: 10 * 60_000 }),
  });
  ctx.revalidate([`${BASE}/pending`]);
  registerRoutes(ctx.app, { gen, store });
  // Characters named on the first-run page: generated once, the first time the plugin starts with an empty cast.
  ctx.onStart(async () => {
    const n = await seedOnce({ seed: ctx.config.get('seed', ''), store, dir: ctx.paths.pluginState, add: gen.add });
    if (n) ctx.log.info(`menagerie: generating ${n} character(s) from the first-run page`);
  });
}

/**
 * Launch args for sessions the app starts: `--plugin-dir` for the bundled mod, and inline settings carrying the cast
 * path (the mod reads WORK_HUB_MENAGERIE_CAST) and, when the user has their own `menagerie` installed, turning it off.
 */
export const menagerieLaunchArgs =
  (pluginDir: string, castFile: string, userCopy: () => Promise<string | null>) => async (): Promise<string[]> => {
    const id = await userCopy();
    const settings = { env: { WORK_HUB_MENAGERIE_CAST: castFile }, ...(id && { enabledPlugins: { [id]: false } }) };
    return ['--plugin-dir', join(pluginDir, 'claude'), '--settings', JSON.stringify(settings)];
  };
