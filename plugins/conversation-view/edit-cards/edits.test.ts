import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryEntry } from '../../../plugin-api/server.ts';
import { editEnricher, recordEdit } from './edits.ts';

const AT = '2026-11-04T10:00:00.000Z';

/** One tool call through the enricher as the core runs it: onToolUse's fields onto the entry, then the result. */
function call(name: string, input: unknown, resultText?: string): HistoryEntry {
  const entry = { i: 0, at: AT, kind: 'tool' } as HistoryEntry;
  Object.assign(entry, editEnricher.onToolUse!(entry, { name, input, raw: {} }, undefined) ?? {});
  if (resultText !== undefined) editEnricher.onToolResult!(entry, { text: resultText, isError: false }, undefined);
  return entry;
}

test('a Write whose result says "File created" is marked created; an overwrite is not', () => {
  assert.deepEqual(call('Write', { file_path: '/tmp/x/a.txt', content: 'one\ntwo' }, 'File created successfully at: /tmp/x/a.txt').edit, {
    path: '/tmp/x/a.txt',
    tool: 'Write',
    at: AT,
    content: 'one\ntwo',
    lines: 2,
    created: true,
  });
  assert.equal(call('Write', { file_path: '/tmp/x/a.txt', content: 'x' }, 'The file /tmp/x/a.txt has been updated.').edit?.created, false);
});

test('Edit, MultiEdit and NotebookEdit become hunks; other tools and path-less input add nothing', () => {
  assert.deepEqual(call('Edit', { file_path: '/f', old_string: 'a', new_string: 'b' }).edit?.hunks, [{ old: 'a', new: 'b' }]);
  assert.deepEqual(
    call('MultiEdit', { file_path: '/f', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).edit?.hunks,
    [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }],
  );
  assert.deepEqual(call('NotebookEdit', { notebook_path: '/n.ipynb', new_source: 'x = 1' }).edit?.hunks, [{ old: '', new: 'x = 1' }]);
  assert.equal(call('Bash', { command: 'ls' }).edit, undefined);
  assert.equal(recordEdit('Edit', { old_string: 'a' }, AT), undefined);
});

test('long text is capped at 6000 chars per side', () => {
  const big = 'x'.repeat(7000);
  const e = recordEdit('Edit', { file_path: '/f', old_string: big, new_string: 'y' }, AT);
  assert.equal(e?.hunks?.[0].old.length, 6001); // 6000 + the ellipsis
  assert.equal(e?.hunks?.[0].new, 'y');
});
