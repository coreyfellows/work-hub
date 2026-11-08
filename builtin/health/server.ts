import { mkdirSync } from 'node:fs';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { githubHostResolver, healthSource } from './source.ts';

/** A comma-separated string (env var) or a list (plugins.json) → trimmed names. */
function names(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? '').split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

export default function register(ctx: ServerPluginContext): void {
  // Old env names are still honoured as defaults (WORK_HUB_HEALTH_INTERVAL_MS is already this plugin's own name).
  const watchedMcp = names(ctx.config.get<unknown>('watchedMcp', process.env.WORK_HUB_WATCHED_MCP ?? ''));
  // A configured host (settings.health.githubHost, WORK_HUB_HEALTH_GITHUB_HOST, or the shared WORK_HUB_GH_HOST) wins;
  // otherwise the github plugin's resolved host, else github.com.
  const githubHost = githubHostResolver(ctx.config.get<string | undefined>('githubHost', process.env.WORK_HUB_GH_HOST), () => {
    try {
      return ctx.services.get<{ host(): Promise<string> }>('github');
    } catch {
      return undefined; // the github plugin is off
    }
  });
  mkdirSync(ctx.paths.cacheDir, { recursive: true });
  ctx.registry.add(
    healthSource({
      intervalMs: ctx.config.get('intervalMs', 5 * 60_000),
      watchedMcp,
      githubHost,
      scratchDir: ctx.paths.cacheDir,
      exec: ctx.exec,
    }),
  );
}
