import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesInstalled, parsePluginList, pluginChecks, pluginInstalledChecker, PLUGIN_LIST_MAX_STALE_FAILURES, PLUGIN_LIST_MAX_STALE_MS, PLUGIN_LIST_TTL_MS } from './claudePlugins.ts';

const LIST = JSON.stringify([
  { id: 'menagerie@menagerie-marketplace', scope: 'user', enabled: true, readFromFolder: '/x/claude-menagerie' },
  { id: 'off@m', scope: 'user', enabled: false },
  { id: 'proj@m', scope: 'project', enabled: true, projectPath: '/p' },
  { id: 'noscope@m' },
  { scope: 'user' },
  'junk',
]);

test('parsePluginList reads ids, names, scope and enabled', () => {
  assert.deepEqual(parsePluginList(LIST), [
    { id: 'menagerie@menagerie-marketplace', name: 'menagerie', scope: 'user', enabled: true },
    { id: 'off@m', name: 'off', scope: 'user', enabled: false },
    { id: 'proj@m', name: 'proj', scope: 'project', enabled: true },
    { id: 'noscope@m', name: 'noscope', scope: '', enabled: false },
  ]);
  assert.throws(() => parsePluginList('{}'));
  assert.throws(() => parsePluginList('Installed plugins:\n  menagerie@x'));
});

test('matchesInstalled: exact name, scope (user by default) and enabledOnly', () => {
  const l = parsePluginList(LIST);
  assert.equal(matchesInstalled(l, 'menagerie'), true);
  assert.equal(matchesInstalled(l, 'claude-menagerie'), false);
  assert.equal(matchesInstalled(l, 'menag'), false);
  assert.equal(matchesInstalled(l, 'off'), false);
  assert.equal(matchesInstalled(l, 'off', { enabledOnly: false }), true);
  assert.equal(matchesInstalled(l, 'proj'), false);
  assert.equal(matchesInstalled(l, 'proj', { scope: 'project' }), true);
  assert.equal(matchesInstalled(l, 'proj', { scope: 'any' }), true);
  assert.equal(matchesInstalled(l, 'menagerie', { scope: 'project' }), false);
});

test('pluginInstalledChecker caches a success and shares one run', async () => {
  let runs = 0;
  const check = pluginInstalledChecker(async () => (runs++, LIST));
  assert.deepEqual(await Promise.all([check('menagerie'), check('proj')]), [true, false]);
  assert.equal(await check('menagerie'), true);
  assert.equal(runs, 1);
});

test('pluginInstalledChecker answers false on failure and retries next call', async () => {
  const outputs: Array<() => string> = [
    () => {
      throw new Error('claude: not found');
    },
    () => 'not json',
    () => LIST,
  ];
  let runs = 0;
  const check = pluginInstalledChecker(async () => outputs[runs++]());
  assert.equal(await check('menagerie'), false);
  assert.equal(await check('menagerie'), false);
  assert.equal(await check('menagerie'), true);
  assert.equal(await check('menagerie'), true);
  assert.equal(runs, 3);
});

test('pluginInstalledChecker: a cached listing expires after the TTL (10 minutes by default)', async () => {
  let t = 0;
  let list = '[]';
  let runs = 0;
  const check = pluginInstalledChecker(async () => (runs++, list), { now: () => t });
  assert.equal(await check('menagerie'), false);
  list = LIST; // installed meanwhile
  t = PLUGIN_LIST_TTL_MS - 1;
  assert.equal(await check('menagerie'), false, 'still cached');
  t = PLUGIN_LIST_TTL_MS;
  assert.equal(await check('menagerie'), true, 'listed again');
  assert.equal(runs, 2);
  assert.equal(PLUGIN_LIST_TTL_MS, 600_000);
});

test('pluginInstalledChecker: a failed refresh after the TTL keeps the last good listing and retries next call', async () => {
  let t = 0;
  let fail = false;
  let runs = 0;
  const check = pluginInstalledChecker(
    async () => {
      runs++;
      if (fail) throw new Error('claude: timed out');
      return LIST;
    },
    { now: () => t },
  );
  assert.equal(await check('menagerie'), true);
  t = PLUGIN_LIST_TTL_MS;
  fail = true;
  assert.equal(await check('menagerie'), true, 'last good listing');
  assert.equal(await check('menagerie'), true);
  assert.equal(runs, 3, 'each call after the TTL tries again');
  fail = false;
  assert.equal(await check('menagerie'), true);
  assert.equal(await check('menagerie'), true);
  assert.equal(runs, 4, 'cached again after a success');
});

function flaky() {
  const st = { t: 0, fail: false, runs: 0 };
  const check = pluginInstalledChecker(
    async () => {
      st.runs++;
      if (st.fail) throw new Error('claude: timed out');
      return LIST;
    },
    { now: () => st.t },
  );
  return { st, check };
}

test('pluginInstalledChecker: the last good listing answers through 3 failed refreshes in a row, then "not installed"', async () => {
  assert.equal(PLUGIN_LIST_MAX_STALE_FAILURES, 3);
  const { st, check } = flaky();
  assert.equal(await check('menagerie'), true);
  st.t = PLUGIN_LIST_TTL_MS;
  st.fail = true;
  for (let i = 1; i <= 3; i++) assert.equal(await check('menagerie'), true, `failure ${i}`);
  assert.equal(await check('menagerie'), false, 'the 4th failure drops it');
  assert.equal(await check('menagerie'), false, 'stays dropped while failing');
  assert.equal(st.runs, 6, 'every call keeps retrying');
  st.fail = false;
  assert.equal(await check('menagerie'), true, 'a success brings it back');
});

test('pluginInstalledChecker: a success resets the failure count', async () => {
  const { st, check } = flaky();
  await check('menagerie');
  st.t = PLUGIN_LIST_TTL_MS;
  st.fail = true;
  for (let i = 0; i < 3; i++) await check('menagerie');
  st.fail = false;
  assert.equal(await check('menagerie'), true);
  st.t += PLUGIN_LIST_TTL_MS;
  st.fail = true;
  for (let i = 1; i <= 3; i++) assert.equal(await check('menagerie'), true, `failure ${i} after the reset`);
  assert.equal(await check('menagerie'), false);
});

test('pluginInstalledChecker: the last good listing answers at most 1 hour past the TTL', async () => {
  assert.equal(PLUGIN_LIST_MAX_STALE_MS, 60 * 60_000);
  const { st, check } = flaky();
  await check('menagerie');
  st.fail = true;
  st.t = PLUGIN_LIST_TTL_MS + PLUGIN_LIST_MAX_STALE_MS - 1;
  assert.equal(await check('menagerie'), true, 'a millisecond inside the hour');
  st.t = PLUGIN_LIST_TTL_MS + PLUGIN_LIST_MAX_STALE_MS;
  assert.equal(await check('menagerie'), false, 'the hour is up (only the 2nd failure)');
  assert.equal(await check('menagerie'), false);
});

test('pluginChecks: id answers the installed id from the same cached listing', async () => {
  let runs = 0;
  const list = JSON.stringify([
    { id: 'menagerie@menagerie-marketplace', scope: 'user', enabled: true },
    { id: 'proj@m', scope: 'project', enabled: true },
  ]);
  const checks = pluginChecks(async () => (runs++, list));
  assert.equal(await checks.id('menagerie'), 'menagerie@menagerie-marketplace');
  assert.equal(await checks.id('proj'), null);
  assert.equal(await checks.id('proj', { scope: 'project' }), 'proj@m');
  assert.equal(await checks.installed('menagerie'), true);
  assert.equal(runs, 1);
  const failing = pluginChecks(async () => {
    throw new Error('no claude');
  });
  assert.equal(await failing.id('menagerie'), null);
});
