/** The Claude Code `--settings` JSON that registers the snapshot hook on Bash calls. Pure, so it is unit tested. */

const EVENTS = [
  ['PreToolUse', 'pre'],
  ['PostToolUse', 'post'],
  ['PostToolUseFailure', 'post'],
] as const;

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function hookSettings(hookPath: string, snapDir: string): { hooks: Record<string, unknown[]> } {
  // The hook writes where the server reads: pin the exact snapshot folder.
  const prefix = `WORK_HUB_BASH_SNAP_DIR=${sq(snapDir)}`;
  const hooks: Record<string, unknown[]> = {};
  for (const [event, phase] of EVENTS) {
    hooks[event] = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${prefix} ${sq(hookPath)} ${phase}`, timeout: 15 }] }];
  }
  return { hooks };
}

/** The extra `claude` arguments for a session the app starts. */
export function launchArgs(hookPath: string, snapDir: string): string[] {
  return ['--settings', JSON.stringify(hookSettings(hookPath, snapDir))];
}
