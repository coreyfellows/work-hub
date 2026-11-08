import { join } from 'node:path';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { pluginDirArgs } from './launch.ts';

/** What this plugin shares (`ctx.services.get('ticket-workflow')`); the core's `ctx.paths.ticketWorkflowScripts` reads it. */
export interface TicketWorkflowService {
  /** The bundled Claude plugin's `scripts/` (`trust-worktree.sh`, `ensure-ticket-note.sh`, `config.sh`). */
  scriptsDir: string;
  /** The bundled Claude plugin's folder (what `--plugin-dir` loads). */
  claudeDir: string;
}

export default function register(ctx: ServerPluginContext): void {
  const dir = join(ctx.pluginDir, 'claude');
  const scriptsDir = join(dir, 'scripts');

  // The scripts read work-hub's config file; point them at this app's config dir (WORK_HUB_CONFIG_DIR may move it).
  // Children (the scripts the app runs, the sessions it starts) inherit it.
  process.env.WORK_HUB_TW_CONFIG ??= join(ctx.paths.configDir, 'ticket-workflow.env');

  // Asked on the first session start (the core caches a successful listing; a failed one answers false, so the bundled
  // copy is loaded, and is retried next time).
  const installed = () => ctx.claude.pluginInstalled('ticket-workflow', { scope: 'user', enabledOnly: true });
  ctx.sessions.addLaunchArgs(pluginDirArgs(dir, installed));

  ctx.services.expose('ticket-workflow', { scriptsDir, claudeDir: dir } satisfies TicketWorkflowService);
}
