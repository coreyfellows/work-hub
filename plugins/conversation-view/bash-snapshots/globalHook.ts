/**
 * Whether the user registered the snapshot hook in their own Claude settings (README option 2, `setup/install-bash-hook.sh`),
 * and where that copy writes. Sessions the app starts would otherwise run it twice per Bash call (once from the settings,
 * once from our `--settings`), racing on the same `<id>.json`, `.tmp` and `.busy`. Pure apart from `readGlobalHook`, which
 * only READS the settings file.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** A command that runs a file named exactly bash-snapshot.sh (quoted or not, any folder). */
const HOOK_RE = /(^|[\s/'"])bash-snapshot\.sh(?=['"\s]|$)/;

/** `VAR='value'` or `VAR=value` set as a command prefix (before the hook path). */
function prefixVar(command: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}=(?:'([^']*)'|"([^"]*)"|(\\S+))`).exec(command);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Every hook command in a Claude settings object that runs bash-snapshot.sh. */
export function snapshotHookCommands(settings: unknown): string[] {
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const inner = (g as { hooks?: unknown } | null)?.hooks;
      for (const h of Array.isArray(inner) ? inner : []) {
        const cmd = (h as { command?: unknown })?.command;
        if (typeof cmd === 'string' && HOOK_RE.test(cmd)) out.push(cmd);
      }
    }
  }
  return out;
}

/**
 * The folder a hook command writes to when it runs in a session the app starts (so with the server's `env`): the
 * hook's own rule, `WORK_HUB_BASH_SNAP_DIR`, else `<WORK_HUB_STATE_DIR or XDG state>/work-hub…/bash-snaps`, where a
 * prefix on the command beats the inherited environment.
 */
export function hookDir(command: string, env: Record<string, string | undefined>, home = homedir()): string {
  const snap = prefixVar(command, 'WORK_HUB_BASH_SNAP_DIR') ?? env.WORK_HUB_BASH_SNAP_DIR;
  if (snap) return resolve(snap);
  const state = prefixVar(command, 'WORK_HUB_STATE_DIR') ?? env.WORK_HUB_STATE_DIR;
  return resolve(state || join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'work-hub'), 'bash-snaps');
}

export type GlobalHook = { kind: 'none' } | { kind: 'same' | 'elsewhere'; dir: string; command: string };

/** Classify the user's settings text: no snapshot hook, one writing to `snapDir` (ours), or one writing elsewhere. */
export function classifyGlobalHook(settingsText: string | null, snapDir: string, env: Record<string, string | undefined>, home = homedir()): GlobalHook {
  if (!settingsText) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText);
  } catch {
    return { kind: 'none' };
  }
  const cmds = snapshotHookCommands(parsed);
  if (!cmds.length) return { kind: 'none' };
  const want = resolve(snapDir);
  const same = cmds.find((c) => hookDir(c, env, home) === want);
  if (same) return { kind: 'same', dir: want, command: same };
  return { kind: 'elsewhere', dir: hookDir(cmds[0]!, env, home), command: cmds[0]! };
}

/** The user's Claude settings file: `CLAUDE_SETTINGS_FILE`, else `$CLAUDE_CONFIG_DIR/settings.json`, else ~/.claude/settings.json. */
export function userSettingsPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.CLAUDE_SETTINGS_FILE || join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
}

/** Read (never write) the settings file; null when it's missing or unreadable. */
export async function readGlobalHook(settingsPath: string, snapDir: string, env: Record<string, string | undefined> = process.env): Promise<GlobalHook> {
  const text = await readFile(settingsPath, 'utf8').catch(() => null);
  return classifyGlobalHook(text, snapDir, env);
}
