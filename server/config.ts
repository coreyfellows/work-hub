// Central config. Everything is overridable with env vars so you can tweak without code edits.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { shellWord } from './lib/shellWord.ts';

const env = process.env;

/** The repos / worktrees folders in force (env, else Settings, else the default), set at startup by index.ts. */
let folderResolver: ((which: 'repos' | 'worktrees') => string | undefined) | null = null;
export function setFolderResolver(f: typeof folderResolver): void {
  folderResolver = f;
}
const home = env.HOME ?? homedir();

/** The checked-out repo (server/.. ), for things the app runs from its own tree (bin/wh, hooks). */
export const repoRoot = resolve(import.meta.dirname, '..');

// Every file the app writes lives under ONE directory, so one setting moves the whole install
// (a second copy of the app on other ports must never touch the first one's state).
const stateDir = env.WORK_HUB_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, '.local/state'), 'work-hub');
const configDir = env.WORK_HUB_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'work-hub');
const cacheDir = env.WORK_HUB_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'work-hub');

/**
 * The `wh` command line agents are told to run. Sessions the app starts are `claude --bg` jobs, which Claude's own
 * background service spawns: they do NOT inherit the server's environment (checked: a variable set on `claude --bg`
 * isn't seen by the job's Bash calls). So every dir whose effective value isn't the plain `$HOME` default
 * (`~/.local/state/work-hub`, `~/.config/work-hub`, `~/.cache/work-hub`, `<state>/hub.db`) is written into the
 * command, e.g. `WORK_HUB_STATE_DIR='/x' /repo/bin/wh`: that covers `WORK_HUB_*` and `XDG_*` settings alike. A default
 * install gets just the path (quoted only if it needs it).
 */
export function whCommand(
  whBin: string,
  dirs: { stateDir: string; configDir: string; cacheDir: string; dbFile: string },
  home: string = process.env.HOME ?? homedir(),
): string {
  const prefix: string[] = [];
  const add = (name: string, value: string, dflt: string) => {
    if (resolve(value) !== resolve(dflt)) prefix.push(`${name}=${shellWord(value)}`);
  };
  add('WORK_HUB_STATE_DIR', dirs.stateDir, join(home, '.local/state', 'work-hub'));
  add('WORK_HUB_CONFIG_DIR', dirs.configDir, join(home, '.config', 'work-hub'));
  add('WORK_HUB_CACHE_DIR', dirs.cacheDir, join(home, '.cache', 'work-hub'));
  // `wh` derives the DB from its state dir, so only a DB somewhere else needs saying.
  add('WORK_HUB_DB', dirs.dbFile, join(dirs.stateDir, 'hub.db'));
  return [...prefix, shellWord(whBin)].join(' ');
}

export const config = {
  stateDir,
  configDir,
  cacheDir,
  /** SQLite file with the workspace model (server/store/db.ts). */
  dbFile: env.WORK_HUB_DB ?? join(stateDir, 'hub.db'),
  /** Which plugins are on, local plugin folders and per-plugin settings (server/plugins/config.ts; missing = defaults). */
  pluginsFile: env.WORK_HUB_PLUGINS_FILE ?? join(configDir, 'plugins.json'),
  /** The plugins that ship with the app. */
  officialPluginsDir: join(repoRoot, 'plugins'),
  /** The `wh` CLI (this checkout's own copy), a plain path. Prompts use `whCommand` (below). */
  whBin: join(repoRoot, 'bin', 'wh'),
  /** What agents are told to run: `whBin`, prefixed with this server's dirs when they aren't the defaults (`whCommand`). */
  whCommand: whCommand(join(repoRoot, 'bin', 'wh'), { stateDir, configDir, cacheDir, dbFile: env.WORK_HUB_DB ?? join(stateDir, 'hub.db') }),

  // Bound to loopback only; this app can type into your terminals, so it must never be reachable off-box.
  host: '127.0.0.1',
  port: Number(env.WORK_HUB_PORT ?? 4848),
  // Vite dev server port (dev only); with a hostname set its proxy rewrites Host/Origin to the public ones.
  devWebPort: Number(env.WORK_HUB_WEB_PORT ?? 4849),

  // No hostname (the default) = localhost mode: the app answers only on 127.0.0.1/localhost and nobody signs in, which is
  // safe only because nothing off this machine can reach it. Setting one (LAN access, scripts/setup-lan.sh behind a TLS
  // front) makes that the only name the app answers on, and the server refuses to start unless the auth plugin is on.
  publicHost: env.WORK_HUB_HOSTNAME?.trim() || undefined,
  publicPort: Number(env.WORK_HUB_PUBLIC_PORT ?? 443),

  // Polling (and any token spend) pauses when no visible browser tab is connected or the machine
  // has had no keyboard/mouse input for this long.
  idleThresholdMs: Number(env.WORK_HUB_IDLE_MS ?? 10 * 60_000),
  /** How long one plugin's register(), or one onStart hook, may take before the plugin is skipped (or the hook given up on). */
  pluginTimeoutMs: Number(env.WORK_HUB_PLUGIN_TIMEOUT_MS ?? 30_000),
  /** Low-data SSE connections (`/api/events?low=1`) get a source's non-urgent changes at most this often. */
  lowDataBatchMs: Number(env.WORK_HUB_LOW_DATA_BATCH_MS ?? 10_000),


  claude: {
    intervalMs: Number(env.WORK_HUB_CLAUDE_INTERVAL_MS ?? 4_000),
    // How long finished background jobs stay visible.
    recentDoneMs: Number(env.WORK_HUB_RECENT_DONE_MS ?? 24 * 3600_000),
  },

  paths: {
    // Working dir for headless claude -p runs; sessions here are hidden from the sessions panel.
    scratch: cacheDir,
    // Read on every use: Settings → Folders can change them while the server runs (index.ts sets the resolver).
    get repos(): string {
      return folderResolver?.('repos') ?? env.WORK_HUB_REPOS_DIR ?? `${home}/repos`;
    },
    get worktrees(): string {
      return folderResolver?.('worktrees') ?? env.TW_WORKTREES_ROOT ?? `${home}/worktrees`;
    },
    // The ticket-workflow scripts when the ticket-workflow plugin is off (it supplies its own bundled copy when on).
    ticketWorkflowScripts: env.WORK_HUB_TW_SCRIPTS ?? '',
  },

};

/** Only `pnpm dev` (scripts/dev.ts) sets WORK_HUB_DEV=1; a plain `node server/index.ts` is not development. */
export function devMode(e: NodeJS.ProcessEnv): boolean {
  return e.WORK_HUB_DEV === '1';
}

export interface AccessInput {
  publicHost?: string;
  publicPort: number;
  /** The API's loopback port. */
  port: number;
  /** The Vite dev server port (its proxy forwards Host as is in localhost mode). */
  devWebPort?: number;
  /** Development (`WORK_HUB_DEV=1`, set by `pnpm dev`): also accept the Vite dev server's authorities. */
  dev?: boolean;
}

export interface Access {
  /** Host header / authority as browsers send it for the public name (default HTTPS port omitted); undefined in localhost mode. */
  publicAuthority: string | undefined;
  /** The origin the app is served at: `https://<publicAuthority>`, or `http://127.0.0.1:<port>` in localhost mode. */
  publicOrigin: string;
  /** Host headers the guard accepts. */
  acceptedAuthorities: string[];
  /** Origins a write or WebSocket may come from. */
  acceptedOrigins: string[];
}

/** Which names and origins the app answers to (pure, for the guard and its tests). */
export function accessFor(o: AccessInput): Access {
  if (o.publicHost) {
    const authority = o.publicPort === 443 ? o.publicHost : `${o.publicHost}:${o.publicPort}`;
    const origin = `https://${authority}`;
    return { publicAuthority: authority, publicOrigin: origin, acceptedAuthorities: [authority], acceptedOrigins: [origin] };
  }
  const ports = [o.port, ...(o.dev && o.devWebPort ? [o.devWebPort] : [])];
  const authorities = ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]);
  return {
    publicAuthority: undefined,
    publicOrigin: `http://127.0.0.1:${o.port}`,
    acceptedAuthorities: authorities,
    acceptedOrigins: authorities.map((a) => `http://${a}`),
  };
}

export const access = accessFor({
  publicHost: config.publicHost,
  publicPort: config.publicPort,
  port: config.port,
  devWebPort: config.devWebPort,
  dev: devMode(process.env),
});
export const publicAuthority = access.publicAuthority;
/** The browser origin the app is served at (`https://<hostname>`, or `http://127.0.0.1:<port>` in localhost mode). */
export const publicOrigin = access.publicOrigin;
export const acceptedAuthorities = access.acceptedAuthorities;
export const acceptedOrigins = access.acceptedOrigins;

/** Whether a request's Origin header is one the app is served at (WebSocket routes check it: browsers skip CORS there). */
export function isAcceptedOrigin(origin: string | undefined | null): boolean {
  return !!origin && acceptedOrigins.includes(origin);
}
