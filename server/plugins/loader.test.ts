import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { API_VERSION } from '../../plugin-api/manifest.ts';
import { createServerContext, pluginRegistries, removePluginRegistrations, type ContextDeps, type CoreHooks } from './context.ts';
import { loadPlugins, type LoadedPlugins } from './loader.ts';

let root: string;
let officialDir: string;
let app: Hono;
let loaded: LoadedPlugins;
const started: string[] = [];

/** What plugins put in the core registries, by plugin id, as a fake `CoreHooks` records it. */
const hookCalls: Array<{ hook: string; plugin: string; arg: unknown }> = [];
const removed: string[] = [];
const fakeHooks: CoreHooks = {
  addEnricher: (e, plugin) => void hookCalls.push({ hook: 'enricher', plugin, arg: e.id }),
  addLaunchArgs: (_fn, plugin) => void hookCalls.push({ hook: 'launchArgs', plugin, arg: null }),
  addReconcilePass: (_fn, plugin) => void hookCalls.push({ hook: 'reconcile', plugin, arg: null }),
  hideSession: (_p, plugin) => void hookCalls.push({ hook: 'hide', plugin, arg: null }),
  registerUrgent: (sourceId, listKey, fields, plugin) => void hookCalls.push({ hook: 'urgent', plugin, arg: { sourceId, listKey, fields } }),
  addFragment: (kind, _fn, plugin) => void hookCalls.push({ hook: 'fragment', plugin, arg: kind }),
  addFileRoot: (dir, plugin) => void hookCalls.push({ hook: 'fileRoot', plugin, arg: dir }),
  fileRoots: () => [],
  removeByPlugin: (plugin) => void removed.push(plugin),
};

function plugin(id: string, manifest: Record<string, unknown>, server?: string): void {
  const dir = join(officialDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, title: id, defaultEnabled: true, ...manifest }));
  if (server !== undefined) writeFileSync(join(dir, 'server.ts'), server);
}

/** Light stand-ins for the core collaborators: nothing here touches SQLite, `claude` or the network. */
function deps(over: Partial<ContextDeps> = {}): Omit<ContextDeps, 'app'> {
  // `settings` here feed contexts built directly; the loader reads them from plugins.json instead.
  const sources: string[] = [];
  return {
    registry: { add: (s) => (sources.push(s.id), undefined), refresh: async () => {}, on: () => {}, get: () => undefined },
    upgradeWebSocket: (() => {
      throw new Error('no websockets in tests');
    }) as unknown as ContextDeps['upgradeWebSocket'],
    store: {} as ContextDeps['store'],
    sessions: {} as ContextDeps['sessions'],
    jobs: { start: () => { throw new Error('no jobs'); }, registerResumer: () => {} } as unknown as ContextDeps['jobs'],
    db: { raw: () => { throw new Error('no db'); } } as unknown as ContextDeps['db'],
    exec: {} as ContextDeps['exec'],
    headless: {} as ContextDeps['headless'],
    git: {} as ContextDeps['git'],
    paths: { stateDir: join(root, 'state'), configDir: join(root, 'config'), cacheDir: join(root, 'cache'), repoRoot: root },
    settings: { fake: { greeting: 'hi', count: 3 } },
    applyRevalidate: () => {},
    hooks: fakeHooks,
    ...over,
  };
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wh-loader-'));
  officialDir = join(root, 'plugins');
  plugin(
    'fake',
    { apiVersion: API_VERSION, server: 'server.ts' },
    `export default function register(ctx) {
       ctx.app.get('/api/plugins/fake/ping', (c) => c.json({ pong: ctx.config.get('greeting', 'none'), dir: ctx.pluginDir }));
       ctx.services.expose('fake', { hello: () => 'hello' });
       ctx.onStart(async () => { globalThis.__fakeStarted = true; });
     }`,
  );
  plugin('broken', { apiVersion: API_VERSION, server: 'server.ts' }, `export default function register() { throw new Error('boom'); }`);
  plugin('core', { apiVersion: API_VERSION, server: 'server.ts' }, `export default function register() { globalThis.__coreLoaded = true; }`);
  plugin(
    'half',
    { apiVersion: API_VERSION, server: 'server.ts' },
    `export default function register(ctx) {
       ctx.services.expose('half', {});
       ctx.transcript.addEnricher({ id: 'half' });
       ctx.guard.addPublicPaths(['/half-public']);
       ctx.auth.setProvider({ isAuthed: () => true });
       throw new Error('half-way');
     }`,
  );
  plugin('future', { apiVersion: 2, server: 'server.ts' }, `export default function register() { throw new Error('must not load'); }`);

  plugin(
    'lister',
    { apiVersion: API_VERSION, server: 'server.ts', aliases: ['old-lister'] },
    `export default function register(ctx) { globalThis.__listerPlugins = ctx.plugins; }`,
  );
  mkdirSync(join(root, 'local', 'loc'), { recursive: true });
  writeFileSync(join(root, 'local', 'loc', 'plugin.json'), JSON.stringify({ id: 'loc', apiVersion: API_VERSION, title: 'Loc' }));

  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'plugins.json'),
    JSON.stringify({ local: [join(root, 'local')], enabled: { x: false }, settings: { fake: { greeting: 'hi', count: 3 } } }),
  );
  app = new Hono();
  app.get('/api/status', (c) => c.json({ ok: true }));
  loaded = await loadPlugins(app, { ...deps(), officialDir, pluginsFile: join(root, 'config', 'plugins.json') });
});

after(() => rmSync(root, { recursive: true, force: true }));

test('GET /api/plugins lists every plugin with its status and reason', async () => {
  const res = await app.request('/api/plugins');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { apiVersion: number; plugins: Array<{ manifest: { id: string }; status: string; reason?: string; dir: string }>; errors: string[] };
  assert.equal(body.apiVersion, API_VERSION);
  assert.deepEqual(body.errors, []);
  const by = Object.fromEntries(body.plugins.map((p) => [p.manifest.id, p]));
  assert.equal(by.fake.status, 'active');
  assert.equal(by.fake.dir, join(officialDir, 'fake'));
  assert.equal(by.broken.status, 'skipped');
  assert.equal(by.broken.reason, 'failed to load: boom');
  assert.equal(by.future.status, 'skipped');
  assert.match(by.future.reason ?? '', /needs plugin API v1 \(declares v2\)/);
});

test('ctx.plugins: list has built-ins, official and local plugins with aliases; config reads plugins.json', () => {
  const p = (globalThis as { __listerPlugins?: import('../../plugin-api/server.ts').ServerPluginContext['plugins'] }).__listerPlugins!;
  const list = p.list();
  const by = Object.fromEntries(list.map((e) => [e.id, e]));
  assert.equal(by.health?.kind, 'builtin');
  assert.deepEqual(by.lister, { id: 'lister', aliases: ['old-lister'], title: 'lister', dir: join(officialDir, 'lister'), kind: 'official', status: 'active' });
  assert.equal(by.loc.kind, 'local');
  assert.equal(by.loc.status, 'disabled');
  assert.equal(by.broken.status, 'skipped'); // read at call time: the loader's later verdicts show
  // Fresh objects: changing them changes nothing.
  by.lister.status = 'skipped';
  assert.equal(p.list().find((e) => e.id === 'lister')?.status, 'active');
  assert.deepEqual(p.config(), { local: [join(root, 'local')], enabled: { x: false } });
  assert.equal(p.configFile, join(root, 'config', 'plugins.json'));
});

test('a loaded plugin serves its routes and reads its settings', async () => {
  const res = await app.request('/api/plugins/fake/ping');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pong: 'hi', dir: join(officialDir, 'fake') });
});

test('a plugin that throws does not stop the app', async () => {
  const res = await app.request('/api/status');
  assert.equal(res.status, 200);
});

test('onStart hooks are returned, not run, by the loader', async () => {
  const g = globalThis as { __fakeStarted?: boolean };
  assert.equal(g.__fakeStarted, undefined);
  assert.equal(loaded.startHooks.length, 1);
  await loaded.startHooks[0]();
  assert.equal(g.__fakeStarted, true);
});

test('services: get returns what another plugin exposed, and names a missing one', () => {
  const ctx = createServerContext('other', { id: 'other', apiVersion: API_VERSION, title: 'other', defaultEnabled: true }, root, { ...deps(), app });
  assert.equal(ctx.services.get<{ hello(): string }>('fake').hello(), 'hello');
  assert.throws(() => ctx.services.get('nope'), /service "nope".*not loaded/);
});

test('paths.ticketWorkflowScripts: the ticket-workflow service while it is exposed, else the core setting', () => {
  const mk = (pid: string, tw?: string) =>
    createServerContext(pid, { id: pid, apiVersion: API_VERSION, title: pid, defaultEnabled: true }, root, {
      ...deps(),
      app,
      paths: { ...deps().paths, ...(tw === undefined ? {} : { ticketWorkflowScripts: tw }) },
    });
  const reader = mk('tw-reader', '/from/env');
  const bare = mk('tw-bare');
  assert.equal(reader.paths.ticketWorkflowScripts, '/from/env');
  assert.equal(bare.paths.ticketWorkflowScripts, '');
  // Exposed after the readers' contexts were made: they see it on their next read.
  mk('ticket-workflow').services.expose('ticket-workflow', { scriptsDir: '/bundled/scripts' });
  assert.equal(reader.paths.ticketWorkflowScripts, '/bundled/scripts');
  assert.equal(bare.paths.ticketWorkflowScripts, '/bundled/scripts');
  removePluginRegistrations('ticket-workflow', deps().hooks);
  assert.equal(reader.paths.ticketWorkflowScripts, '/from/env');
});

test('config.get: env first, then settings, then the default; coerced to the default type', () => {
  const ctx = createServerContext('fake', { id: 'fake', apiVersion: API_VERSION, title: 'fake', defaultEnabled: true }, root, { ...deps(), app });
  assert.equal(ctx.config.get('greeting'), 'hi');
  assert.equal(ctx.config.get('missing', 'dflt'), 'dflt');
  assert.equal(ctx.config.get('count', 0), 3);
  process.env.WORK_HUB_FAKE_INTERVAL_MS = '250';
  process.env.WORK_HUB_FAKE_ENABLED = 'false';
  process.env.WORK_HUB_FAKE_GREETING = 'from env';
  try {
    assert.equal(ctx.config.get('intervalMs', 1000), 250);
    assert.equal(ctx.config.get('enabled', true), false);
    assert.equal(ctx.config.get('greeting', 'x'), 'from env');
  } finally {
    delete process.env.WORK_HUB_FAKE_INTERVAL_MS;
    delete process.env.WORK_HUB_FAKE_ENABLED;
    delete process.env.WORK_HUB_FAKE_GREETING;
  }
});

test('registrations go to the core hooks, tagged with the plugin id', () => {
  const applied: string[][] = [];
  const ctx = createServerContext('reg', { id: 'reg', apiVersion: API_VERSION, title: 'reg', defaultEnabled: true }, root, {
    ...deps({ applyRevalidate: (p) => applied.push(p) }),
    app,
  });
  const n = hookCalls.length;
  ctx.revalidate(['/api/plugins/reg/x']);
  ctx.urgent('reg', 'items', ['status']);
  ctx.sessions.hide(() => false);
  ctx.sessions.addLaunchArgs(() => ['--x']);
  ctx.transcript.addEnricher({ id: 'reg' });
  ctx.reconcile.addPass(async () => false);
  ctx.prompts.addFragment('workspace-rules', () => 'x');
  ctx.guard.addPublicPaths(['/reg-public']);
  assert.deepEqual(applied, [['/api/plugins/reg/x']]);
  assert.deepEqual(hookCalls.slice(n), [
    { hook: 'urgent', plugin: 'reg', arg: { sourceId: 'reg', listKey: 'items', fields: ['status'] } },
    { hook: 'hide', plugin: 'reg', arg: null },
    { hook: 'launchArgs', plugin: 'reg', arg: null },
    { hook: 'enricher', plugin: 'reg', arg: 'reg' },
    { hook: 'reconcile', plugin: 'reg', arg: null },
    { hook: 'fragment', plugin: 'reg', arg: 'workspace-rules' },
  ]);
  assert.ok(pluginRegistries.publicPaths.some((p) => p.plugin === 'reg' && p.path === '/reg-public'));
  assert.throws(() => ctx.db.migrate(['CREATE TABLE t(i)']), /no db/); // ctx.db.migrate goes through the db dep (migratePlugin is tested in store/)
});

test('a plugin that throws half-way through register() has its registrations taken back', () => {
  assert.ok(removed.includes('half'), 'core hooks cleared for it');
  assert.ok(!removed.includes('fake'));
  assert.equal(pluginRegistries.publicPaths.some((p) => p.plugin === 'half'), false);
  assert.equal(pluginRegistries.authProvider, null);
  const ctx = createServerContext('other2', { id: 'other2', apiVersion: API_VERSION, title: 'other2', defaultEnabled: true }, root, { ...deps(), app });
  assert.throws(() => ctx.services.get('half'), /not loaded/);
});

test('a plugin with the reserved id "core" is skipped, never loaded', async () => {
  const body = (await (await app.request('/api/plugins')).json()) as { plugins: Array<{ manifest: { id: string }; status: string; reason?: string }> };
  const core = body.plugins.find((p) => p.manifest.id === 'core');
  assert.equal(core?.status, 'skipped');
  assert.match(core?.reason ?? '', /reserved/);
  assert.equal((globalThis as { __coreLoaded?: boolean }).__coreLoaded, undefined);
  assert.ok(!removed.includes('core'), "the core's registrations are left alone");
});

test('ctx.sessions.find: by id or short id from the cached list; one refresh on a miss', async () => {
  let list = [{ sessionId: 'uuid-1', shortId: 'aaaa1111' }];
  let refreshes = 0;
  const registry: ContextDeps['registry'] = {
    add: () => undefined,
    on: () => {},
    get: () => ({ data: { sessions: list } }) as unknown as ReturnType<ContextDeps['registry']['get']>,
    refresh: async () => {
      refreshes++;
      list = [...list, { sessionId: 'uuid-2', shortId: 'bbbb2222' }];
    },
  };
  const ctx = createServerContext('finder', { id: 'finder', apiVersion: API_VERSION, title: 'finder', defaultEnabled: true }, root, { ...deps({ registry }), app });
  assert.equal((await ctx.sessions.find('uuid-1'))?.shortId, 'aaaa1111');
  assert.equal((await ctx.sessions.find('aaaa1111'))?.sessionId, 'uuid-1');
  assert.equal(refreshes, 0);
  assert.equal((await ctx.sessions.find('bbbb2222'))?.sessionId, 'uuid-2', 'found after one refresh');
  assert.equal(refreshes, 1);
  assert.equal(await ctx.sessions.find('nope'), undefined);
  assert.equal(refreshes, 2);
});

test('ctx.isAcceptedOrigin: the injected check, else only publicOrigin', () => {
  const m = (id: string) => ({ id, apiVersion: API_VERSION, title: id, defaultEnabled: true });
  const plain = createServerContext('o1', m('o1'), root, { ...deps({ publicOrigin: 'https://hub.test' }), app });
  assert.equal(plain.isAcceptedOrigin('https://hub.test'), true);
  assert.equal(plain.isAcceptedOrigin('https://evil.test'), false);
  assert.equal(plain.isAcceptedOrigin(undefined), false);
  const injected = createServerContext('o2', m('o2'), root, { ...deps({ isAcceptedOrigin: (o) => o === 'http://localhost:1' }), app });
  assert.equal(injected.isAcceptedOrigin('http://localhost:1'), true);
  assert.equal(injected.isAcceptedOrigin('https://hub.test'), false);
});

test('paths.whBin is the plain path; paths.whCommand the prompt command line (given, else the quoted path)', () => {
  const m = { id: 'wh1', apiVersion: API_VERSION, title: 'wh1', defaultEnabled: true };
  const given = createServerContext('wh1', m, root, {
    ...deps(),
    app,
    paths: { ...deps().paths, whBin: '/my repo/bin/wh', whCommand: "WORK_HUB_STATE_DIR=/x '/my repo/bin/wh'" },
  });
  assert.equal(given.paths.whBin, '/my repo/bin/wh');
  assert.equal(given.paths.whCommand, "WORK_HUB_STATE_DIR=/x '/my repo/bin/wh'");
  const bare = createServerContext('wh2', { ...m, id: 'wh2' }, root, { ...deps(), app, paths: { ...deps().paths, whBin: '/my repo/bin/wh' } });
  assert.equal(bare.paths.whCommand, "'/my repo/bin/wh'");
});

test('ctx.sessions.boundWorktrees is the store lookup the host injects', () => {
  const m = { id: 'bw', apiVersion: API_VERSION, title: 'bw', defaultEnabled: true };
  const sessions = { boundWorktrees: (id: string) => (id === 'uuid-1' ? ['/w/repo/a'] : []) } as unknown as ContextDeps['sessions'];
  const ctx = createServerContext('bw', m, root, { ...deps({ sessions }), app });
  assert.deepEqual(ctx.sessions.boundWorktrees('uuid-1'), ['/w/repo/a']);
  assert.deepEqual(ctx.sessions.boundWorktrees('nope'), []);
});
