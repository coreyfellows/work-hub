import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.WORK_HUB_DB = join(mkdtempSync(join(tmpdir(), 'setup-')), 'hub.db');
const { registerSettingsGroup, removeSettingsGroup } = await import('./settings.ts');
const { setAppSetting } = await import('./store/appSettings.ts');
const { pendingQuestions } = await import('./setupRoute.ts');

const jira = { key: 'jira', label: 'Jira base URL', type: 'string' as const, firstRun: true, env: 'WH_TEST_JIRA', restart: true };

test('first-run questions: only firstRun settings without a value, shared env asked once', () => {
  registerSettingsGroup({ id: 'qa', title: 'A', order: 1, defs: [jira, { key: 'other', label: 'O', type: 'string' }] });
  registerSettingsGroup({ id: 'qb', title: 'B', order: 2, defs: [jira] });
  try {
    const q = pendingQuestions();
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].keys, ['qa.jira', 'qb.jira']);
    assert.deepEqual(q[0].from, ['A', 'B']);
    // Once one of them has a value it is no longer asked for that key.
    setAppSetting('qa.jira', 'https://x.atlassian.net');
    assert.deepEqual(pendingQuestions().map((x) => x.keys), [['qb.jira']]);
    setAppSetting('qb.jira', 'https://x.atlassian.net');
    assert.equal(pendingQuestions().length, 0);
  } finally {
    removeSettingsGroup('qa');
    removeSettingsGroup('qb');
  }
});

const { pendingOffers, registerSetupRoutes } = await import('./setupRoute.ts');
const { Hono } = await import('hono');

const offerPlugin = (id: string, status: string, offer?: unknown) =>
  ({ dir: `/p/${id}`, official: true, status, manifest: { id, apiVersion: 1, title: id, defaultEnabled: false, ...(offer ? { firstRunOffer: offer } : {}) } }) as never;

test('first-run offers: plugins that are off and declare firstRunOffer', () => {
  const offer = { label: 'Hosts', description: 'd', ask: { key: 'seed', label: 'Characters', placeholder: 'x' } };
  const m = offerPlugin('m', 'disabled', offer);
  (m as { manifest: { settings?: unknown[] } }).manifest.settings = [{ key: 'seed', label: 'S', type: 'string' }];
  const offers = pendingOffers([m, offerPlugin('on', 'active', offer), offerPlugin('plain', 'disabled'), offerPlugin('bad', 'skipped', offer)]);
  assert.deepEqual(offers, [{ id: 'm', label: 'Hosts', description: 'd', ask: { key: 'm.seed', label: 'Characters', placeholder: 'x' } }]);
});

test('POST /api/setup enables offered plugins and stores their answer; refuses unknown ones', async () => {
  const enabled: string[][] = [];
  const app = new Hono();
  registerSetupRoutes(app, { offers: () => [{ id: 'm', label: 'Hosts', ask: { key: 'm.seed', label: 'Characters' } }], enable: (ids) => void enabled.push(ids) });
  // Folders: answered already, so only the offer is in play.
  const { REPOS_KEY, WORKTREES_KEY, foldersGroup } = await import('./lib/folders.ts');
  registerSettingsGroup(foldersGroup());
  setAppSetting(REPOS_KEY, tmpdir());
  setAppSetting(WORKTREES_KEY, tmpdir());
  const post = (body: unknown) => app.request('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const bad = await post({ enable: ['nope'] });
  assert.equal(bad.status, 400);
  const ok = await post({ enable: ['m'], offerValues: { 'm.seed': ' Ron Burgundy, a moth ' } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { restart?: boolean; rebuild?: boolean };
  assert.equal(body.rebuild, true);
  assert.deepEqual(enabled, [['m']]);
  const { appSetting } = await import('./store/appSettings.ts');
  assert.equal(appSetting('m.seed'), 'Ron Burgundy, a moth');
});

test('an offer alone never opens the first-run page for an existing user (review I1)', async () => {
  const { setupStatus, WIZARD_DONE_KEY } = await import('./setupRoute.ts');
  const { REPOS_KEY, WORKTREES_KEY, foldersGroup } = await import('./lib/folders.ts');
  registerSettingsGroup(foldersGroup());
  setAppSetting(REPOS_KEY, tmpdir());
  setAppSetting(WORKTREES_KEY, tmpdir());
  setAppSetting(WIZARD_DONE_KEY, false);
  const s = await setupStatus({ offers: () => [{ id: 'm', label: 'Hosts' }], enable: () => {} });
  assert.equal(s.offers.length, 1);
  assert.equal(s.needed, false);
});

test('first-run offers: a plugin the user turned off on purpose is not offered (review I1)', () => {
  const offer = { label: 'Hosts' };
  assert.deepEqual(pendingOffers([offerPlugin('m', 'disabled', offer)], new Set(['m'])), []);
});

test('first-run offers: ask is kept only when it names one of the plugin\'s string settings (review minor 4)', () => {
  const p = offerPlugin('m', 'disabled', { label: 'Hosts', ask: { key: 'seed', label: 'C' } });
  assert.equal(pendingOffers([p])[0].ask, undefined);
  (p as { manifest: { settings?: unknown[] } }).manifest.settings = [{ key: 'seed', label: 'S', type: 'string' }];
  assert.equal(pendingOffers([p])[0].ask?.key, 'm.seed');
});
