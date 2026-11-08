/**
 * Builds the `ServerPluginContext` a plugin's `register(ctx)` gets. Every core collaborator comes in through `deps`
 * (the `loadPlugins` deps assembled in `server/index.ts` for the real server, light stand-ins in tests), so this module
 * imports no runtime core code.
 *
 * Registrations go to the core's own registries through `deps.hooks` (`coreHooks.ts`: transcript enrichers, launch
 * args, reconcile passes, hide predicates, urgent fields, prompt fragments), tagged with the plugin id so
 * `removePluginRegistrations` can take them back. `pluginRegistries` keeps the auth provider and extra public paths,
 * which the core's guard (server/guard.ts, installed in index.ts) reads on every request.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginManifest } from '../../plugin-api/manifest.ts';
import type {
  AuthProvider,
  HidePredicate,
  LaunchArgsFn,
  PromptFragmentFn,
  PromptFragmentKind,
  ReconcilePass,
  ServerPluginContext,
  TranscriptEnricher,
  Workspace,
} from '../../plugin-api/server.ts';
import type { Source, SourceState } from '../registry.ts';
import type { ClaudeData } from '../sources/claude.ts';
import { hubEvents } from '../lib/events.ts';
import { fragments } from '../lib/prompts.ts';
import { detectProvider, getProvider, listProviders, registerProvider, removeProviders } from '../lib/vcs/registry.ts';
import { effectiveVcsDefault } from '../lib/vcs/default.ts';
import { migratePlugin } from '../store/pluginMigrations.ts';
import { routeConflicts } from '../coreRoutes.ts';
import { shellWord } from '../lib/shellWord.ts';

export interface ContextDeps {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  /** config.ts `publicOrigin` (`https://<hostname>`, or `http://127.0.0.1:<port>` in localhost mode); unset in tests. */
  publicOrigin?: string;
  /** config.ts `isAcceptedOrigin` (the public origin, or localhost); without it only `publicOrigin` is accepted. */
  isAcceptedOrigin?: (origin: string | undefined | null) => boolean;
  registry: {
    add(source: Source): unknown;
    refresh(id: string): Promise<void>;
    on(event: 'change', fn: (s: SourceState) => void): unknown;
    get(id: string): SourceState | undefined;
  };
  store: ServerPluginContext['store'];
  /** The loader's plugin list and plugins.json (`loader.ts`); without it, an empty list and an empty config. */
  plugins?: ServerPluginContext['plugins'];
  /** Session plumbing that exists today; `list`, `hide` and `addLaunchArgs` are built here. */
  sessions: Omit<ServerPluginContext['sessions'], 'list' | 'find' | 'hide' | 'addLaunchArgs'>;
  jobs: ServerPluginContext['jobs'];
  db: { raw(): DatabaseSync };
  exec: ServerPluginContext['exec'];
  headless: ServerPluginContext['headless'];
  git: ServerPluginContext['git'];
  /** `claudePlugins.ts` `pluginInstalled` in the real server; without it, every plugin counts as not installed. */
  claude?: ServerPluginContext['claude'];
  paths: { stateDir: string; configDir: string; cacheDir: string; repoRoot: string; reposDir?: string; worktreesDir?: string; plainDir?: string; ticketWorkflowScripts?: string; whBin?: string; whCommand?: string };
  /** The core's workspace-session rules (`workspaceRules` in workspaceSessions.ts); without it, only the fragments. */
  workspaceRules?(workspaceId: string): string[];
  /** The core's workspace context prefix for a session's task (`contextPrompt` in workspaceSessions.ts); without it, `ctx.prompts.workspaceContext` rejects. */
  workspaceContext?(ws: Workspace, task: string): Promise<string>;
  /** Start a reconcile pass (index.ts `runReconcile`); without it, `ctx.reconcile.run` does nothing. */
  runReconcile?(): void;
  /** The value in force for a declared setting (`<plugin id>.<key>`: env, plugins.json, what Settings stored); undefined if undeclared. */
  resolveSetting?: (key: string) => { value: unknown; source: string } | undefined;
  /** plugins.json `settings`, keyed by plugin id. */
  settings: Record<string, Record<string, unknown>> | undefined;
  /** Revalidate these GET paths with an ETag (lib/revalidate.ts `addRevalidate`, the same registry as the core's list). */
  applyRevalidate(paths: string[]): void;
  /** The core registries (`coreHooks.ts`); every registration names the plugin. */
  hooks: CoreHooks;
  /** The core's API routes (`coreRoutes.ts` `CORE_ROUTES`, `METHOD /path`; a bare path = any method): a plugin route that would also match one throws. Unset = no check. */
  coreRoutes?: readonly string[];
}

export interface CoreHooks {
  addEnricher(e: TranscriptEnricher<unknown>, plugin: string): void;
  addLaunchArgs(fn: LaunchArgsFn, plugin: string): void;
  addReconcilePass(fn: ReconcilePass, plugin: string): void;
  hideSession(pred: HidePredicate, plugin: string): void;
  registerUrgent(sourceId: string, listKey: string, fields: string[], plugin: string): void;
  addFragment(kind: PromptFragmentKind, fn: PromptFragmentFn, plugin: string): void;
  addFileRoot(dir: string, plugin: string): void;
  fileRoots(): string[];
  /** Take back everything `plugin` registered in the registries above. */
  removeByPlugin(plugin: string): void;
}

export const pluginRegistries = {
  publicPaths: [] as Array<{ plugin: string; path: string }>,
  authProvider: null as { plugin: string; provider: AuthProvider } | null,
};

const services = new Map<string, { plugin: string; api: unknown }>();

/**
 * Undo a plugin's registrations (its `register()` threw): its services, everything in the core registries, its
 * source-control providers, its public paths and auth provider. Routes and middleware it already put on the app stay (Hono can't remove them), as do
 * sources it added to the registry and events it subscribed to.
 */
export function removePluginRegistrations(id: string, hooks: CoreHooks): void {
  for (const [name, s] of services) if (s.plugin === id) services.delete(name);
  hooks.removeByPlugin(id);
  removeProviders(id);
  pluginRegistries.publicPaths = pluginRegistries.publicPaths.filter((p) => p.plugin !== id);
  if (pluginRegistries.authProvider?.plugin === id) pluginRegistries.authProvider = null;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'on']);

/**
 * The Hono app as a plugin sees it: adding a route that would also match a core route throws (`routeConflicts`: same
 * method or `all`, with the plugin's `:param` and `*` matching any core segments; plugins load before the core's routes,
 * so it would shadow them). Route methods return the guarded app, so chained calls (`ctx.app.get(...).post(...)`) are
 * checked too. Everything else passes straight through to the app.
 */
function guardedApp(app: Hono, id: string, core: readonly string[] | undefined, base = ''): Hono {
  if (!core?.length) return app;
  const full = (path: string) => (base ? `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}` : path);
  // Hono's `app.get(handler)` (no path) reuses the last path given, as does a chained `.post(handler)`.
  let lastPath = '/';
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
  const check = (methods: unknown, paths: unknown) => {
    for (const method of list(methods)) {
      if (typeof method !== 'string') continue;
      for (const path of list(paths)) {
        if (typeof path !== 'string') continue;
        const hit = routeConflicts(method, full(path), core);
        if (hit) throw new Error(`route ${method.toUpperCase()} ${full(path)} would shadow the core route ${hit}; plugin routes go under /api/plugins/${id}/`);
      }
    }
  };
  const proxy: Hono = new Proxy(app, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (typeof prop === 'string' && ROUTE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          if (prop === 'on') {
            check(args[0], args[1]);
            const paths = list(args[1]);
            if (typeof paths[paths.length - 1] === 'string') lastPath = paths[paths.length - 1] as string;
          } else {
            if (typeof args[0] === 'string') lastPath = args[0];
            check(prop, lastPath);
          }
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? proxy : out;
        };
      }
      // `basePath` returns a new app sharing the router: guard it too, with the prefix.
      if (prop === 'basePath') return (path: string) => guardedApp((v as (p: string) => Hono).call(target, path), id, core, full(path));
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return proxy;
}

/** `my-plugin` → `MY_PLUGIN`, `intervalMs` → `INTERVAL_MS`. */
export function envName(id: string, key: string): string {
  const snake = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
  return `WORK_HUB_${snake(id)}_${snake(key)}`;
}

function coerce(raw: string, dflt: unknown): unknown {
  if (typeof dflt === 'number') {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : dflt;
  }
  if (typeof dflt === 'boolean') {
    const v = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
    return dflt;
  }
  return raw;
}

export function createServerContext(id: string, manifest: PluginManifest, dir: string, deps: ContextDeps): ServerPluginContext {
  const tag = `[plugin ${id}]`;
  const startHooks: Array<() => void | Promise<void>> = [];
  const settings = deps.settings?.[id] ?? {};
  const listSessions = () => (deps.registry.get('claude')?.data as ClaudeData | null)?.sessions ?? [];

  function get<T>(key: string, dflt?: T): T | undefined {
    // A setting the manifest declares resolves the way Settings shows it (env var, plugins.json, what Settings stored).
    const declared = deps.resolveSetting?.(`${id}.${key}`);
    if (declared && declared.source !== 'default') return declared.value as T;
    const env = process.env[envName(id, key)];
    if (env !== undefined) return coerce(env, dflt) as T;
    if (Object.hasOwn(settings, key)) return settings[key] as T;
    return dflt;
  }

  const ctx: ServerPluginContext = {
    id,
    manifest,
    pluginDir: dir,
    app: guardedApp(deps.app, id, deps.coreRoutes),
    upgradeWebSocket: deps.upgradeWebSocket,
    publicOrigin: deps.publicOrigin ?? '',
    isAcceptedOrigin: deps.isAcceptedOrigin ?? ((origin) => !!origin && origin === deps.publicOrigin),
    registry: {
      add: (source) => {
        // A second source with an id already in the registry would replace the core's (or another plugin's) silently.
        if (deps.registry.get(source.id)) throw new Error(`source "${source.id}" already exists (the core or another plugin added it)`);
        void deps.registry.add(source);
      },
      refresh: (sid) => deps.registry.refresh(sid),
      on: (event, fn) => void deps.registry.on(event, fn),
    },
    urgent: (sourceId, listKey, fields) => deps.hooks.registerUrgent(sourceId, listKey, [...fields], id),
    revalidate: (paths) => deps.applyRevalidate([...paths]),
    db: {
      raw: () => deps.db.raw(),
      migrate: (migrations) => migratePlugin(deps.db.raw(), id, migrations),
    },
    store: deps.store,
    plugins: deps.plugins ?? { list: () => [], config: () => ({ local: [], enabled: {} }), configFile: '' },
    sessions: {
      ...deps.sessions,
      list: listSessions,
      find: async (sid) => {
        const lookup = () => listSessions().find((s) => s.sessionId === sid || s.shortId === sid);
        const hit = lookup();
        if (hit) return hit;
        await deps.registry.refresh('claude').catch(() => {});
        return lookup();
      },
      hide: (pred) => deps.hooks.hideSession(pred, id),
      addLaunchArgs: (fn) => deps.hooks.addLaunchArgs(fn, id),
    },
    transcript: { addEnricher: (e) => deps.hooks.addEnricher(e as TranscriptEnricher<unknown>, id) },
    prompts: {
      addFragment: (kind, fn) => deps.hooks.addFragment(kind, fn, id),
      fragments,
      workspaceRules: (workspaceId) => deps.workspaceRules?.(workspaceId) ?? [fragments('workspace-rules', { workspaceId })].filter(Boolean),
      workspaceContext: (ws, task) => {
        // A host without it must not start a session that doesn't know its workspace.
        if (!deps.workspaceContext) return Promise.reject(new Error(`prompts.workspaceContext is not available in this host (plugin ${id})`));
        return deps.workspaceContext(ws, task);
      },
    },
    files: { addRoot: (dir) => deps.hooks.addFileRoot(dir, id), roots: () => deps.hooks.fileRoots() },
    jobs: deps.jobs,
    events: hubEvents,
    vcs: {
      register: (p) => registerProvider(p, id),
      get: (pid) => getProvider(pid),
      list: () => listProviders(),
      detect: (path, opts) => detectProvider(path, opts),
      effectiveDefault: () => effectiveVcsDefault(),
    },
    reconcile: { addPass: (fn) => deps.hooks.addReconcilePass(fn, id), run: () => deps.runReconcile?.() },
    auth: {
      setProvider: (provider) => {
        const prev = pluginRegistries.authProvider;
        if (prev && prev.plugin !== id) throw new Error(`auth provider already set by plugin ${prev.plugin}`);
        pluginRegistries.authProvider = { plugin: id, provider };
      },
    },
    guard: { addPublicPaths: (paths) => void pluginRegistries.publicPaths.push(...paths.map((path) => ({ plugin: id, path }))) },
    onStart: (fn) => void startHooks.push(fn),
    paths: {
      stateDir: deps.paths.stateDir,
      configDir: deps.paths.configDir,
      cacheDir: deps.paths.cacheDir,
      repoRoot: deps.paths.repoRoot,
      // Read when used: Settings → Folders can change them while the server runs.
      get reposDir() {
        return deps.paths.reposDir ?? join(homedir(), 'repos');
      },
      get worktreesDir() {
        return deps.paths.worktreesDir ?? join(homedir(), 'worktrees');
      },
      get plainDir() {
        return deps.paths.plainDir ?? join(homedir(), 'workspaces');
      },
      // Read when used: the ticket-workflow plugin's bundled scripts while it's loaded, else the core's setting.
      get ticketWorkflowScripts() {
        const tw = services.get('ticket-workflow')?.api as { scriptsDir?: string } | undefined;
        return tw?.scriptsDir ?? deps.paths.ticketWorkflowScripts ?? '';
      },
      whBin: deps.paths.whBin ?? join(deps.paths.repoRoot, 'bin', 'wh'),
      whCommand: deps.paths.whCommand ?? shellWord(deps.paths.whBin ?? join(deps.paths.repoRoot, 'bin', 'wh')),
      pluginState: join(deps.paths.stateDir, 'plugins', id),
      pluginCache: join(deps.paths.cacheDir, 'plugins', id),
    },
    config: { get } as ServerPluginContext['config'],
    exec: deps.exec,
    headless: deps.headless,
    git: deps.git,
    claude: deps.claude ?? { pluginInstalled: async () => false, pluginId: async () => null },
    services: {
      expose: (name, api) => {
        const prev = services.get(name);
        if (prev && prev.plugin !== id) throw new Error(`service "${name}" is already exposed by plugin ${prev.plugin}`);
        services.set(name, { plugin: id, api });
      },
      get: <T>(name: string): T => {
        const s = services.get(name);
        if (!s) throw new Error(`service "${name}" is not available: the plugin that exposes it is not loaded (plugin ${id} asked for it)`);
        return s.api as T;
      },
    },
    log: {
      info: (...a) => console.log(tag, ...a),
      warn: (...a) => console.warn(tag, ...a),
      error: (...a) => console.error(tag, ...a),
    },
  };
  startHooksOf.set(ctx, startHooks);
  return ctx;
}

const startHooksOf = new WeakMap<ServerPluginContext, Array<() => void | Promise<void>>>();

/** The `onStart` functions a context collected (the loader returns them; index.ts runs them after `serve()`). */
export function startHooksFor(ctx: ServerPluginContext): Array<() => void | Promise<void>> {
  return startHooksOf.get(ctx) ?? [];
}
