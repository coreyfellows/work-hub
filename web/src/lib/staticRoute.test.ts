import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticPage } from './staticRoute.ts';

const items = [
  { id: 'param', path: '/workspaces/:id' },
  { id: 'regex', path: /^\/workspaces\/new$/ },
  { id: 'new', path: '/workspaces/new' },
  { id: 'settings', path: '/settings' },
];

test('a static page path wins over param routes, whatever its slot position', () => {
  assert.equal(staticPage(items, '/workspaces/new', [])?.id, 'new');
  assert.equal(staticPage(items, '/workspaces/new/', [])?.id, 'new');
});

test('param, RegExp and non-matching paths are left to the normal order', () => {
  assert.equal(staticPage(items, '/workspaces/abc', []), null);
  assert.equal(staticPage([items[0], items[1]], '/workspaces/new', []), null);
});

test("the core's own static paths can't be shadowed", () => {
  assert.equal(staticPage(items, '/settings', ['/', '/workspaces', '/settings', '/status']), null);
});

test("every static path App.tsx routes itself is in CORE_STATIC_PATHS (so plugins can't shadow it)", async () => {
  const { readFileSync } = await import('node:fs');
  const { CORE_STATIC_PATHS } = await import('./staticRoute.ts');
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const routed = [...app.matchAll(/(?<![.\w])path === '(\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(routed.length >= 4, `found the core routes (${routed.join(', ')})`);
  const missing = routed.filter((p) => !CORE_STATIC_PATHS.includes(p));
  assert.deepEqual(missing, [], 'add these to CORE_STATIC_PATHS in lib/staticRoute.ts');
});
