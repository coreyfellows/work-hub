import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeLast, menuCommands } from './paletteStore.ts';
import type { PaletteCommand } from '../../../plugin-api/web.ts';

const cmd = (id: string, label = id): PaletteCommand => ({ id, label, run: () => {} });

test('dedupeLast: the last command of an id wins, at the first one’s place', () => {
  const out = dedupeLast([cmd('a', 'a1'), cmd('b'), cmd('a', 'a2'), cmd('c')]);
  assert.deepEqual(out.map((c) => `${c.id}=${c.label}`), ['a=a2', 'b=b', 'c=c']);
});

test('menuCommands: skips separators, hidden, disabled and inert items; flattens submenus', () => {
  let ran = '';
  const out = menuCommands(
    [
      { label: 'Hand off', onSelect: () => (ran = 'handoff') },
      'separator',
      { label: 'Intent', hidden: true, onSelect: () => {} },
      { label: 'Closing…', disabled: true, onSelect: () => {} },
      { label: 'Nothing' },
      { label: 'Terminal', submenu: [{ label: 'repo-a', onSelect: () => (ran = 'a') }, 'separator'] },
    ],
    { prefix: 'session', group: 'Session', hint: 'my session' },
  );
  assert.deepEqual(out.map((c) => [c.id, c.label, c.group, c.hint]), [
    ['session:Hand off', 'Hand off', 'Session', 'my session'],
    ['session:Terminal/repo-a', 'Terminal › repo-a', 'Session', 'my session'],
  ]);
  void out[1]!.run({ path: '/', workspaceId: null, sessionId: null, sources: {} });
  assert.equal(ran, 'a');
});

test('menuCommands: leaves out items marked palette: false', () => {
  const out = menuCommands([{ label: 'New session', onSelect: () => {}, palette: false }, { label: 'Terminal', onSelect: () => {} }], { prefix: 'tabstrip-action', group: 'Workspace' });
  assert.deepEqual(out.map((c) => c.label), ['Terminal']);
});
