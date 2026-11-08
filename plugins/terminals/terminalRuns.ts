import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Scripts run in a new workspace terminal (a card's "▶ Terminal" button), with their output kept like a Run's:
 * the terminal gets `bin/wh-term-run <id>`, which runs the command (from term-runs/<id>.cmd) under script(1),
 * so it still has a real terminal, logging what it prints to <id>.log and its exit code to <id>.exit. Once
 * the exit file appears the cleaned-up log and exit code are saved on the run's command_runs row (via=terminal)
 * and the files are removed. Watched for up to WATCH_MS (interactive scripts can sit at a prompt), resumed at startup.
 *
 * The rows are the core's `command_runs` table (via = 'terminal', migration 6); this file owns the terminal ones.
 */

const POLL_MS = 3_000;
const WATCH_MS = 6 * 60 * 60_000;
const MAX_OUTPUT = 512_000;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** A word for bash: as is when it's plain, else single-quoted. */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** A word for PowerShell: always single-quoted ('' inside). */
const psWord = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Git Bash takes C:/x/y for C:\x\y. */
const fwd = (s: string) => s.replace(/\\/g, '/');

/**
 * The line typed into a new terminal to run `bin/wh-term-run <id> <dir>`. macOS and Linux: as is, for the login shell.
 * Windows: the wrapper is a bash script, so it goes through Git Bash; typed as a PowerShell call (the default shell)
 * unless the terminals' shell is itself a bash/sh/zsh, which takes it as is (with forward slashes).
 */
export function wrapperLine(wrapper: string, runId: number, dir: string, opts: { windows?: boolean; shell?: string; gitBash?: string | null } = {}): string {
  if (!opts.windows) return `${shellWord(wrapper)} ${runId} ${shellWord(dir)}`;
  const shellName = (opts.shell ?? '').split(/[\\/]/).pop()!.toLowerCase();
  if (/^(ba|z)?sh(\.exe)?$/.test(shellName)) return `${shellWord(fwd(wrapper))} ${runId} ${shellWord(fwd(dir))}`;
  if (!opts.gitBash) throw new Error('Git Bash not found: install Git for Windows (winget install Git.Git) or set CLAUDE_CODE_GIT_BASH_PATH');
  return `& ${psWord(opts.gitBash)} ${psWord(fwd(wrapper))} ${runId} ${psWord(fwd(dir))}`;
}

export interface TerminalRunsDeps {
  db(): DatabaseSync;
  logEvent(workspaceId: string, kind: string, detail?: string): void;
  /** Where the .cmd/.log/.exit files go (also handed to the wrapper, so its default doesn't matter). */
  runsDir: string;
  /** Absolute path of bin/wh-term-run. */
  wrapper: string;
  /** How to type the wrapper's line (Windows: through Git Bash unless the terminals' shell is a bash); see wrapperLine. */
  lineOptions?: () => { windows?: boolean; shell?: string; gitBash?: string | null };
}

export interface TerminalRuns {
  /** Record the run and write its command file; returns the run's id and the line to type into the terminal. */
  start(sessionId: string, workspaceId: string, command: string): Promise<{ runId: number; line: string }>;
  /** Which terminal the run went into. */
  noteTerminal(runId: number, termId: string): void;
  /** After a restart: keep watching terminal runs that haven't finished. */
  resume(): void;
}

export function terminalRuns(deps: TerminalRunsDeps): TerminalRuns {
  const DIR = deps.runsDir;

  /** A run started in a new workspace terminal: "ran" from the start (it's typed straight in), output to come. */
  const addRun = (sessionId: string, workspaceId: string, command: string): number =>
    Number(
      (
        deps
          .db()
          .prepare(`INSERT INTO command_runs (session_id, workspace_id, command, status, via, done_at) VALUES (?, ?, ?, 'ran', 'terminal', ${NOW}) RETURNING id`)
          .get(sessionId, workspaceId, command) as { id: number }
      ).id,
    );

  /** A terminal run finished (or was given up on, exitCode null): its output and exit code. */
  const recordResult = (id: number, output: string, exitCode: number | null, error?: string): void => {
    deps
      .db()
      .prepare(`UPDATE command_runs SET output = ?, exit_code = ?, output_at = ${NOW}, error = ?, stderr = 0 WHERE id = ?`)
      .run(output, exitCode, error ?? null, id);
  };

  async function finish(id: number, exitCode: number | null, error?: string): Promise<void> {
    const raw = await readFile(join(DIR, `${id}.log`), 'utf8').catch(() => '');
    const out = cleanTerminalLog(raw);
    recordResult(id, out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}…` : out, exitCode, error);
    for (const ext of ['cmd', 'log', 'exit']) await rm(join(DIR, `${id}.${ext}`), { force: true });
  }

  async function watch(id: number, startedAt: number): Promise<void> {
    const exitFile = join(DIR, `${id}.exit`);
    while (Date.now() - startedAt < WATCH_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!existsSync(exitFile)) continue;
      const code = Number.parseInt((await readFile(exitFile, 'utf8').catch(() => '')).trim(), 10);
      return finish(id, Number.isNaN(code) ? null : code);
    }
    return finish(id, null, 'still running after 6h; saved what it had printed');
  }

  return {
    async start(sessionId, workspaceId, command) {
      const line = (id: number) => wrapperLine(deps.wrapper, id, DIR, deps.lineOptions?.());
      line(0); // fail before recording anything when it can't be run (no Git Bash on Windows)
      await mkdir(DIR, { recursive: true, mode: 0o700 });
      const runId = addRun(sessionId, workspaceId, command);
      await writeFile(join(DIR, `${runId}.cmd`), command, { mode: 0o600 });
      deps.logEvent(workspaceId, 'command-terminal', command);
      void watch(runId, Date.now());
      return { runId, line: line(runId) };
    },
    noteTerminal(runId, termId) {
      deps.db().prepare('UPDATE command_runs SET term_id = ? WHERE id = ?').run(termId, runId);
    },
    resume() {
      // Ran terminal runs still waiting for their output, typed in within the watch window.
      const since = new Date(Date.now() - WATCH_MS).toISOString();
      const rows = deps
        .db()
        .prepare("SELECT id, done_at, queued_at FROM command_runs WHERE status = 'ran' AND output IS NULL AND done_at >= ? AND via = 'terminal' ORDER BY id")
        .all(since) as Array<{ id: number; done_at: string | null; queued_at: string }>;
      for (const r of rows) void watch(r.id, Date.parse(r.done_at ?? r.queued_at));
    },
  };
}

/** script(1)'s log as plain text: no escape sequences, CRLF → LF, carriage-return overwrites and backspaces applied. */
export function cleanTerminalLog(raw: string): string {
  const s = raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, links)
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // CSI (colours, cursor moves)
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g, '')
    .replace(/^\^D\x08\x08/, '');
  const lines = s.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const seg = line.split('\r').pop() ?? ''; // a lone CR (progress bars) overwrites the line
    let out = '';
    for (const ch of seg) out = ch === '\b' ? out.slice(0, -1) : out + ch;
    return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  });
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join('\n');
}
