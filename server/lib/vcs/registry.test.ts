/**
 * The source-control provider registry: detection order (git before jj unless jj is preferred, folder last), owners
 * taken back, and a plugin whose register() throws leaving no provider behind. Own file (own process): the registry is
 * module state.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { API_VERSION } from '../../../plugin-api/manifest.ts';
import type { ContextDeps, CoreHooks } from '../../plugins/context.ts';
import { loadPlugins } from '../../plugins/loader.ts';
import { folderProvider } from './folder.ts';
import { detectProvider, getProvider, listProviders, registerProvider, removeProviders } from './registry.ts';
import type { SourceControlProvider } from './types.ts';

function fake(id: string, root: string | null): SourceControlProvider {
  return {
    id,
    title: id,
    detect: async (p) => (root && (p === root || p.startsWith(`${root}/`)) ? root : null),
    identity: async () => ({ repo: null }),
    line: async () => ({ line: null, head: null }),
    sharedLines: new Set(),
    inspect: async () => ({ exists: true, dirty: false, unsaved: 0, removable: true, block: null }),
    removeWorkingCopy: async () => {},
    agentInstructions: () => [],
    prereq: async () => ({ ok: true, detail: '' }),
  };
}

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'wh-vcs-registry-'));
  registerProvider(folderProvider);
  registerProvider(fake('git', '/r'));
});

after(() => rmSync(root, { recursive: true, force: true }));

test('git wins over jj when both match, unless jj is preferred', async () => {
  registerProvider(fake('jj', '/r'), 'plug');
  try {
    assert.equal((await detectProvider('/r/x'))?.provider.id, 'git');
    assert.equal((await detectProvider('/r/x', { prefer: null }))?.provider.id, 'git');
    const jj = await detectProvider('/r/x', { prefer: 'jj' });
    assert.equal(jj?.provider.id, 'jj');
    assert.equal(jj?.root, '/r');
  } finally {
    removeProviders('plug');
  }
});

test('order: git, jj, hg, p4, then others in registration order, folder last whatever the registration order', async () => {
  registerProvider(fake('zzz', '/r'), 'plug');
  registerProvider(fake('p4', '/r'), 'plug');
  registerProvider(fake('hg', '/r'), 'plug');
  try {
    assert.equal((await detectProvider('/r/x'))?.provider.id, 'git');
    assert.deepEqual(
      listProviders().map((p) => p.id),
      ['git', 'hg', 'p4', 'zzz', 'folder'],
    );
  } finally {
    removeProviders('plug');
  }
});

test('folder matches when nothing else does, with the path itself as the root', async () => {
  const hit = await detectProvider('/elsewhere/dir');
  assert.equal(hit?.provider.id, 'folder');
  assert.equal(hit?.root, '/elsewhere/dir');
});

test('a preferred folder never beats a real match', async () => {
  assert.equal((await detectProvider('/r/x', { prefer: 'folder' }))?.provider.id, 'git');
});

test('removeProviders drops only that owner’s providers', async () => {
  registerProvider(fake('jj', '/r'), 'plug');
  registerProvider(fake('hg', '/h'), 'other');
  removeProviders('plug');
  assert.equal(getProvider('jj'), undefined);
  assert.equal(getProvider('hg')?.id, 'hg');
  assert.equal(getProvider('git')?.id, 'git');
  removeProviders('other');
  assert.equal(getProvider('hg'), undefined);
});

test('registering an id that already exists throws', () => {
  assert.throws(() => registerProvider(fake('git', '/x'), 'plug'), /source-control provider "git" is already registered/);
});

test('folder provider: no identity or line, always removable, removing touches nothing on disk', async () => {
  const dir = join(root, 'plain');
  mkdirSync(dir);
  writeFileSync(join(dir, 'f.txt'), 'x');
  assert.equal(await folderProvider.detect(dir), dir);
  assert.deepEqual(await folderProvider.identity(dir), { repo: null });
  assert.deepEqual(await folderProvider.line(dir), { line: null, head: null });
  assert.deepEqual(await folderProvider.inspect(dir), { exists: true, dirty: false, unsaved: 0, removable: true, block: null });
  assert.equal((await folderProvider.inspect(join(root, 'missing'))).exists, false);
  await folderProvider.removeWorkingCopy(dir, { force: true });
  assert.equal((await folderProvider.inspect(dir)).exists, true);
  assert.deepEqual(folderProvider.agentInstructions({ workspaceId: 'ws1', ticketKey: null, whCommand: '/bin/wh', worktreesDir: '/w' }), [
    "This workspace's folder is a plain directory (no version control): work in it directly; record another folder with `/bin/wh worktree add ws1 --path <dir> --vcs folder`.",
  ]);
});

test('a plugin whose register() throws after ctx.vcs.register leaves no provider behind; a good one stays', async () => {
  const officialDir = join(root, 'plugins');
  const plugin = (id: string, server: string) => {
    const dir = join(officialDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, title: id, defaultEnabled: true, apiVersion: API_VERSION, server: 'server.ts' }));
    writeFileSync(join(dir, 'server.ts'), server);
  };
  const provider = (id: string) =>
    `{ id: '${id}', title: '${id}', detect: async () => null, identity: async () => ({ repo: null }), line: async () => ({ line: null, head: null }), sharedLines: new Set(), inspect: async () => ({ exists: false, dirty: false, unsaved: 0, removable: true, block: null }), removeWorkingCopy: async () => {}, agentInstructions: () => [], prereq: async () => ({ ok: true, detail: '' }) }`;
  plugin('brokenvcs', `export default function register(ctx) { ctx.vcs.register(${provider('broken')}); throw new Error('boom'); }`);
  plugin('goodvcs', `export default function register(ctx) { ctx.vcs.register(${provider('good')}); if (ctx.vcs.get('good')?.id !== 'good') throw new Error('get'); if (!ctx.vcs.list().some((p) => p.id === 'git')) throw new Error('list'); }`);
  writeFileSync(join(root, 'plugins.json'), '{}');
  const hooks: CoreHooks = {
    addEnricher: () => {},
    addLaunchArgs: () => {},
    addReconcilePass: () => {},
    hideSession: () => {},
    registerUrgent: () => {},
    addFragment: () => {},
    addFileRoot: () => {},
    fileRoots: () => [],
    removeByPlugin: () => {},
  };
  const deps = {
    registry: { add: () => {}, refresh: async () => {}, on: () => {}, get: () => undefined },
    upgradeWebSocket: (() => {
      throw new Error('no ws');
    }) as unknown as ContextDeps['upgradeWebSocket'],
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
  };
  const error = console.error;
  console.error = () => {};
  try {
    const loaded = await loadPlugins(new Hono(), { ...deps, officialDir, pluginsFile: join(root, 'plugins.json'), timeoutMs: 1000 });
    const by = Object.fromEntries(loaded.resolution.plugins.map((p) => [p.manifest.id, p]));
    assert.equal(by.brokenvcs.status, 'skipped');
    assert.equal(by.goodvcs.status, 'active');
  } finally {
    console.error = error;
  }
  assert.equal(getProvider('broken'), undefined);
  assert.equal(getProvider('good')?.id, 'good');
  removeProviders('goodvcs');
});
