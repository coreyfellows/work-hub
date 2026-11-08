import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeSettingsArgs } from '../../plugin-api/server.ts';
import { menagerieLaunchArgs } from './server.ts';

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]);

test('launch args: the bundled mod and the cast path, always', async () => {
  const args = await menagerieLaunchArgs('/p', '/s/cast.json', async () => null)();
  assert.deepEqual(args.slice(0, 2), ['--plugin-dir', join('/p', 'claude')]);
  assert.deepEqual(settingsOf(args), { env: { WORK_HUB_MENAGERIE_CAST: '/s/cast.json' } });
});

test('launch args: a user-scope menagerie is turned off for the session', async () => {
  const args = await menagerieLaunchArgs('/p', '/s/cast.json', async () => 'menagerie@menagerie-marketplace')();
  assert.deepEqual(settingsOf(args), {
    env: { WORK_HUB_MENAGERIE_CAST: '/s/cast.json' },
    enabledPlugins: { 'menagerie@menagerie-marketplace': false },
  });
});

test('launch args: merged with another plugin\'s inline settings, both survive', async () => {
  const ours = await menagerieLaunchArgs('/p', '/s/cast.json', async () => null)();
  const merged = mergeSettingsArgs([...ours, '--settings', JSON.stringify({ env: { OTHER: '1' }, hooks: {} })]);
  const s = settingsOf(merged);
  assert.equal(s.env.WORK_HUB_MENAGERIE_CAST, '/s/cast.json');
  assert.equal(s.env.OTHER, '1');
});
