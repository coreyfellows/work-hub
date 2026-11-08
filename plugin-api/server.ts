/**
 * The only core module a plugin's server.ts may import (plus npm packages and its own files). Everything a plugin
 * needs from the core is a type here or a member of the `ServerPluginContext` it is handed; the few runtime helpers
 * below are the same ones `ctx.exec`, `ctx.headless` and `ctx.git` hand out. Local plugins import this as types only.
 */
import type { Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginManifest } from './manifest.ts';
import type { Source, SourceState } from '../server/registry.ts';
import type { HidePredicate, Session } from '../server/sources/claude.ts';
import type { Workspace, Worktree } from '../server/store/workspaces.ts';
import type { FileEdit, HistoryEntry, HistoryHost, TranscriptEnricher, TranscriptNotice } from '../server/lib/transcript.ts';
import type { LaunchArgsFn, SessionPurpose } from '../server/lib/sessions.ts';
import type { ReconcilePass } from '../server/reconcile.ts';
import type { Job, JobCtx } from '../server/jobs.ts';
import type { ResolvedPlugin } from '../server/plugins/resolve.ts';
import type { HubEvents } from '../server/lib/events.ts';
import type { PromptContext, PromptFragmentFn, PromptFragmentKind } from '../server/lib/prompts.ts';
import type { AgentInstructionOpts, SourceControlProvider, WorkingCopyState } from '../server/lib/vcs/types.ts';
import type * as transcriptLib from '../server/lib/transcript.ts';
import type * as attachLib from '../server/lib/attach.ts';
import type * as execLib from '../server/lib/exec.ts';
import type * as headlessLib from '../server/lib/headless.ts';
import type * as gitLib from '../server/lib/git.ts';
import type { PluginIdFn, PluginInstalledFn } from '../server/lib/claudePlugins.ts';
import type * as workspacesStore from '../server/store/workspaces.ts';
import type * as jobsLib from '../server/jobs.ts';

export { API_VERSION } from './manifest.ts';
export { copyLabel, copyLabelText, type CopyLike } from './copyLabel.ts';
/** The models a session can be started on, strongest first (`SessionModel` is one of them). */
export { SESSION_MODELS, type SessionModel } from './models.ts';
export { run, runJson } from '../server/lib/exec.ts';
/** A unified `git diff` → one FileEdit per file (each hunk as old/new text); shared by the bash-snapshots and git-cards plugins. */
export { parseDiff } from '../server/lib/diffParse.ts';
export { askClaudeJson, type HeadlessMcp, type HeadlessOptions } from '../server/lib/headless.ts';
/** `ctx.claude.pluginInstalled`'s factory, for tests: a checker over an injected `claude plugin list --json` runner. */
export { pluginChecks, pluginInstalledChecker, type PluginIdFn, type PluginInstalledFn, type PluginInstalledOptions } from '../server/lib/claudePlugins.ts';
/** Folds several inline `--settings` JSON args into one (Claude keeps only the last), as the core does for launch args. */
export { mergeSettingsArgs } from '../server/lib/sessions.ts';
export { baseRef, branchInfo, parseRepo, worktreesByBranch } from '../server/lib/git.ts';
/** The folders a workspace's sessions and terminals may start in: its worktrees, then the worktrees root. */
export { sessionDirs } from '../server/workspaceSessions.ts';
/**
 * Where the app is served. `publicOrigin`: `https://<hostname>`, or `http://127.0.0.1:<port>` in localhost mode (no
 * hostname). `acceptedOrigins`: every origin a browser may load it from (localhost mode: 127.0.0.1 and localhost, plus the
 * Vite dev port in development). WebSocket routes must check `isAcceptedOrigin(c.req.header('origin'))`: browsers skip
 * CORS there. `publicHost`/`publicAuthority` are undefined in localhost mode.
 */
export { acceptedOrigins, isAcceptedOrigin, publicAuthority, publicOrigin } from '../server/config.ts';
import { config as coreConfig } from '../server/config.ts';
/** The configured hostname (`WORK_HUB_HOSTNAME`), or undefined in localhost mode. */
export const publicHost: string | undefined = coreConfig.publicHost;
/** The id of the transcript enricher whose `state.host` readHistory returns as the page's `host` (the menagerie plugin's). */
export { HOST_ENRICHER_ID } from '../server/lib/transcript.ts';
/** Raw terminal output (ANSI) replayed through a headless xterm into HTML-escaped, coloured spans (the last `maxLines`). */
export { ansiToHtml } from '../server/lib/termhtml.ts';
/** Why a command can't be typed into a session or terminal (one non-empty line, ≤ 2000 characters), or null. */
export { invalidCommand } from '../server/lib/commandText.ts';
/**
 * Folder paths as Settings takes them: `expandFolder` turns `~`/`~/x` into the home folder (trailing slashes dropped);
 * `folderTrustError` says why a folder can't be trusted for `claude --bg` as a plain folder (not absolute, `/`, the home
 * folder or one containing it, a system folder), or null.
 */
export { expandFolder, folderTrustError } from '../server/lib/folders.ts';
/** A route's JSON body (must be an object); otherwise Hono answers 400 `{ error: 'JSON body required' }`. */
export { readJson, JSON_BODY_REQUIRED } from '../server/lib/http.ts';

export type {
  PluginManifest,
  Source,
  SourceState,
  Session,
  Workspace,
  Worktree,
  HistoryEntry,
  HistoryHost,
  FileEdit,
  TranscriptEnricher,
  TranscriptNotice,
  LaunchArgsFn,
  SessionPurpose,
  HidePredicate,
  ReconcilePass,
  Job,
  JobCtx,
  ResolvedPlugin,
  HubEvents,
  PromptContext,
  PromptFragmentFn,
  PromptFragmentKind,
  SourceControlProvider,
  WorkingCopyState,
  AgentInstructionOpts,
};

/**
 * Who may use the app (`ctx.auth.setProvider`; the `auth` plugin's). Without one every request that passes the Host and
 * Origin checks is allowed (localhost mode), and the server refuses to start with a hostname set.
 */
export interface AuthProvider {
  isAuthed(c: Context): boolean | Promise<boolean>;
  /** Answer for a request that isn't signed in (default: 401 JSON for /api, else a redirect to /login). */
  onUnauthed?(c: Context): Response | Promise<Response>;
  /** Paths (exact, or ending in `*` for a prefix) reachable without signing in. */
  publicPaths?: string[];
}

/** One discovered plugin as `ctx.plugins.list()` gives it (a fresh copy each call). */
export interface PluginListEntry {
  id: string;
  /** Former ids (manifest `aliases`); config under them still applies, so they count as taken too. */
  aliases: string[];
  title: string;
  dir: string;
  /** `builtin`: the app's own features (`builtin/<id>/`, always on, not in Settings → Plugins). */
  kind: 'official' | 'local' | 'builtin';
  status: 'active' | 'disabled' | 'replaced' | 'skipped';
  reason?: string;
}

/** Plugin migrations: SQL strings run in order, each once, tracked per plugin. */
export type PluginMigration = string;

export interface PluginPaths {
  stateDir: string;
  configDir: string;
  cacheDir: string;
  repoRoot: string;
  /** Where repos are checked out (one folder per repo name) and the root new git worktrees go under (`<root>/<repo>/<folder>`). */
  reposDir: string;
  worktreesDir: string;
  /**
   * Where plain (no source control) workspaces are created, as `<plainDir>/<name>` (Settings → Folders "Plain
   * workspaces", default `~/workspaces`); `trustWorktree` accepts folders under it. Read on use: Settings can change it.
   */
  plainDir: string;
  /**
   * The ticket-workflow Claude scripts folder (`trust-worktree.sh`, `ensure-ticket-note.sh`…): the ticket-workflow
   * plugin's bundled copy while it's loaded, else `WORK_HUB_TW_SCRIPTS`, else empty (no scripts: leave that step out).
   * Resolved on every read, so read it when you use it, not once in `register()`.
   */
  ticketWorkflowScripts: string;
  /** The `wh` CLI: this checkout's `bin/wh`, a plain path (run it, check it exists). */
  whBin: string;
  /**
   * The `wh` command line to put in prompts (agents record worktrees, links, notes, title and status with it): `whBin`,
   * shell-quoted if needed, prefixed with `WORK_HUB_STATE_DIR='…'` (and the config/cache/DB dirs) when the server's dirs
   * aren't the defaults, because `claude --bg` jobs don't inherit the server's environment. Text for a shell, not a path.
   */
  whCommand: string;
  /** This plugin's own folders under the state and cache dirs (not created until the plugin writes there). */
  pluginState: string;
  pluginCache: string;
}

export interface PluginLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ServerPluginContext {
  id: string;
  manifest: PluginManifest;
  /** The plugin's own folder. */
  pluginDir: string;
  /**
   * The app: routes registered here sit behind the core's access guard. Put them under `/api/plugins/<id>/...` (or an
   * `/api/...` path of your own). A route that would also match one of the core's own routes (`CORE_ROUTES` in
   * server/coreRoutes.ts: same method or `all`; your `:param` and `*` match any segment, e.g. `POST /api/sessions/:id/:action`
   * or `ALL /api/sessions/*`) throws, chained calls included, and the plugin is skipped: plugins load first, so it would
   * shadow the core's. `/api/plugins/<id>/...` never conflicts.
   * `register()` must finish within the plugin timeout (`WORK_HUB_PLUGIN_TIMEOUT_MS`, default 30s) or the plugin is skipped
   * and rolled back as if it had thrown.
   */
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  /**
   * The app's origin (`https://<hostname>`, or `http://127.0.0.1:<port>` in localhost mode). Browsers don't apply
   * same-origin rules to WebSockets: check `Origin` with `isAcceptedOrigin` from this module (it also accepts localhost).
   */
  publicOrigin: string;
  /**
   * The same check as this module's `isAcceptedOrigin` (the app's origin, or localhost), on the context for local plugins,
   * which import this module as types only: a WebSocket route returns 403 unless `ctx.isAcceptedOrigin(c.req.header('origin'))`.
   */
  isAcceptedOrigin(origin: string | undefined | null): boolean;
  registry: {
    /** Throws if a source with this id already exists (the core's or another plugin's); the plugin is then skipped. */
    add(source: Source): void;
    refresh(id: string): Promise<void>;
    on(event: 'change', fn: (s: SourceState) => void): void;
  };
  /** Fields of a source's keyed list (`data[listKey]`) whose change low-data connections get at once (lib/sourceDelta.ts). */
  urgent(sourceId: string, listKey: string, fields: string[]): void;
  /**
   * GET JSON routes the UI polls: ETag-revalidated (empty 304 when unchanged). Hono-style paths (`:param`, trailing `*`).
   * Call it in `register()`, before registering the routes (one core middleware ahead of every route applies the list).
   */
  revalidate(paths: string[]): void;
  db: {
    migrate(migrations: PluginMigration[]): void;
    raw(): DatabaseSync;
  };
  store: typeof workspacesStore;
  /** Read-only: what the loader found and plugins.json. Changing plugins.json is the user's (Settings → Plugins). */
  plugins: {
    /** Every discovered plugin, built-ins included, with the status the loader gave it (read at call time). */
    list(): PluginListEntry[];
    /** plugins.json's `local` folders and `enabled` switches, read from disk on each call (a broken file throws). */
    config(): { local: string[]; enabled: Record<string, boolean> };
    /** Where plugins.json is (`WORK_HUB_PLUGINS_FILE`, else `<configDir>/plugins.json`); it may not exist yet. */
    configFile: string;
  };
  sessions: {
    list(): Session[];
    /** A session by id or short id from the cached list; on a miss (e.g. just after a restart) the list is refreshed once and retried. */
    find(id: string): Promise<Session | undefined>;
    /**
     * `claude --bg` in `cwd` (launch-args fns apply; emits `session-started`). No name/model = Claude's own; `purpose`
     * defaults to 'manual'. `addDirs`: folders outside `cwd` the session may
     * read and write without permission prompts (one `--add-dir=<dir>` each), e.g. a local plugin's folder.
     */
    startBackground(opts: { cwd: string; name?: string; model?: string; prompt: string; purpose?: string; addDirs?: string[] }): Promise<{ shortId: string; sessionId: string; output: string }>;
    /** `claude stop` (background) or SIGTERM (interactive); emits `session-stopped`. */
    stop(s: Pick<Session, 'kind' | 'shortId' | 'pid'> & { sessionId?: string }): Promise<void>;
    /**
     * Trust a directory under the worktrees root for Claude Code (`projects[path].hasTrustDialogAccepted` in its config, written
     * atomically), so `claude --bg` can start there. Throws for a path outside the root. Agents use `wh trust <path>`.
     */
    trustWorktree(path: string): Promise<{ path: string; changed: boolean }>;
    /** Worktrees a session created or moved into, besides the folder it started in (reconcile's transcript scan, `session_worktrees`). */
    boundWorktrees(sessionId: string): string[];
    typeInto: typeof attachLib.typeIntoJob;
    typeSequence: typeof attachLib.typeSequence;
    KEY_BYTES: typeof attachLib.KEY_BYTES;
    hide(pred: HidePredicate): void;
    addLaunchArgs(fn: LaunchArgsFn): void;
    readHistory: typeof transcriptLib.readHistory;
    /** A session's notices (hook feedback, task notifications: what the conversation views leave out), oldest first. */
    readNotices: typeof transcriptLib.readNotices;
    findTranscript: typeof transcriptLib.findTranscript;
    lastActivity: typeof transcriptLib.lastActivity;
    sessionMeta: typeof transcriptLib.sessionMeta;
    /** Every response's model and token usage in a session's transcript (null if unreadable). */
    sessionUsage: typeof transcriptLib.sessionUsage;
    /** Every recorded file change in a session (Edit/Write tools and Bash snapshots), oldest first (null if unreadable). */
    sessionEdits: typeof transcriptLib.sessionEdits;
    /** The AskUserQuestion call `toolUseId` if it's still unanswered (no result yet), else null. */
    pendingQuestion: typeof transcriptLib.pendingQuestion;
    /** The session's unanswered AskUserQuestion (its tool entry), or null: a form is up, so typed keys would answer it. */
    openQuestion: typeof transcriptLib.openQuestion;
    /** The cached transcript: its entries and an enricher's state by enricher id (e.g. full outputs an enricher keeps); null if unreadable. */
    transcriptState: typeof transcriptLib.transcriptState;
  };
  /** Fields on transcript entries (lib/transcript.ts); sessions already read are re-read with it. */
  transcript: { addEnricher<S>(e: TranscriptEnricher<S>): void };
  /** Text added to the prompts the core writes (lib/prompts.ts), and the joined fragments of a kind for your own prompts. */
  prompts: {
    addFragment(kind: PromptFragmentKind, fn: PromptFragmentFn): void;
    fragments(kind: PromptFragmentKind, ctx?: PromptContext): string;
    /** The rules every workspace session's prompt ends with (the core's, then every `workspace-rules` fragment), as lines. */
    workspaceRules(workspaceId: string): string[];
    /** A workspace session's full prompt: what the workspace is about (ticket, plan, worktrees, links, earlier sessions), its rules, then `task`. */
    workspaceContext(ws: Workspace, task: string): Promise<string>;
  };
  /**
   * The file viewer (a session's file links): `addRoot` lets it serve files under `dir` for every session (still no secrets or .git).
   * Keep `dir` inside a folder the plugin owns, normally `paths.pluginState`: never a broad root such as the home or state dir.
   */
  files: {
    addRoot(dir: string): void;
    /** Every folder plugins have added with `addRoot` (the file-links plugin adds them to each session's scope). */
    roots(): string[];
  };
  jobs: { start: typeof jobsLib.startJob; registerResumer: typeof jobsLib.registerResumer };
  events: {
    on<K extends keyof HubEvents & string>(name: K, fn: (payload: HubEvents[K]) => void | Promise<void>): () => void;
    emit<K extends keyof HubEvents & string>(name: K, payload: HubEvents[K]): void;
  };
  reconcile: {
    addPass(fn: ReconcilePass): void;
    /** Ask for a reconcile pass now (e.g. your source changed); passes never overlap, so this may just queue one. */
    run(): void;
  };
  /**
   * Source-control providers (git and folder are the core's). `register` adds one (an id already registered throws);
   * `detect` finds the provider whose working copy `path` is in and its root: `prefer` (a provider id) is asked first,
   * then git, jj, hg, p4, the others as registered, and folder last (it matches any path, never beating a real match).
   */
  vcs: {
    register(p: SourceControlProvider): void;
    get(id: string): SourceControlProvider | undefined;
    list(): SourceControlProvider[];
    detect(path: string, opts?: { prefer?: string | null }): Promise<{ provider: SourceControlProvider; root: string } | null>;
    /** Settings → Source control's default provider id, or null for Detect (or a provider that isn't registered). */
    effectiveDefault(): string | null;
  };
  auth: { setProvider(p: AuthProvider): void };
  guard: { addPublicPaths(paths: string[]): void };
  /**
   * Runs once the server is listening and the core's resume tasks have started. Every plugin's hooks run at the same time
   * (no order between them); one that throws or takes longer than the plugin timeout is logged and the others carry on.
   */
  onStart(fn: () => void | Promise<void>): void;
  paths: PluginPaths;
  /** `WORK_HUB_<ID>_<KEY>` env var first (coerced to the default's type), then plugins.json `settings[id][key]`, else the default. */
  config: {
    get<T = unknown>(key: string, dflt: T): T;
    get<T = unknown>(key: string): T | undefined;
  };
  exec: { run: typeof execLib.run; runJson: typeof execLib.runJson };
  headless: { askClaudeJson: typeof headlessLib.askClaudeJson };
  git: typeof gitLib;
  /** Claude Code itself (`server/lib/claudePlugins.ts`). */
  claude: {
    /**
     * Whether the user has Claude plugin `name` installed (the part of its id before `@`), from `claude plugin list --json`
     * (read-only). `scope`: 'user' (default), 'project' (any project's) or 'any'; `enabledOnly` (default true) skips
     * disabled installs. Use it to skip loading a bundled copy (`--plugin-dir` launch args) the user already has, so it
     * doesn't load twice. The listing is cached per process once it succeeds; while the CLI fails (15s timeout) this
     * answers false and the next call tries again.
     */
    pluginInstalled: PluginInstalledFn;
    /**
     * The installed id (`<name>@<marketplace>`) of plugin `name`, or null: same listing, scopes and cache as
     * `pluginInstalled`. Use it to turn a user's own copy off for the sessions the app starts (inline
     * `--settings '{"enabledPlugins":{"<id>":false}}'`) when a bundled copy must win.
     */
    pluginId: PluginIdFn;
  };
  /** Share an API between plugins: `expose` in one, `get` in another (declare it in `requires`). */
  services: {
    expose(name: string, api: unknown): void;
    get<T>(name: string): T;
  };
  log: PluginLog;
}

/**
 * A plugin's server entry: `export default function register(ctx) { … }`. If it throws, the plugin is marked skipped and
 * what it registered is taken back: services, enrichers, launch args, reconcile passes, hide predicates, urgent fields,
 * prompt fragments, file roots, source-control providers, public paths and the auth provider. Routes and middleware already on `ctx.app`, sources already added
 * and event listeners can't be removed, so register those last.
 */
export type RegisterServerPlugin = (ctx: ServerPluginContext) => void | Promise<void>;
