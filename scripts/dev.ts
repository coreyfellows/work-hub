// Runs the API (with --watch) and the Vite dev server together; Ctrl-C stops both.
import { spawn } from 'node:child_process';

// WORK_HUB_DEV=1 lets the API accept the Vite dev server's authorities (server/config.ts `devMode`).
const env = { ...process.env, WORK_HUB_DEV: '1' };
const procs = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], { stdio: 'inherit', env }),
  // pnpm is a .cmd shim on Windows, which only runs through a shell.
  spawn('pnpm', ['exec', 'vite'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
