import { copyFile, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { config } from '../config.ts';
import type { Session } from '../sources/claude.ts';
import { hubEvents } from './events.ts';
import { run } from './exec.ts';
import { fragments } from './prompts.ts';

/**
 * Starting and stopping Claude sessions. Everything work-hub starts is a background job (`claude --bg`), the only kind
 * reachable from outside. Plugins can add `claude` arguments to every session the core starts (`addLaunchArgs`).
 */

/**
 * Why a session is started: `explorer` (a new workspace's setup), `new-session`, `handoff`, `pr-session`, `review` (the
 * session addressing a review), or `manual` (anything else, e.g. a plugin's).
 */
export type SessionPurpose = 'explorer' | 'new-session' | 'handoff' | 'pr-session' | 'review' | 'manual';

/** Extra `claude` arguments for a session the core starts (appended before the prompt). */
export type LaunchArgsFn = (info: { cwd: string; model?: string; purpose: string }) => string[] | Promise<string[]>;

const launchArgs: Array<{ fn: LaunchArgsFn; owner: string }> = [];

/** Each fn's args are appended (awaited, in registration order) before the prompt. `owner`: for `removeLaunchArgs`. */
export function addLaunchArgs(fn: LaunchArgsFn, owner = 'core'): void {
  launchArgs.push({ fn, owner });
}

/** Drop every launch-args fn `owner` added. */
export function removeLaunchArgs(owner: string): void {
  for (let i = launchArgs.length - 1; i >= 0; i--) if (launchArgs[i].owner === owner) launchArgs.splice(i, 1);
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isPlainObject = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

function mergeJson(a: Json, b: Json): Json {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, Json> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeJson(out[k], v) : v;
    return out;
  }
  return b;
}

/**
 * Claude keeps only the last `--settings` flag, so several plugins' inline settings (e.g. a hook and a permissions
 * allowlist) are folded into one, where the first one was: objects merged key by key, arrays concatenated without
 * duplicates, other values last-wins. A `--settings` that isn't inline JSON (a file path) is left as it is.
 */
export function mergeSettingsArgs(args: string[]): string[] {
  const out: string[] = [];
  let at = -1;
  let merged: Json = null;
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--settings' && value?.trimStart().startsWith('{')) {
      let parsed: Json;
      try {
        parsed = JSON.parse(value) as Json;
      } catch {
        out.push(args[i], value);
        i++;
        continue;
      }
      merged = at < 0 ? parsed : mergeJson(merged, parsed);
      if (at < 0) {
        at = out.length;
        out.push('--settings', '');
      }
      i++;
    } else out.push(args[i]);
  }
  if (at >= 0) out[at + 1] = JSON.stringify(merged);
  return out;
}

/** The extra arguments for one start. A fn that throws is logged and left out, so one broken plugin can't block sessions. */
export async function extraLaunchArgs(info: { cwd: string; model?: string; purpose: string }): Promise<string[]> {
  const out: string[] = [];
  for (const { fn, owner } of launchArgs) {
    try {
      out.push(...(await fn(info)));
    } catch (e) {
      console.error(`launch args (${owner}):`, e);
    }
  }
  return mergeSettingsArgs(out);
}

/** A job's full session id from its state.json (written a moment after `claude --bg` returns); null if it never shows. */
export async function jobSessionId(shortId: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    try {
      const st = JSON.parse(await readFile(join(homedir(), '.claude', 'jobs', shortId, 'state.json'), 'utf8')) as { sessionId?: string };
      if (st.sessionId) return st.sessionId;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export interface StartOptions {
  cwd: string;
  /** `--name`; omitted when empty (Claude names the session). */
  name?: string;
  /** `--model`; omitted when empty (Claude's default). */
  model?: string;
  prompt: string;
  purpose: string;
  /** Folders outside `cwd` the session may use without permission prompts: one `--add-dir=<dir>` each (blanks dropped). */
  addDirs?: string[];
}

/**
 * `claude` arguments for a start: `--bg [--name n] [--model m] [--add-dir=<dir>…] <launch args…> <prompt>`. The `=` form
 * of `--add-dir` matters: the option is variadic, so `--add-dir <dir> <prompt>` would read the prompt as another folder.
 */
export function launchArgv(opts: Pick<StartOptions, 'name' | 'model' | 'prompt' | 'addDirs'>, extra: string[] = []): string[] {
  const args = ['--bg'];
  if (opts.name?.trim()) args.push('--name', opts.name.trim());
  if (opts.model?.trim()) args.push('--model', opts.model.trim());
  for (const d of opts.addDirs ?? []) if (d.trim()) args.push(`--add-dir=${d.trim()}`);
  return [...args, ...extra, opts.prompt];
}

/** The prompt a session starts with: `app-rules` fragments appended for every purpose except `headless`; unchanged when none. */
export function withAppRules(prompt: string, purpose: string): string {
  if (purpose === 'headless') return prompt;
  const rules = fragments('app-rules', { purpose });
  return rules ? `${prompt}\n\n${rules}` : prompt;
}

/** Start a background Claude job in `cwd`; returns its short id, full session id and what `claude --bg` printed. */
export async function startBackgroundSession(opts: StartOptions): Promise<{ shortId: string; sessionId: string; output: string }> {
  const extra = await extraLaunchArgs({ cwd: opts.cwd, model: opts.model, purpose: opts.purpose });
  const output = await run('claude', launchArgv({ ...opts, prompt: withAppRules(opts.prompt, opts.purpose) }, extra), { cwd: opts.cwd, timeoutMs: 30_000 });
  const shortId = output.match(/\b[0-9a-f]{8}\b/)?.[0];
  if (!shortId) throw new Error(`started a background session but couldn't read its id from: ${output.trim().slice(0, 200)}`);
  const sessionId = (await jobSessionId(shortId)) ?? shortId;
  hubEvents.emit('session-started', { shortId, sessionId, cwd: opts.cwd, name: opts.name ?? '', purpose: opts.purpose });
  return { shortId, sessionId, output };
}

/** Stop a session: background jobs via `claude stop`, interactive ones with SIGTERM. */
export async function stopSession(s: Pick<Session, 'kind' | 'shortId' | 'pid'> & { sessionId?: string }): Promise<void> {
  if (s.kind === 'background') await run('claude', ['stop', s.shortId], { timeoutMs: 30_000 });
  else if (s.pid) process.kill(s.pid, 'SIGTERM');
  else throw new Error('no process id for this session');
  hubEvents.emit('session-stopped', { shortId: s.shortId, sessionId: s.sessionId });
}

/** Claude Code's global config (where folder trust lives): `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigFile(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
}

/**
 * Trust a worktree for Claude Code, so `claude --bg` starts there instead of refusing ("Workspace not trusted"). Same
 * effect as the ticket-workflow plugin's `trust-worktree.sh`: `projects[<real path>].hasTrustDialogAccepted = true` in
 * the config file, creating the entry and keeping everything else. Trust is per path (a trusted parent doesn't cover
 * subfolders). Only a directory under the worktrees root is accepted (after resolving symlinks). The file is backed up
 * (`.bak-trust-worktree`) and rewritten atomically (temp file + rename, same mode); nothing is written when the path is
 * already trusted. `configFile` and `worktreesRoot` are for tests: never point a test at the real config.
 */
export async function trustWorktree(
  path: string,
  opts: { configFile?: string; worktreesRoot?: string } = {},
): Promise<{ path: string; changed: boolean }> {
  const file = opts.configFile ?? claudeConfigFile();
  const dir = await realpath(path).catch(() => null);
  if (!dir || !(await stat(dir)).isDirectory()) throw new Error(`trust: not a directory: ${path}`);
  const rootIn = opts.worktreesRoot ?? config.paths.worktrees;
  const root = await realpath(rootIn).catch(() => null);
  if (!root || !dir.startsWith(root + sep)) throw new Error(`trust: refusing a path outside the worktrees root (${rootIn}): ${dir}`);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) throw new Error(`trust: ${file} not found (has Claude Code run on this machine?)`);
  const data = JSON.parse(text) as { projects?: Record<string, Record<string, unknown>> };
  if (data.projects?.[dir]?.hasTrustDialogAccepted === true) return { path: dir, changed: false };
  data.projects = { ...data.projects, [dir]: { ...data.projects?.[dir], hasTrustDialogAccepted: true } };
  const { mode } = await stat(file);
  await copyFile(file, `${file}.bak-trust-worktree`);
  const tmp = join(dirname(file), `.claude.json.trust-${process.pid}-${Date.now()}`);
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: mode & 0o777 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { path: dir, changed: true };
}
