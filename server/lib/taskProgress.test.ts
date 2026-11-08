import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentProgress, shellProgress, taskProgress } from './taskProgress.ts';

const dir = mkdtempSync(join(tmpdir(), 'wh-taskprogress-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('shellProgress: the last few non-empty lines, ANSI stripped, a cut first line dropped', () => {
  assert.deepEqual(shellProgress('partial\na\n\x1b[32mb\x1b[0m\n\nc\nd\ne\n', true).lines, ['b', 'c', 'd', 'e']);
  assert.deepEqual(shellProgress('only\n', false).lines, ['only']);
});

test("agentProgress: tool calls counted, the latest call or text line, 'more' when the tail was cut", () => {
  const a = (content: unknown) => JSON.stringify({ type: 'assistant', message: { content } });
  const text = [a([{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }]), a([{ type: 'text', text: 'Looking at it\nmore' }]), a([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }])].join('\n');
  assert.deepEqual(agentProgress(text, false), { steps: 2, last: 'Bash: ls' });
  assert.deepEqual(agentProgress(`${text}\n${a([{ type: 'text', text: 'Done.' }])}`, true), { steps: 1, more: true, last: 'Done.' });
});

test('taskProgress reads only .output files and returns null for missing ones', async () => {
  const f = join(dir, 'b1.output');
  writeFileSync(f, 'step 1\nstep 2\n');
  const p = await taskProgress('shell', { outputFile: f });
  assert.equal(p?.bytes, 14);
  assert.deepEqual(p?.lines, ['step 1', 'step 2']);
  assert.equal(await taskProgress('shell', { outputFile: join(dir, 'secret.txt') }), null);
  assert.equal(await taskProgress('shell', { outputFile: join(dir, 'gone.output') }), null);
  assert.equal(await taskProgress('shell', undefined), null);
});
