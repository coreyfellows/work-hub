import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hubEvents } from './lib/events.ts';
import { Registry, type Source } from './registry.ts';

const src = (id: string, local: boolean, calls: string[]): Source => ({
  id,
  title: id,
  intervalMs: 60_000,
  local,
  fetch: async () => {
    calls.push(id);
    return { n: calls.length };
  },
});

test('a local source added after start() loads at once; a non-local one waits for a viewer', async () => {
  const calls: string[] = [];
  const changed: string[] = [];
  const off = hubEvents.on('source-changed', (p) => void changed.push(p.id));
  const r = new Registry({ idleThresholdMs: 60_000, tickMs: 3_600_000 });
  r.add(src('early', true, calls));
  r.start();
  try {
    r.add(src('late-local', true, calls));
    r.add(src('late-remote', false, calls));
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(calls.sort(), ['early', 'late-local']);
    assert.deepEqual(r.get('late-local')?.data, { n: calls.indexOf('late-local') + 1 });
    assert.ok(changed.includes('late-local'), 'source-changed emitted');
    assert.equal(r.get('late-remote')?.data, null);
  } finally {
    r.stop();
    off();
  }
});

test('before start(), add() runs nothing', async () => {
  const calls: string[] = [];
  const r = new Registry({ idleThresholdMs: 60_000 });
  r.add(src('a', true, calls));
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(calls, []);
});

test('what plugins register between construction and start() applies to the first fetch; nothing changes before start()', async () => {
  // Models index.ts: registry built, then plugins register hide predicates, then start().
  const hide: Array<(name: string) => boolean> = [];
  const listed: string[][] = [];
  const sessions: Source = {
    id: 'claude',
    title: 'Sessions',
    intervalMs: 60_000,
    local: true,
    fetch: async () => {
      const names = ['main', 'wh-review:opus'].filter((n) => !hide.some((h) => h(n)));
      listed.push(names);
      return { names };
    },
  };
  const r = new Registry({ idleThresholdMs: 60_000, tickMs: 3_600_000 });
  r.add(sessions);
  const changes: string[] = [];
  r.on('change', (s: { id: string }) => void changes.push(s.id));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(changes.length, 0, 'no change (so no reconcile) before start()');
  hide.push((n) => n.startsWith('wh-review:')); // a plugin's ctx.sessions.hide
  r.start();
  try {
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(listed, [['main']]);
    assert.ok(changes.includes('claude'));
  } finally {
    r.stop();
  }
});

test('index.ts starts the registry only after the plugins are loaded', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const load = code.indexOf('await loadPlugins(');
  const start = code.indexOf('registry.start()');
  assert.ok(load > 0 && start > 0, 'both calls present');
  assert.ok(start > load, 'registry.start() comes after await loadPlugins(...)');
  assert.equal(code.indexOf('registry.start()', start + 1), -1, 'started once');
});
