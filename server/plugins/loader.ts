/**
 * Loads the server half of every active plugin: discover → resolve → for each active plugin with a `server` entry,
 * import it and call its default export with a `ServerPluginContext`. A plugin that fails to load is marked skipped
 * ("failed to load: …"), whatever it registered before failing is taken back (`removePluginRegistrations`), and the rest
 * carry on. Also serves `GET /api/plugins`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hono } from 'hono';
import { API_VERSION } from '../../plugin-api/manifest.ts';
import { markPluginGroup, registerSettingsGroup, removeSettingsGroup, setEnvNamer, setPluginsJsonSettings, unmarkPluginGroup } from '../settings.ts';
import type { PluginListEntry, RegisterServerPlugin, ServerPluginContext } from '../../plugin-api/server.ts';
import { readPluginsConfig, type PluginsConfig } from './config.ts';
import { createServerContext, envName, removePluginRegistrations, startHooksFor, type ContextDeps } from './context.ts';
import { checkPluginImports } from './boundary.ts';
import { discoverPlugins } from './discover.ts';
import { resolvePlugins, type ResolvedPlugin, type Resolution } from './resolve.ts';
import { builtinPlugins } from '../builtin.ts';

export interface LoaderDeps extends Omit<ContextDeps, 'app' | 'settings'> {
  /** The repo's own plugins/ folder. */
  officialDir: string;
  /** plugins.json (missing = defaults). */
  pluginsFile: string;
  /** How long one plugin's `register()`, or one `onStart` hook, may take (config `WORK_HUB_PLUGIN_TIMEOUT_MS`; default 30s). */
  timeoutMs?: number;
}

export const DEFAULT_PLUGIN_TIMEOUT_MS = 30_000;

/** `30000` → `30s`, `50` → `50ms`. */
function duration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export class PluginTimeout extends Error {}

/** `p`, or a `PluginTimeout` ("<what> did not finish in 30s") once `ms` have passed; the timer never holds the process. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginTimeout(`${what} did not finish in ${duration(ms)}`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Run every plugin's `onStart` at once (index.ts, after `serve()`); each is already timed and its failure logged. */
export async function runStartHooks(hooks: Array<() => Promise<void>>): Promise<void> {
  await Promise.allSettled(hooks.map((h) => h()));
}

export interface LoadedPlugins {
  resolution: Resolution;
  /** Each active plugin's `onStart` functions, in load order; failures are logged, never thrown. */
  startHooks: Array<() => Promise<void>>;
}

/**
 * Active plugins ordered so each comes after the plugins it requires (otherwise discovery order). Shared with the web
 * generator (`generateWebModule.ts`) so both halves load plugins in the same order.
 */
export function loadOrder(plugins: ResolvedPlugin[]): ResolvedPlugin[] {
  const active = new Map(plugins.filter((p) => p.status === 'active').map((p) => [p.manifest.id, p]));
  const out: ResolvedPlugin[] = [];
  const seen = new Set<string>();
  const visit = (p: ResolvedPlugin) => {
    if (seen.has(p.manifest.id)) return;
    seen.add(p.manifest.id);
    for (const r of p.manifest.requires ?? []) {
      const dep = active.get(r);
      if (dep) visit(dep);
    }
    out.push(p);
  };
  for (const p of active.values()) visit(p);
  return out;
}

function safeCheck(dir: string, root: string) {
  try {
    return checkPluginImports(dir, root, dir);
  } catch {
    return [];
  }
}

/** `ctx.plugins`: the resolution as it stands when asked (fresh objects), and plugins.json read on each call. */
export function pluginsView(resolution: Resolution, pluginsFile: string): ServerPluginContext['plugins'] {
  return {
    list: () =>
      resolution.plugins.map((p): PluginListEntry => ({
        id: p.manifest.id,
        aliases: [...(p.manifest.aliases ?? [])],
        title: p.manifest.title,
        dir: p.dir,
        kind: p.builtin ? 'builtin' : p.official ? 'official' : 'local',
        status: p.status,
        ...(p.reason ? { reason: p.reason } : {}),
      })),
    config: () => {
      const { local, enabled } = readPluginsConfig(pluginsFile, () => {});
      return { local, enabled };
    },
    configFile: pluginsFile,
  };
}

export async function loadPlugins(app: Hono, deps: LoaderDeps): Promise<LoadedPlugins> {
  const errors: string[] = [];
  let cfg: PluginsConfig;
  try {
    // Wrong-typed values are dropped; say so on the Status page too.
    cfg = readPluginsConfig(deps.pluginsFile, (m) => {
      errors.push(m);
      console.warn('plugins:', m);
    });
  } catch (e) {
    errors.push((e as Error).message);
    console.error('plugins:', (e as Error).message);
    cfg = { local: [], enabled: {} };
  }
  const resolution = resolvePlugins(discoverPlugins(deps.officialDir, cfg.local), cfg);
  // The app's own features load first, like plugins (same context) but always on and hidden from the Plugins list.
  resolution.plugins.unshift(...builtinPlugins(deps.paths.repoRoot));
  resolution.errors.unshift(...errors);

  deps.applyRevalidate(['/api/plugins']);
  app.get('/api/plugins', (c) => c.json({ apiVersion: API_VERSION, plugins: resolution.plugins.filter((p) => !p.builtin), errors: resolution.errors }));

  setPluginsJsonSettings(cfg.settings);
  setEnvNamer(envName);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS;
  const plugins = pluginsView(resolution, deps.pluginsFile);
  const startHooks: LoadedPlugins['startHooks'] = [];
  const failed = new Set<string>();
  for (const p of loadOrder(resolution.plugins)) {
    const id = p.manifest.id;
    // 'core' tags the core's own entries in the shared registries; a plugin by that name could take them back.
    if (id === 'core') {
      p.status = 'skipped';
      p.reason = 'the id "core" is reserved for the core';
      failed.add(id);
      continue;
    }
    const brokenDep = (p.manifest.requires ?? []).find((r) => failed.has(r));
    if (brokenDep) {
      p.status = 'skipped';
      p.reason = `requires ${brokenDep}, which failed to load`;
      failed.add(id);
      continue;
    }
    // Local plugins aren't covered by boundary.test.ts: say so (once, at load) if one imports core files, which can change
    // under it at any time. A warning, not a skip (scripts/check-plugin.ts runs the same check on demand).
    if (!p.official) {
      for (const v of safeCheck(p.dir, deps.paths.repoRoot)) {
        console.warn(`[plugin ${id}] imports outside plugin-api: ${v.file}:${v.line} '${v.specifier}' (${v.why})`);
      }
    }
    if (p.manifest.settings?.length) {
      registerSettingsGroup({ id, title: p.manifest.title, description: p.manifest.description, order: p.manifest.settingsOrder ?? 70, builtin: p.builtin, defs: p.manifest.settings });
      markPluginGroup(id);
    }
    if (!p.manifest.server) continue;
    try {
      const mod = (await import(pathToFileURL(join(p.dir, p.manifest.server)).href)) as { default?: RegisterServerPlugin };
      const register = mod.default;
      if (typeof register !== 'function') throw new Error(`${p.manifest.server} has no default export function`);
      const ctx = createServerContext(id, p.manifest, p.dir, { ...deps, app, settings: cfg.settings, plugins });
      const registering = Promise.resolve().then(() => register(ctx));
      try {
        await withTimeout(registering, timeoutMs, 'register()');
      } catch (e) {
        // A register() that finishes after its timeout: take back what it added late, too.
        if (e instanceof PluginTimeout) void registering.catch(() => {}).finally(() => removePluginRegistrations(id, deps.hooks));
        throw e;
      }
      for (const fn of startHooksFor(ctx)) {
        startHooks.push(async () => {
          try {
            await withTimeout(Promise.resolve().then(fn), timeoutMs, 'onStart');
          } catch (e) {
            console.error(`[plugin ${id}] onStart failed:`, e);
          }
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      removePluginRegistrations(id, deps.hooks);
      removeSettingsGroup(id);
      unmarkPluginGroup(id);
      p.status = 'skipped';
      p.reason = e instanceof PluginTimeout ? message : `failed to load: ${message}`;
      failed.add(id);
      console.error(`[plugin ${id}] failed to load:`, e);
    }
  }
  return { resolution, startHooks };
}
