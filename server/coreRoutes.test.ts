import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CORE_ROUTES, routeConflicts, routeShape } from './coreRoutes.ts';

const here = import.meta.dirname;
const files = ['index.ts', 'plugins/loader.ts', 'plugins/configRoute.ts', 'settingsRoute.ts', 'applyRoute.ts', 'setupRoute.ts', 'worktreeRoutes.ts'];

test('CORE_ROUTES lists exactly the /api routes the core registers, with their methods', () => {
  const found = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(here, f), 'utf8');
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete|all)\(\s*'(\/api\/[^']*)'/g)) {
      if (m[2] !== '/api/*') found.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  assert.deepEqual([...found].sort(), [...CORE_ROUTES].sort());
});

test('no core route lives under /api/plugins/<x>/, so the plugin namespace stays free', () => {
  for (const r of CORE_ROUTES) assert.doesNotMatch(r, /\/api\/plugins\/[^/]+\//, r);
});

test('route shapes ignore parameter names and a trailing slash', () => {
  assert.equal(routeShape('/api/sessions/:sid/send/'), '/api/sessions/:/send');
});

test('routeConflicts: exact paths and parameter names', () => {
  assert.equal(routeConflicts('POST', '/api/sessions/:x/send'), 'POST /api/sessions/:id/send');
  assert.equal(routeConflicts('GET', '/api/state'), 'GET /api/state');
  assert.equal(routeConflicts('get', '/api/state/'), 'GET /api/state');
  assert.equal(routeConflicts('GET', '/api/sessions/:id/history'), undefined);
  assert.equal(routeConflicts('POST', '/api/sessions/:id/run'), undefined);
});

test('routeConflicts: a plugin :param matches any core segment, literal or param', () => {
  assert.equal(routeConflicts('POST', '/api/sessions/:id/:action'), 'POST /api/sessions/:id/seen');
  assert.equal(routeConflicts('GET', '/api/:what'), 'GET /api/plugins');
  assert.equal(routeConflicts('POST', '/api/workspaces/:id/:x/:sid/close'), 'POST /api/workspaces/:id/sessions/:sid/close');
  // A literal where the core has a param still takes that value away from the core.
  assert.equal(routeConflicts('POST', '/api/sessions/abc/send'), 'POST /api/sessions/:id/send');
  // Segment counts must agree.
  assert.equal(routeConflicts('POST', '/api/sessions/:id/:action/:more'), undefined);
  // An optional param may be absent.
  assert.equal(routeConflicts('POST', '/api/sessions/:id?'), 'POST /api/sessions');
});

test('routeConflicts: * matches any number of core segments', () => {
  assert.equal(routeConflicts('ALL', '/api/sessions/*'), 'POST /api/sessions');
  assert.equal(routeConflicts('POST', '/api/sessions/*/send'), 'POST /api/sessions/:id/send');
  assert.equal(routeConflicts('GET', '/api/*'), 'GET /api/plugins');
  assert.equal(routeConflicts('GET', '*'), 'GET /api/plugins');
  assert.equal(routeConflicts('GET', '/api/prs/*'), undefined);
});

test('routeConflicts: methods must agree unless one side is ALL', () => {
  assert.equal(routeConflicts('GET', '/api/sessions/:id/send'), undefined);
  assert.equal(routeConflicts('DELETE', '/api/sessions/*'), undefined);
  assert.equal(routeConflicts('all', '/api/sessions/:id/send'), 'POST /api/sessions/:id/send');
  assert.equal(routeConflicts('GET', '/api/x', ['/api/x']), '/api/x', 'a bare core path stands for every method');
});

test('routeConflicts: /api/plugins/<id>/... is always allowed', () => {
  assert.equal(routeConflicts('GET', '/api/plugins/github/x'), undefined);
  assert.equal(routeConflicts('ALL', '/api/plugins/github/*'), undefined);
  assert.equal(routeConflicts('POST', '/api/plugins/config/:x'), undefined);
  assert.equal(routeConflicts('ALL', '/api/plugins/github/:a/:b'), undefined);
  // ...but a param in the id slot covers the core's own /api/plugins/config.
  assert.equal(routeConflicts('GET', '/api/plugins/:id'), 'GET /api/plugins/config');
});
