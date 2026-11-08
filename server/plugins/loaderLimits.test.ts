/**
 * The loader's limits: a register() or onStart that hangs is cut off at the plugin timeout, a plugin can't add a source id
 * that already exists, and can't put a route on a core path. Own file (own process) so its plugins don't mix with
 * loader.test.ts's in the shared registries.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { API_VERSION } from '../../plugin-api/manifest.ts';
import type { ContextDeps, CoreHooks } from './context.ts';
import { loadPlugins, runStartHooks, withTimeout, PluginTimeout, type LoadedPlugins } from './loader.ts';

let root: string;
let officialDir: string;
let app: Hono;
let loaded: LoadedPlugins;
const sources = new Set<string>(['workspaces']);
const removed: string[] = [];
const warnings: string[] = [];
const hooks: CoreHooks = {
  addEnricher: () => {},
  addLaunchArgs: () => {},
  addReconcilePass: () => {},
  hideSession: () => {},
  registerUrgent: () => {},
  addFragment: () => {},
  addFileRoot: () => {},
  fileRoots: () => [],
  removeByPlugin: (plugin) => void removed.push(plugin),
};

function plugin(id: string, server: string): void {
  const dir = join(officialDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, title: id, defaultEnabled: true, apiVersion: API_VERSION, server: 'server.ts' }));
  writeFileSync(join(dir, 'server.ts'), server);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wh-loader-limits-'));
  officialDir = join(root, 'plugins');
  plugin('hangs', `export default function register() { return new Promise(() => {}); }`);
  plugin('late', `export default async function register(ctx) { await new Promise((r) => setTimeout(r, 150)); ctx.transcript.addEnricher({ id: 'late' }); }`);
  plugin('dupsource', `export default function register(ctx) { ctx.registry.add({ id: 'workspaces', title: 'x', intervalMs: 1000, fetch: async () => null }); }`);
  plugin('newsource', `export default function register(ctx) { ctx.registry.add({ id: 'newsource', title: 'x', intervalMs: 1000, fetch: async () => null }); }`);
  plugin('shadow', `export default function register(ctx) { ctx.app.post('/api/sessions/:sid/send', (c) => c.text('mine')); }`);
  plugin('wildcard', `export default function register(ctx) { ctx.app.all('/api/sessions/*', (c) => c.text('mine')); }`);
  plugin('paramaction', `export default function register(ctx) { ctx.app.post('/api/sessions/:id/:action', (c) => c.text('mine')); }`);
  plugin('chained', `export default function register(ctx) { ctx.app.get('/api/plugins/chained/x', (c) => c.text('ok')).post('/api/sessions/:id/send', (c) => c.text('mine')); }`);
  plugin('pathless', `export default function register(ctx) { ctx.app.get('/api/sessions/:id/send', (c) => c.text('get')).post((c) => c.text('mine')); }`);
  plugin('based', `export default function register(ctx) { ctx.app.basePath('/api/sessions').post('/:id/send', (c) => c.text('mine')); }`);
  plugin('othermethod', `export default function register(ctx) { ctx.app.get('/api/sessions/:id/send', (c) => c.text('get')); }`);
  plugin('ownroute', `export default function register(ctx) { ctx.app.get('/api/plugins/ownroute/x', (c) => c.text('ok')); }`);
  plugin(
    'starts',
    `export default function register(ctx) {
       ctx.onStart(() => new Promise(() => {}));
       ctx.onStart(() => { throw new Error('nope'); });
       ctx.onStart(() => { globalThis.__startedOk = true; });
     }`,
  );
  // A local plugin (from plugins.json) that imports a core file: loaded, with a warning.
  const localDir = join(root, 'localp');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, 'plugin.json'), JSON.stringify({ id: 'localp', title: 'localp', defaultEnabled: true, apiVersion: API_VERSION, server: 'server.ts' }));
  writeFileSync(join(localDir, 'server.ts'), `import type { X } from '../server/config.ts';\nexport default function register() {}`);
  writeFileSync(join(root, 'plugins.json'), JSON.stringify({ local: [localDir] }));
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
  app = new Hono();
  const deps = {
    registry: { add: (s: { id: string }) => void sources.add(s.id), refresh: async () => {}, on: () => {}, get: (id: string) => (sources.has(id) ? ({ id } as never) : undefined) },
    upgradeWebSocket: (() => { throw new Error('no ws'); }) as unknown as ContextDeps['upgradeWebSocket'],
    store: {} as ContextDeps['store'],
    sessions: {} as ContextDeps['sessions'],
    jobs: {} as ContextDeps['jobs'],
    db: { raw: () => { throw new Error('no db'); } } as unknown as ContextDeps['db'],
    exec: {} as ContextDeps['exec'],
    headless: {} as ContextDeps['headless'],
    git: {} as ContextDeps['git'],
    paths: { stateDir: join(root, 'state'), configDir: join(root, 'config'), cacheDir: join(root, 'cache'), repoRoot: root },
    applyRevalidate: () => {},
    hooks,
    coreRoutes: ['GET /api/state', 'POST /api/sessions/:id/send'],
  };
  try {
    loaded = await loadPlugins(app, { ...deps, officialDir, pluginsFile: join(root, 'plugins.json'), timeoutMs: 100 });
  } finally {
    console.warn = warn;
  }
});

after(() => rmSync(root, { recursive: true, force: true }));

async function byId() {
  const body = (await (await app.request('/api/plugins')).json()) as { plugins: Array<{ manifest: { id: string }; status: string; reason?: string }> };
  return Object.fromEntries(body.plugins.map((p) => [p.manifest.id, p]));
}

test('a register() that never finishes is skipped at the timeout and rolled back; the rest still load', async () => {
  const by = await byId();
  assert.equal(by.hangs.status, 'skipped');
  assert.equal(by.hangs.reason, 'register() did not finish in 100ms');
  assert.ok(removed.includes('hangs'));
  assert.equal(by.ownroute.status, 'active');
});

test('a register() that finishes after its timeout has its late registrations taken back too', async () => {
  const by = await byId();
  assert.equal(by.late.status, 'skipped');
  const before = removed.filter((r) => r === 'late').length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(removed.filter((r) => r === 'late').length, before + 1);
});

test('a plugin source with an id that already exists is refused and the plugin skipped', async () => {
  const by = await byId();
  assert.equal(by.dupsource.status, 'skipped');
  assert.match(by.dupsource.reason ?? '', /source "workspaces" already exists/);
  assert.equal(by.newsource.status, 'active');
  assert.ok(sources.has('newsource'));
});

test('a plugin route on a core path is refused (parameter names do not matter); its own namespace is fine', async () => {
  const by = await byId();
  assert.equal(by.shadow.status, 'skipped');
  assert.match(by.shadow.reason ?? '', /route POST \/api\/sessions\/:sid\/send would shadow the core route POST \/api\/sessions\/:id\/send/);
  assert.equal((await app.request('/api/sessions/x/send', { method: 'POST' })).status, 404, 'the refused route was never added');
  assert.equal(await (await app.request('/api/plugins/ownroute/x')).text(), 'ok');
});

test('param and wildcard routes over a core path are refused, chained, path-less and basePath calls included', async () => {
  const by = await byId();
  for (const id of ['wildcard', 'paramaction', 'chained', 'pathless', 'based']) {
    assert.equal(by[id].status, 'skipped', id);
    assert.match(by[id].reason ?? '', /would shadow the core route POST \/api\/sessions\/:id\/send/, id);
  }
  assert.match(by.based.reason ?? '', /route POST \/api\/sessions\/:id\/send/);
  assert.equal((await app.request('/api/sessions/x/send', { method: 'POST' })).status, 404);
});

test('a plugin route with another method than the core route on the same path is allowed', async () => {
  const by = await byId();
  assert.equal(by.othermethod.status, 'active');
  assert.equal(await (await app.request('/api/sessions/x/send')).text(), 'get');
});

test('onStart hooks run together: a hanging one times out, a throwing one is logged, the rest run', async () => {
  const t0 = Date.now();
  await runStartHooks(loaded.startHooks);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((globalThis as { __startedOk?: boolean }).__startedOk, true);
});

test('withTimeout names what timed out in seconds', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 1000, 'register()'), (e) => e instanceof PluginTimeout && e.message === 'register() did not finish in 1s');
  assert.equal(await withTimeout(Promise.resolve(5), 1000, 'x'), 5);
});

test('a local plugin importing core files loads, with a warning naming the import', async () => {
  const by = await byId();
  assert.equal(by.localp.status, 'active');
  assert.ok(warnings.some((w) => w.includes('[plugin localp] imports outside plugin-api: server.ts:1') && w.includes('reaches into core')), warnings.join('\n'));
});
