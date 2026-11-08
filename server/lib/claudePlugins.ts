/**
 * Which Claude Code plugins the user has installed, from `claude plugin list --json` (one entry per install:
 * `{ id: "<name>@<marketplace>", scope: "user" | "project" | …, enabled }`). Plugins use it (`ctx.claude.pluginInstalled`)
 * to skip loading a bundled copy of a Claude plugin the user already has, which would otherwise load twice.
 *
 * A successful listing is cached for 10 minutes (so installing or removing a Claude plugin is noticed without a restart);
 * a failed refresh keeps the last good listing for up to 3 failures in a row (or 1 hour past the TTL, whichever comes
 * first), then answers "not installed" (the safe side: the app falls back to its bundled copy). A failed run (CLI
 * missing, timeout, unparsable output) is retried on the next call. Concurrent calls share one run.
 */
import { run } from './exec.ts';

export interface InstalledPlugin {
  /** The plugin's name (the part of `id` before `@`). */
  name: string;
  id: string;
  scope: string;
  enabled: boolean;
}

export interface PluginInstalledOptions {
  /** Which installs count: 'user' (default), 'project' (any project's) or 'any'. */
  scope?: 'user' | 'project' | 'any';
  /** Only count installs that are enabled (default true). */
  enabledOnly?: boolean;
}

export type PluginInstalledFn = (name: string, opts?: PluginInstalledOptions) => Promise<boolean>;
/** The installed id (`<name>@<marketplace>`) of plugin `name` in a matching scope, or null. */
export type PluginIdFn = (name: string, opts?: PluginInstalledOptions) => Promise<string | null>;

/** `claude plugin list --json` output → installs. Throws on anything that isn't the expected array (so it isn't cached). */
export function parsePluginList(text: string): InstalledPlugin[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('claude plugin list --json: expected an array');
  const out: InstalledPlugin[] = [];
  for (const p of data) {
    if (!p || typeof p !== 'object') continue;
    const { id, scope, enabled } = p as { id?: unknown; scope?: unknown; enabled?: unknown };
    if (typeof id !== 'string' || !id) continue;
    out.push({ id, name: id.split('@')[0], scope: typeof scope === 'string' ? scope : '', enabled: enabled === true });
  }
  return out;
}

/** The install of `name` in a matching scope (and enabled, unless `enabledOnly: false`), if any. */
export function findInstalled(list: InstalledPlugin[], name: string, opts: PluginInstalledOptions = {}): InstalledPlugin | undefined {
  const scope = opts.scope ?? 'user';
  const enabledOnly = opts.enabledOnly ?? true;
  return list.find((p) => p.name === name && (scope === 'any' || p.scope === scope) && (!enabledOnly || p.enabled));
}

/** True when `list` has `name` installed in a matching scope (and enabled, unless `enabledOnly: false`). */
export const matchesInstalled = (list: InstalledPlugin[], name: string, opts: PluginInstalledOptions = {}): boolean =>
  findInstalled(list, name, opts) !== undefined;

const defaultRunner = (): Promise<string> => run('claude', ['plugin', 'list', '--json'], { timeoutMs: 15_000 });

export const PLUGIN_LIST_TTL_MS = 10 * 60_000;
/** A stale listing answers through at most this many failed refreshes in a row... */
export const PLUGIN_LIST_MAX_STALE_FAILURES = 3;
/** ...and for at most this long past its TTL. */
export const PLUGIN_LIST_MAX_STALE_MS = 60 * 60_000;

/**
 * `installed` and `id` over `runner` (the raw `claude plugin list --json` stdout), sharing one success-only cache kept
 * for `ttlMs`. A failed refresh after that keeps answering from the last good listing (and tries again on the next
 * call), for at most `maxStaleFailures` failures in a row and only until `maxStaleMs` past the TTL; after either, the
 * listing is dropped and a failed run answers false (as it does with none yet) until a run succeeds. `now` is for tests.
 */
export function pluginChecks(
  runner: () => Promise<string> = defaultRunner,
  opts: { ttlMs?: number; now?: () => number; maxStaleFailures?: number; maxStaleMs?: number } = {},
): { installed: PluginInstalledFn; id: PluginIdFn } {
  const ttlMs = opts.ttlMs ?? PLUGIN_LIST_TTL_MS;
  const maxStaleFailures = opts.maxStaleFailures ?? PLUGIN_LIST_MAX_STALE_FAILURES;
  const maxStaleMs = opts.maxStaleMs ?? PLUGIN_LIST_MAX_STALE_MS;
  const now = opts.now ?? Date.now;
  let cached: { list: InstalledPlugin[]; at: number } | null = null;
  let failures = 0;
  let inFlight: Promise<InstalledPlugin[]> | null = null;
  const load = (): Promise<InstalledPlugin[]> => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.list);
    inFlight ??= runner()
      .then(parsePluginList)
      .then(
        (list) => {
          cached = { list, at: now() };
          failures = 0;
          return list;
        },
        (e: unknown) => {
          // Still stale, so the next call retries; meanwhile the last good answer beats "not installed", but not forever:
          // a plugin uninstalled while the CLI keeps failing would otherwise stay "installed" (and its bundled copy off).
          failures++;
          if (cached && failures <= maxStaleFailures && now() - cached.at < ttlMs + maxStaleMs) return cached.list;
          cached = null;
          throw e;
        },
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    installed: (name, o) => load().then((list) => matchesInstalled(list, name, o), () => false),
    id: (name, o) => load().then((list) => findInstalled(list, name, o)?.id ?? null, () => null),
  };
}

/** `pluginChecks(…).installed` on its own (its own cache). */
export const pluginInstalledChecker = (...args: Parameters<typeof pluginChecks>): PluginInstalledFn => pluginChecks(...args).installed;

/**
 * The process-wide checks over one cached listing (`ctx.claude.pluginInstalled` and `ctx.claude.pluginId`). False / null
 * while the CLI fails with no usable listing (the next call tries again).
 */
export const { installed: pluginInstalled, id: pluginId } = pluginChecks();
