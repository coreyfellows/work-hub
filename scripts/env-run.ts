// `node scripts/env-run.ts KEY=value … -- <command> [args…]`: run a command with extra env vars on any platform (pnpm runs
// package.json scripts through cmd.exe on Windows, where `KEY=value command` doesn't work). `node` means this Node.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
if (sep < 1 || sep === args.length - 1) {
  console.error('usage: node scripts/env-run.ts KEY=value … -- <command> [args…]');
  process.exit(2);
}
const env = { ...process.env };
for (const kv of args.slice(0, sep)) {
  const i = kv.indexOf('=');
  if (i < 1) {
    console.error(`env-run: not KEY=value: ${kv}`);
    process.exit(2);
  }
  env[kv.slice(0, i)] = kv.slice(i + 1);
}
const [cmd, ...rest] = args.slice(sep + 1) as [string, ...string[]];
const child = spawn(cmd === 'node' ? process.execPath : cmd, rest, { stdio: 'inherit', env, shell: cmd !== 'node' && process.platform === 'win32' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
