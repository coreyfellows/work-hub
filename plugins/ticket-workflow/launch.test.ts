import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pluginDirArgs } from './launch.ts';
import register from './server.ts';

test('launch args: --plugin-dir when not installed, nothing when installed at user scope', async () => {
  assert.deepEqual(await pluginDirArgs('/p/claude', async () => false)(), ['--plugin-dir', '/p/claude']);
  assert.deepEqual(await pluginDirArgs('/p/claude', async () => true)(), []);
});

test('register: adds the launch args and exposes the scripts dir', async () => {
  const launch: Array<() => Promise<string[]>> = [];
  const services = new Map<string, unknown>();
  const asked: Array<[string, unknown]> = [];
  const ctx = {
    pluginDir: '/hub/plugins/ticket-workflow',
    paths: { configDir: '/cfg' },
    claude: { pluginInstalled: async (name: string, opts: unknown) => (asked.push([name, opts]), false) },
    log: { warn: () => {} },
    sessions: { addLaunchArgs: (fn: () => Promise<string[]>) => void launch.push(fn) },
    services: { expose: (name: string, api: unknown) => void services.set(name, api) },
  };
  const before = process.env.WORK_HUB_TW_CONFIG;
  delete process.env.WORK_HUB_TW_CONFIG;
  try {
    register(ctx as unknown as Parameters<typeof register>[0]);
    assert.equal(process.env.WORK_HUB_TW_CONFIG, '/cfg/ticket-workflow.env');
  } finally {
    if (before === undefined) delete process.env.WORK_HUB_TW_CONFIG;
    else process.env.WORK_HUB_TW_CONFIG = before;
  }
  assert.equal(asked.length, 0, 'the installed check waits for the first session');
  assert.equal(launch.length, 1);
  assert.deepEqual(await launch[0](), ['--plugin-dir', '/hub/plugins/ticket-workflow/claude']);
  assert.deepEqual(asked, [['ticket-workflow', { scope: 'user', enabledOnly: true }]]);
  assert.deepEqual(services.get('ticket-workflow'), {
    scriptsDir: '/hub/plugins/ticket-workflow/claude/scripts',
    claudeDir: '/hub/plugins/ticket-workflow/claude',
  });
});
