/**
 * "Apply now" after Settings → Plugins (or a setting marked `restart`): rebuild the web bundle and restart the server.
 *
 * `GET /api/server/apply` → `{ supervised, jobId }`: whether a restart will bring the server back by itself, and the
 * apply job running now (if any). `POST /api/server/apply` → 202 `{ jobId, supervised }`: starts an `apply` job that
 * builds the bundle (`vite build`, through this Node, so no pnpm on PATH is needed); then, if supervised, the server exits
 * and its supervisor (launchd's KeepAlive, systemd's Restart=always, the Windows task launcher's loop) starts it again,
 * on the new plugin set. Open tabs reload on the new build by themselves. Unsupervised (`pnpm start` in a terminal), it
 * only builds and says to restart by hand. A failed build fails the job and leaves the running server alone.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { listJobs, startJob, type Job } from './jobs.ts';

export const APPLY_KIND = 'apply';

/**
 * Will something restart this server when it exits? `WORK_HUB_SUPERVISED=1|0` says so outright; else yes when it was
 * started by one of the setup scripts' agents (they all set `WORK_HUB_REPO`: launchd plists, systemd units, Windows task
 * launchers) or by any systemd unit (`INVOCATION_ID`).
 */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WORK_HUB_SUPERVISED === '1') return true;
  if (env.WORK_HUB_SUPERVISED === '0') return false;
  return !!env.WORK_HUB_REPO || !!env.INVOCATION_ID;
}

/** `vite build` in the checkout; resolves with nothing, rejects with the tail of its output. */
export function runBuild(repoRoot: string, timeoutMs = 5 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`the build failed (exit ${code ?? 'killed'}): ${out.trim().split('\n').slice(-6).join(' | ')}`));
    });
  });
}

export interface ApplyDeps {
  repoRoot: string;
  supervised?: () => boolean;
  build?: (repoRoot: string) => Promise<void>;
  /** Ends the process for the supervisor to restart it (tests replace it). */
  exit?: () => void;
  /** How long after the job is marked done the server exits (so the tray and the reply see it finish). */
  exitDelayMs?: number;
}

const running = (): Job | undefined => listJobs().find((j) => j.kind === APPLY_KIND && j.status === 'running');

export function registerApplyRoutes(app: Hono, deps: ApplyDeps): void {
  const supervised = deps.supervised ?? (() => isSupervised());
  const build = deps.build ?? runBuild;
  const exit = deps.exit ?? (() => process.exit(0));

  app.get('/api/server/apply', (c) => c.json({ supervised: supervised(), jobId: running()?.id ?? null }));
  app.post('/api/server/apply', (c) => {
    const busy = running();
    if (busy) return c.json({ jobId: busy.id, supervised: supervised(), already: true }, 202);
    const willRestart = supervised();
    const job = startJob({ kind: APPLY_KIND, title: willRestart ? 'Applying changes (rebuild and restart)' : 'Rebuilding the app' }, async (progress) => {
      progress('Building the web bundle…');
      await build(deps.repoRoot);
      if (!willRestart) return { detail: 'Built. Restart the server to apply (nothing restarts it automatically here).' };
      setTimeout(exit, deps.exitDelayMs ?? 1500).unref?.();
      return { detail: 'Built; restarting the server…' };
    });
    return c.json({ jobId: job.id, supervised: willRestart }, 202);
  });
}
