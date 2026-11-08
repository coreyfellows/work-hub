/**
 * The tools the app needs on this machine, checked on demand for the first-run page (nothing is installed or changed):
 * Node's version, git, jq, Python 3 (the pty bridge; on Windows with pywinpty), the `claude` and `gh` CLIs and whether they're signed in, and
 * `~/.claude.json` (worktree trust writes to it, so Claude must have run once).
 */
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isWindows, pythonCommand } from './platform.ts';

export interface PrereqCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Required for the app to work (false: a feature or plugin needs it). */
  required: boolean;
  detail: string;
}

type Run = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export function nodeCheck(version: string): PrereqCheck {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return { id: 'node', label: 'Node 26 or newer', required: true, ok: major >= 26, detail: major >= 26 ? version : `${version}: the server runs TypeScript directly and needs Node 26` };
}

async function tool(run: Run, id: string, label: string, cmd: string, args: string[], required: boolean, hint: string): Promise<PrereqCheck> {
  try {
    const out = (await run(cmd, args, { timeoutMs: 10_000 })).trim().split('\n')[0] ?? '';
    return { id, label, required, ok: true, detail: out || 'found' };
  } catch {
    return { id, label, required, ok: false, detail: hint };
  }
}

/** Windows: the pty bridge runs on ConPTY through pywinpty. */
function winpty(run: Run): Promise<PrereqCheck> {
  return tool(run, 'pywinpty', 'pywinpty (Python)', pythonCommand(), ['-c', 'import winpty; print("pywinpty found")'], true, `pywinpty not installed: run \`${pythonCommand()} -m pip install pywinpty\` (the live terminal and typing into sessions need it)`);
}

export async function runPrereqs(run: Run, opts: { home?: string; nodeVersion?: string } = {}): Promise<PrereqCheck[]> {
  const home = opts.home ?? homedir();
  const claudeLogin = async (): Promise<PrereqCheck> => {
    const base = { id: 'claude-auth', label: 'Claude signed in', required: true };
    try {
      const s = JSON.parse(await run('claude', ['auth', 'status', '--json'], { timeoutMs: 15_000 })) as { loggedIn?: boolean };
      return { ...base, ok: !!s.loggedIn, detail: s.loggedIn ? 'signed in' : 'not signed in: run `claude auth login`' };
    } catch {
      return { ...base, ok: false, detail: 'could not check: is `claude` installed?' };
    }
  };
  const ghLogin = async (): Promise<PrereqCheck> => {
    const base = { id: 'gh-auth', label: 'GitHub CLI signed in', required: false };
    try {
      await run('gh', ['auth', 'status'], { timeoutMs: 15_000 });
      return { ...base, ok: true, detail: 'signed in' };
    } catch {
      return { ...base, ok: false, detail: 'not signed in: run `gh auth login` (the PR features need it)' };
    }
  };
  const claudeJson = async (): Promise<PrereqCheck> => {
    const file = join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json');
    const ok = await access(file).then(() => true, () => false);
    return { id: 'claude-json', label: 'Claude has run on this machine', required: true, ok, detail: ok ? file : `${file} not found: start \`claude\` once` };
  };
  return Promise.all([
    Promise.resolve(nodeCheck(opts.nodeVersion ?? process.version)),
    tool(run, 'git', 'git', 'git', ['--version'], true, 'git not found on PATH'),
    tool(run, 'python3', 'Python 3', pythonCommand(), ['--version'], true, `${pythonCommand()} not found on PATH (the live terminal and typing into sessions need it; or set WORK_HUB_PYTHON)`),
    ...(isWindows() ? [winpty(run)] : []),
    tool(run, 'jq', 'jq', 'jq', ['--version'], false, 'jq not found on PATH (the Bash-changes snapshots need it)'),
    tool(run, 'claude', 'claude CLI', 'claude', ['--version'], true, 'claude not found on PATH'),
    tool(run, 'gh', 'GitHub CLI (gh)', 'gh', ['--version'], false, 'gh not found on PATH (the PR features need it)'),
    claudeLogin(),
    ghLogin(),
    claudeJson(),
  ]);
}
