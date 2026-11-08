import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { defaultTermdSocket, gitBashPath, isWindows } from '../../plugin-api/platform.ts';
import { registerTerminalRoutes, termdAbsent, terminalsService } from './routes.ts';
import { terminalRuns } from './terminalRuns.ts';
import { rotateLog } from './logRotate.ts';

export type { TerminalsService, TermInfo } from './routes.ts';

export default function register(ctx: ServerPluginContext): void {
  const { stateDir, repoRoot } = ctx.paths;
  // Old env names are still honoured as defaults (WORK_HUB_TERMD_SOCKET, WORK_HUB_TERMS_DIR, WORK_HUB_TERM_RUNS_DIR).
  const socket = ctx.config.get('socket', process.env.WORK_HUB_TERMD_SOCKET ?? defaultTermdSocket(stateDir));
  /** Saved terminal histories (the daemon's). */
  const dir = ctx.config.get('dir', process.env.WORK_HUB_TERMS_DIR ?? join(stateDir, 'terms'));
  /** Command files/logs for scripts run in a terminal (terminalRuns.ts, bin/wh-term-run). */
  const runsDir = ctx.config.get('runsDir', process.env.WORK_HUB_TERM_RUNS_DIR ?? join(stateDir, 'term-runs'));
  const autostart = ctx.config.get('autostart', true);

  const runs = terminalRuns({
    db: () => ctx.db.raw(),
    logEvent: (ws, kind, detail) => ctx.store.logEvent(ws, kind, detail),
    runsDir,
    wrapper: join(repoRoot, 'bin', 'wh-term-run'),
    lineOptions: () => (isWindows() ? { windows: true, shell: String(ctx.config.get('shell', '') ?? '').trim(), gitBash: gitBashPath() } : {}),
  });
  const service = terminalsService(ctx, { socket, runs });
  ctx.services.expose('terminals', service);

  // Polled by the Terminal page and the workspace tab strip.
  ctx.revalidate(['/api/workspaces/:id/terms', '/api/terms']);
  registerTerminalRoutes(ctx, { socket, runs }, service);

  ctx.onStart(async () => {
    runs.resume();
    if (!autostart || !(await termdAbsent(socket))) return;
    // No daemon on the socket: start one, detached (own process group), so restarting this server doesn't end its shells.
    // Same env as this server, minus NODE_ENV (the shells are yours: `pnpm install` there shouldn't skip dev deps).
    // termd.ts itself refuses to take a socket another daemon holds, so a race between two servers starts only one.
    const { NODE_ENV: _drop, ...env } = process.env;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const logFile = join(stateDir, 'termd.log');
    rotateLog(logFile); // over 5 MB: to termd.log.1 (one generation)
    const fd = openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [join(ctx.pluginDir, 'termd.ts')], {
      cwd: repoRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, WORK_HUB_TERMD_LOG: logFile, WORK_HUB_TERMD_SOCKET: socket, WORK_HUB_TERMS_DIR: dir, WORK_HUB_TERMD_BRIDGE: join(repoRoot, 'server', 'lib', 'ptybridge.py') },
    });
    closeSync(fd);
    child.on('error', (e) => ctx.log.error(`couldn't start the terminal daemon: ${e.message}`));
    child.unref();
    if (child.pid) ctx.log.info(`started the terminal daemon (pid ${child.pid}) on ${socket}, log ${logFile}`);
  });
}
