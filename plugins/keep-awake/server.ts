import { spawn } from 'node:child_process';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { keepAwakeCommand, platform } from '../../plugin-api/platform.ts';
import { createKeepAwake, type Hold } from './awake.ts';

/**
 * Hold the machine awake (`keepAwakeCommand`: `caffeinate -i -w <pid>` on macOS, `systemd-inhibit` on Linux, a hidden
 * PowerShell holding SetThreadExecutionState on Windows): no idle system sleep while it runs, the display may still sleep
 * and closing the lid still suspends, and it ends with the server even if the server is killed.
 */
function holdAwake(log: (m: string) => void, onLost: () => void): Hold | null {
  const { cmd, args } = keepAwakeCommand(process.pid);
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  let live = true;
  child.on('error', (err) => {
    live = false;
    log(`${cmd} failed: ${err.message}`);
    onLost();
  });
  child.on('exit', () => {
    if (!live) return;
    live = false;
    onLost();
  });
  child.unref();
  return {
    stop() {
      live = false;
      child.kill();
    },
  };
}

export default function register(ctx: ServerPluginContext): void {
  // Linux and Windows are experimental (never run there yet): see README.
  if (platform() !== 'darwin') ctx.log.info(`keep-awake on ${platform()} is experimental`);
  const log = (m: string) => ctx.log.info(m);
  const keep = createKeepAwake({
    graceMs: ctx.config.get('graceMs', 120_000),
    now: Date.now,
    acquire: (onLost) => holdAwake(log, onLost),
    log,
  });
  const check = () => void keep.update(ctx.sessions.list());

  // With no browser open the claude source doesn't poll, so look at the sessions ourselves (free: `claude agents`, no tokens).
  ctx.onStart(() => {
    const pollMs = ctx.config.get('pollMs', 30_000);
    const timer = setInterval(() => {
      ctx.registry.refresh('claude').then(check, check);
    }, pollMs);
    timer.unref();
    ctx.registry.on('change', (s) => {
      if (s.id === 'claude') check();
    });
    check();
  });
  process.once('exit', () => keep.stop());
}
