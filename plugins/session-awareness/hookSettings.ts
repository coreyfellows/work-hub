/**
 * The Claude Code `--settings` JSON that registers the awareness hook for one session the app starts (like the
 * bash-snapshots hook: the command line pins the state folder, because `claude --bg` jobs don't inherit the server's
 * environment). Pure, so it is unit tested.
 */
export interface HookOptions {
  hookPath: string;
  stateDir: string;
  /** PreToolUse checks at most this often; 0 = UserPromptSubmit only. */
  nudgeIntervalMs: number;
  staleAfterMs: number;
  /** The node binary (default: the server's own, so sessions need no `node` on PATH). */
  node?: string;
}

/** Tools where a sibling nudge is useful (a regex on the tool name): a node process starts only for these. */
export const NUDGE_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task';

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function hookSettings(o: HookOptions): { hooks: Record<string, unknown[]> } {
  const command = [
    `WORK_HUB_SESSION_AWARENESS_DIR=${sq(o.stateDir)}`,
    `WORK_HUB_SESSION_AWARENESS_NUDGE_MS=${Math.max(0, Math.round(o.nudgeIntervalMs))}`,
    `WORK_HUB_SESSION_AWARENESS_STALE_MS=${Math.max(0, Math.round(o.staleAfterMs))}`,
    sq(o.node ?? process.execPath),
    sq(o.hookPath),
  ].join(' ');
  const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
  const hooks: Record<string, unknown[]> = { UserPromptSubmit: [entry] };
  if (o.nudgeIntervalMs > 0) hooks.PreToolUse = [{ matcher: NUDGE_TOOLS, ...entry }];
  return { hooks };
}

/** The extra `claude` arguments for a session the app starts. */
export function launchArgs(o: HookOptions): string[] {
  return ['--settings', JSON.stringify(hookSettings(o))];
}
