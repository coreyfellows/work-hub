import { execFile } from 'node:child_process';
import { config } from '../config.ts';

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
}

/**
 * The folders in force (Settings → Folders, else env, else the defaults) as the env vars the ticket-workflow scripts and
 * everything else reads (TW_WORKTREES_ROOT in trust-worktree.sh, WORK_HUB_REPOS_DIR), so a command, and the Claude
 * sessions started this way, see the same folders as the app even when they were set in Settings and not the environment.
 */
export function folderEnv(): Record<string, string> {
  return { WORK_HUB_REPOS_DIR: config.paths.repos, TW_WORKTREES_ROOT: config.paths.worktrees };
}

/** Run a command without a shell (args are never interpolated) and return stdout. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...folderEnv(), ...opts.env },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).toString().trim().split('\n').slice(-5).join('\n');
          reject(new Error(`${cmd} ${args[0] ?? ''}: ${msg}`));
          return;
        }
        resolve(stdout.toString());
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function runJson<T>(cmd: string, args: string[], opts: ExecOptions = {}): Promise<T> {
  return JSON.parse(await run(cmd, args, opts)) as T;
}
