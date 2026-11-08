import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { acceptedAuthorities, config, isAcceptedOrigin, publicOrigin, repoRoot, setFolderResolver, setVcsDefaultResolver } from './config.ts';
import { expandFolder, foldersGroup, PLAIN_KEY, REPOS_KEY, WORKTREES_KEY } from './lib/folders.ts';
import { VCS_DEFAULT_KEY, vcsGroup } from './lib/vcs/default.ts';
import { pendingOffers, registerSetupRoutes } from './setupRoute.ts';
import { readPluginsConfig, writePluginsConfig } from './plugins/config.ts';
import { cleanupAfterClose, registerWorktreeRoutes } from './worktreeRoutes.ts';
import { Registry, type HubStatus, type SourceState } from './registry.ts';
import { assertStartupSafe, installGuard } from './guard.ts';
import { pluginRegistries } from './plugins/context.ts';
import { run, runJson } from './lib/exec.ts';
import { backgroundTasks, findTranscript, lastActivity, openQuestion, pendingQuestion, readHistory, readNotices, sessionEdits, sessionMeta, sessionUsage, transcriptState } from './lib/transcript.ts';
import { claudeSource, type ClaudeData, type Session } from './sources/claude.ts';
import { markSeen } from './store/sessionReads.ts';
import { setSessionName } from './store/sessionNames.ts';
import { getLayout, setLayout } from './store/uiLayout.ts';
import { workspacesSource } from './sources/workspaces.ts';
import { listWorkspaces } from './store/workspaces.ts';
import { addLaunchArgs, startBackgroundSession, stopSession, trustWorktree } from './lib/sessions.ts';
import { buildHubSkills } from './lib/hubSkills.ts';
import { dismissJob, registerResumer, setJobsListener, startJob, useJobsStore } from './jobs.ts';
import { sqliteJobsStore } from './store/jobs.ts';
import { jobsSource } from './sources/jobs.ts';
import { reconcile } from './reconcile.ts';
import { contextPrompt, workspaceRules } from './workspaceSessions.ts';
import { ALLOWED_KEYS, KEY_BYTES, typeIntoJob, typeSequence } from './lib/attach.ts';
import { SourceStream } from './lib/sourceStream.ts';
import { addRevalidate, installRevalidate } from './lib/revalidate.ts';
import { taskProgress } from './lib/taskProgress.ts';
import { coreHooks } from './plugins/coreHooks.ts';
import { readBuildId } from './lib/buildId.ts';
import { addSession, getWorkspace, logEvent, setStatus, type WorkspaceStatus } from './store/workspaces.ts';
import { loadPlugins, runStartHooks } from './plugins/loader.ts';
import { CORE_ROUTES } from './coreRoutes.ts';
import { registerPluginsConfigRoutes } from './plugins/configRoute.ts';
import { registerSettingsRoutes } from './settingsRoute.ts';
import { registerTrustedFolderRoutes } from './trustedFoldersRoute.ts';
import { registerApplyRoutes } from './applyRoute.ts';
import { registerSettingsGroup, resolveFull } from './settings.ts';
import { askClaudeJson } from './lib/headless.ts';
import { readJson } from './lib/http.ts';
import { pluginId, pluginInstalled } from './lib/claudePlugins.ts';
import * as gitLib from './lib/git.ts';
import { listProviders, registerProvider } from './lib/vcs/registry.ts';
import { gitProvider } from './lib/vcs/git.ts';
import { folderProvider } from './lib/vcs/folder.ts';
import * as workspacesStore from './store/workspaces.ts';
import { getDb } from './store/db.ts';
import { boundWorktrees } from './store/sessionWorktrees.ts';

const registry = new Registry({ idleThresholdMs: config.idleThresholdMs })
  .add(workspacesSource)
  .add(jobsSource)
  .add(claudeSource);
setJobsListener(() => void registry.refresh('jobs').catch(() => {}));
// registry.start() waits until the plugins are loaded (below), so their hide predicates and enrichers apply to the first fetch.

// Keep the workspace model in step with what sessions do (server/reconcile.ts): adopt sessions a workspace
// session started or that run in its worktrees, record their worktrees, link their PRs. One pass at a time.
let reconciling = false;
let reconcileAgain = false;
async function runReconcile(): Promise<void> {
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      const sessions = (registry.get('claude')?.data as ClaudeData | null)?.sessions;
      if (!sessions) break;
      const changed = await reconcile(sessions).catch((e) => {
        console.error('reconcile:', e);
        return false;
      });
      if (changed) void registry.refresh('workspaces');
    } while (reconcileAgain);
  } finally {
    reconciling = false;
  }
}
registry.on('change', (s: SourceState) => {
  if (s.id === 'claude') void runReconcile();
});

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// --- Access guard (server/guard.ts) ------------------------------------------------------
// Host must be one the app answers on, writes JSON from an accepted origin; signing in is the auth plugin's, when on.
installGuard(app, {
  acceptedAuthorities,
  isAcceptedOrigin,
  provider: () => pluginRegistries.authProvider?.provider ?? null,
  publicPaths: () => pluginRegistries.publicPaths.map((p) => p.path),
});

// JSON the UI polls: revalidated with an ETag, so an unchanged poll is an empty 304 (server/lib/revalidate.ts). One
// middleware, here ahead of every route, covers these and whatever plugins add (`ctx.revalidate`).
addRevalidate([
  '/api/layout',
  '/api/vcs',
  '/api/sessions/:id/file-edits',
  '/api/sessions/:id/tasks',
]);
installRevalidate(app);

// Settings → Folders: the repos and worktrees folders (env, else Settings, else ~/repos and ~/worktrees), read on every use.
registerSettingsGroup(foldersGroup());
setFolderResolver((which) => {
  const v = resolveFull(which === 'repos' ? REPOS_KEY : which === 'plain' ? PLAIN_KEY : WORKTREES_KEY)?.value;
  return typeof v === 'string' && v.trim() ? expandFolder(v) : undefined;
});
// Settings → Source control: the default provider ('detect' unless chosen).
registerSettingsGroup(vcsGroup());
setVcsDefaultResolver(() => {
  const v = resolveFull(VCS_DEFAULT_KEY)?.value;
  return typeof v === 'string' && v ? v : undefined;
});

// The core's source-control providers, before plugins add theirs (`ctx.vcs.register`).
registerProvider(gitProvider, 'core');
registerProvider(folderProvider, 'core');

// --- Plugins -----------------------------------------------------------------------------
// After the guard (so plugin routes sit behind it) and before the core routes and the /api/* 404. Plugins add their
// sources, routes, job resumers and migrations here; their onStart hooks run after serve() below.
const plugins = await loadPlugins(app, {
  officialDir: config.officialPluginsDir,
  pluginsFile: config.pluginsFile,
  timeoutMs: config.pluginTimeoutMs,
  coreRoutes: CORE_ROUTES,
  upgradeWebSocket,
  registry,
  store: workspacesStore,
  sessions: {
    startBackground: (o) => startBackgroundSession({ ...o, purpose: o.purpose ?? 'manual' }),
    stop: stopSession,
    trustWorktree: (path) => trustWorktree(path),
    boundWorktrees,
    typeInto: typeIntoJob,
    typeSequence,
    KEY_BYTES,
    readHistory,
    readNotices,
    findTranscript,
    lastActivity,
    sessionMeta,
    sessionUsage,
    sessionEdits,
    pendingQuestion,
    openQuestion,
    transcriptState,
  },
  jobs: { start: startJob, registerResumer },
  db: { raw: getDb },
  exec: { run, runJson },
  headless: { askClaudeJson },
  git: gitLib,
  claude: { pluginInstalled, pluginId },
  paths: {
    stateDir: config.stateDir,
    configDir: config.configDir,
    cacheDir: config.cacheDir,
    repoRoot,
    // Getters: Settings → Folders can change them while the server runs.
    get reposDir() {
      return config.paths.repos;
    },
    get worktreesDir() {
      return config.paths.worktrees;
    },
    get plainDir() {
      return config.paths.plain;
    },
    ticketWorkflowScripts: config.paths.ticketWorkflowScripts,
    whBin: config.whBin,
    whCommand: config.whCommand,
  },
  workspaceRules,
  workspaceContext: contextPrompt,
  runReconcile: () => void runReconcile(),
  publicOrigin,
  isAcceptedOrigin,
  // The same ETag registry as the list above.
  applyRevalidate: addRevalidate,
  hooks: coreHooks,
  resolveSetting: resolveFull,
});
for (const e of plugins.resolution.errors) console.error('plugins:', e);
// The shared `work-hub` Claude plugin (lib/hubSkills.ts): exactly the active plugins' skills, rebuilt now, and passed to
// every session the app starts so `/work-hub:<skill>` works there and `/reload-plugins` sees what changed since.
try {
  const hub = buildHubSkills(
    join(config.stateDir, 'claude-plugin', 'work-hub'),
    plugins.resolution.plugins.filter((p) => p.status === 'active').map((p) => ({ id: p.manifest.id, dir: p.dir, skills: p.manifest.skills })),
  );
  for (const w of hub.warnings) console.warn(w);
  addLaunchArgs(({ purpose }) => (purpose === 'headless' ? [] : ['--plugin-dir', hub.dir]));
} catch (e) {
  console.error('work-hub skills:', (e as Error).message);
}
// A public hostname with nobody signing in would put the app on the LAN wide open: refuse to start.
try {
  assertStartupSafe({ publicHost: config.publicHost, provider: pluginRegistries.authProvider?.provider ?? null });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// Only now: the first sessions fetch (and the reconcile it triggers) must see every plugin's hide predicates, e.g.
// adversarial-review's wh-review: reviewer runs, which reconcile would otherwise adopt into a workspace.
registry.start();
// Settings → Plugins: read and write plugins.json (applies on the next start and build).
registerPluginsConfigRoutes(app, { pluginsFile: config.pluginsFile, officialDir: config.officialPluginsDir });
registerSettingsRoutes(app);
// "Apply now": rebuild the bundle and, when a supervisor will bring it back, restart (applyRoute.ts).
registerApplyRoutes(app, { repoRoot });
registerSetupRoutes(app, {
  offers: () => {
    const enabled = readPluginsConfig(config.pluginsFile, () => {}).enabled;
    return pendingOffers(plugins.resolution.plugins, new Set(Object.keys(enabled).filter((id) => enabled[id] === false)));
  },
  enable: (ids) => {
    // Like Settings → Plugins: refuse to rewrite a plugins.json that has entries it would drop.
    const warnings: string[] = [];
    const cfg = readPluginsConfig(config.pluginsFile, (m) => warnings.push(m));
    if (warnings.length) throw new Error(`fix plugins.json first: ${warnings.join('; ')}`);
    writePluginsConfig(config.pluginsFile, { ...cfg, enabled: { ...cfg.enabled, ...Object.fromEntries(ids.map((id) => [id, true])) } });
  },
});

// The workspace panel's tab and section order, shared by every workspace and device (store/uiLayout.ts).
app.get('/api/layout', (c) => c.json(getLayout()));
app.post('/api/layout', async (c) => c.json(setLayout(await c.req.json().catch(() => null))));

// Confirm a plain folder outside the plain root for `claude --bg` (the UI asks first; `trustWorktree` then accepts it).
registerTrustedFolderRoutes(app);
// New workspace's Source control choice: the registered providers and Settings' default ('detect' unless chosen).
app.get('/api/vcs', (c) =>
  c.json({ providers: listProviders().map((p) => ({ id: p.id, title: p.title, experimental: !!p.experimental })), default: config.vcsDefault }),
);

// --- Sources ---------------------------------------------------------------------------
app.get('/api/state', (c) => c.json(registry.all()));
app.get('/api/status', (c) => c.json(registry.hubStatus()));

app.post('/api/sources/:id/refresh', async (c) => {
  await registry.refresh(c.req.param('id')).catch(() => {});
  return c.json(registry.get(c.req.param('id')) ?? null);
});

// The UI build being served; tabs on another build reload when they (re)connect to /api/events.
const buildId = process.env.NODE_ENV === 'production' ? readBuildId('./dist') : null;

// Each open, visible browser tab holds one of these; the registry only polls while there's at least one.
app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    if (buildId) void stream.writeSSE({ event: 'build', data: buildId });
    // Whole state once per source, then only what changed (server/lib/sourceStream.ts).
    const low = c.req.query('low') === '1';
    const sources = new SourceStream((event, data) => void stream.writeSSE({ event, data }), {
      batchMs: low ? config.lowDataBatchMs : 0,
    });
    const sendStatus = (h: HubStatus) => stream.writeSSE({ event: 'status', data: JSON.stringify(h) });
    for (const s of registry.all()) sources.change(s);
    const onChange = (s: SourceState) => sources.change(s);
    const onStatus = (h: HubStatus) => void sendStatus(h);
    registry.on('change', onChange);
    registry.on('status', onStatus);
    registry.viewerJoined();
    await sendStatus(registry.hubStatus());
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 20_000);
    await new Promise<void>((done) => stream.onAbort(done));
    clearInterval(ping);
    sources.close();
    registry.off('change', onChange);
    registry.off('status', onStatus);
    registry.viewerLeft();
  }),
);

// --- Claude session actions --------------------------------------------------------------
function lookupSession(id: string): Session | undefined {
  const data = registry.get('claude')?.data as ClaudeData | null | undefined;
  return data?.sessions.find((s) => s.sessionId === id || s.shortId === id);
}

/** Find a session; if it isn't in the cached list (e.g. just after a restart), refresh once and retry. */
async function findSession(id: string): Promise<Session | undefined> {
  const hit = lookupSession(id);
  if (hit) return hit;
  await registry.refresh('claude').catch(() => {});
  return lookupSession(id);
}

/** Type into a session. Only background jobs are reachable (via a brief pty attach). */
async function typeInto(s: Session, input: { text?: string; submit?: boolean; key?: string }): Promise<void> {
  if (s.kind !== 'background') throw new Error('interactive sessions can only be used from their own terminal');
  return typeIntoJob(s.shortId, input);
}


/**
 * The changes a session made to one file (Edit/Write tools and, with bash-snapshots, commands), oldest first; `[]` if the
 * transcript can't be read. Core data (plugins' enrichers fill it): session-stats' Files changed modal reads it.
 */
app.get('/api/sessions/:id/file-edits', async (c) => {
  const s = await findSession(c.req.param('id'));
  const path = c.req.query('path');
  if (!s) return c.json({ error: 'session not found' }, 404);
  if (!path) return c.json({ error: 'path required' }, 400);
  const edits = await sessionEdits(s.sessionId).catch(() => null);
  return c.json((edits ?? []).filter((e) => e.path === path));
});

/** A session's running background tasks (`Session.tasks`), each with its progress read from its output file. */
app.get('/api/sessions/:id/tasks', async (c) => {
  const s = await findSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const info = s.tasks.length ? await backgroundTasks(s.sessionId) : null;
  const tasks = await Promise.all(s.tasks.map(async (t) => ({ ...t, progress: await taskProgress(t.kind, info?.get(t.id)) })));
  return c.json({ tasks });
});

/** You've looked at this session (its page is open and visible): it's no longer unread. */
app.post('/api/sessions/:id/seen', async (c) => {
  const s = lookupSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  markSeen(s.sessionId, Date.now());
  if (s.unread) await registry.refresh('claude').catch(() => {});
  return c.json({ ok: true });
});

/** Rename a session in the app ({ name }; empty goes back to the name Claude gave it). */
app.post('/api/sessions/:id/name', async (c) => {
  const s = lookupSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const { name } = await readJson<{ name: string }>(c);
  if (typeof name !== 'string' || name.length > 200) return c.json({ error: 'bad name' }, 400);
  setSessionName(s.sessionId, name);
  await registry.refresh('claude').catch(() => {});
  refreshModel();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/send', async (c) => {
  const s = await findSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const { text, submit = true } = await readJson<{ text: string; submit?: boolean }>(c);
  if (typeof text !== 'string' || !text.length) return c.json({ error: 'text required' }, 400);
  try {
    await typeInto(s, { text, submit });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
  void registry.refresh('claude');
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/key', async (c) => {
  const s = await findSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const { key } = await readJson<{ key: string }>(c);
  if (!ALLOWED_KEYS.has(key)) return c.json({ error: `key not allowed: ${key}` }, 400);
  try {
    await typeInto(s, { key });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
  void registry.refresh('claude');
  return c.json({ ok: true });
});



app.post('/api/sessions', async (c) => {
  const { cwd, prompt, name } = await readJson<{ cwd: string; prompt: string; name?: string }>(c);
  if (!prompt?.trim()) return c.json({ error: 'prompt required' }, 400);
  const dir = resolve((cwd || '~').replace(/^~(?=$|\/)/, homedir()));
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) return c.json({ error: `not a directory: ${dir}` }, 400);
  try {
    const s = await startBackgroundSession({ cwd: dir, name, prompt, purpose: 'manual' });
    void registry.refresh('claude');
    return c.json({ ok: true, output: s.output.trim(), shortId: s.shortId, sessionId: s.sessionId });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// --- Workspaces ------------------------------------------------------------------------------
const refreshModel = () => void registry.refresh('workspaces');

const STATUSES: WorkspaceStatus[] = ['setting-up', 'active', 'parked', 'done'];
app.post('/api/workspaces/:id/status', async (c) => {
  const { status } = await readJson<{ status: WorkspaceStatus }>(c);
  if (!getWorkspace(c.req.param('id'))) return c.json({ error: 'no such workspace' }, 404);
  if (!STATUSES.includes(status)) return c.json({ error: 'bad status' }, 400);
  setStatus(c.req.param('id'), status);
  refreshModel();
  return c.json({ ok: true });
});

app.post('/api/workspaces/:id/title', async (c) => {
  const { title } = await readJson<{ title: string }>(c);
  if (!getWorkspace(c.req.param('id'))) return c.json({ error: 'no such workspace' }, 404);
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t || t.length > 200) return c.json({ error: 'a title (up to 200 characters) is required' }, 400);
  workspacesStore.updateWorkspace(c.req.param('id'), { title: t });
  refreshModel();
  return c.json({ ok: true });
});

/** Attach a live, unassigned Claude session to a workspace. */
app.post('/api/workspaces/:id/sessions', async (c) => {
  const { sessionId, role } = await readJson<{ sessionId: string; role?: string }>(c);
  const id = c.req.param('id');
  const s = await findSession(sessionId);
  if (!getWorkspace(id) || !s) return c.json({ error: 'unknown workspace or session' }, 404);
  addSession(id, { claudeSessionId: s.sessionId, role: role ?? 'main', name: s.name, cwd: s.cwd });
  refreshModel();
  return c.json({ ok: true });
});

/**
 * Close (stop) a workspace session: its record stays, and `claude attach` / `claude --resume` still reopen it. Core
 * plumbing: the ✕ on a session tab and session-tools' "Close session" both post here.
 */
app.post('/api/workspaces/:id/sessions/:sid/close', async (c) => {
  const ws = getWorkspace(c.req.param('id'));
  const s = await findSession(c.req.param('sid'));
  if (!ws || !s) return c.json({ error: 'unknown workspace or session' }, 404);
  if (!ws.sessions.some((r) => r.claudeSessionId === s.sessionId)) return c.json({ error: "this session isn't in the workspace" }, 500);
  try {
    await stopSession(s);
    logEvent(ws.id, 'session-closed', `${s.shortId} (${s.name})`);
    refreshModel();
    await registry.refresh('claude').catch(() => {});
    // Remove the worktrees only this session used, when that loses nothing (Settings → Folders); the rest are kept and logged.
    const cleanup = await cleanupAfterClose(ws.id, { sessionId: s.sessionId, cwd: s.cwd }, liveSessions()).catch(() => ({ removed: [], kept: [] }));
    if (cleanup.removed.length) refreshModel();
    return c.json({ ok: true, ...cleanup });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
const liveSessions = () => ((registry.get('claude')?.data as ClaudeData | null | undefined)?.sessions ?? []).map((x) => ({ sessionId: x.sessionId, name: x.name, cwd: x.cwd, status: x.status }));
registerWorktreeRoutes(app, { liveSessions });


// --- Trash an unassigned session ---------------------------------------------------------------
// Reversible on purpose: background jobs are stopped (`claude attach` reopens them) and interactive
// ones get SIGTERM (`claude --resume` continues them). Sessions in a workspace can't be trashed here.
app.post('/api/sessions/:id/trash', async (c) => {
  const s = await findSession(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const owned = listWorkspaces({ includeDone: true }).some((w) => w.sessions.some((r) => r.claudeSessionId === s.sessionId));
  if (owned) return c.json({ error: 'this session belongs to a workspace; remove it there instead' }, 409);
  try {
    if (s.kind === 'background') await run('claude', ['stop', s.shortId], { timeoutMs: 30_000 });
    else if (s.pid) process.kill(s.pid, 'SIGTERM');
    else return c.json({ error: 'no process id for this session' }, 409);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
  await registry.refresh('claude');
  return c.json({ ok: true });
});

/** Remove a finished job from the tray. */
app.post('/api/jobs/:id/dismiss', (c) => {
  dismissJob(c.req.param('id'));
  return c.json({ ok: true });
});

// Unknown API routes are errors, not the app shell.
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// --- UI ----------------------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  // Built files have content hashes in their names, so they never change: cache them for good. The HTML shells
  // are revalidated every load, so a deploy is picked up at once.
  app.use('/*', async (c, next) => {
    await next();
    if (c.res.status !== 200 || c.res.headers.has('Cache-Control')) return;
    c.res.headers.set('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('/*', serveStatic({ root: './dist' }));
  // A build file that isn't there (an old tab after a deploy) is a 404, not the app shell cached as that file.
  app.get('/assets/*', (c) => c.text('not found', 404));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    config.publicHost
      ? `work-hub on http://${config.host}:${info.port}, served at ${publicOrigin} via the TLS front`
      : `work-hub on ${publicOrigin} (localhost only, no sign-in)`,
  );
});
injectWebSocket(server);
// The jobs tray survives restarts; handoffs carry on from where they were (session-tools registers that), other running jobs come back failed.
useJobsStore(sqliteJobsStore());
// Plugin onStart hooks, once the server is listening and the core's resume tasks have started.
// All at once, each with the plugin timeout; a failure or timeout is logged and the others carry on.
await runStartHooks(plugins.startHooks);

export { CORE_ROUTES };
