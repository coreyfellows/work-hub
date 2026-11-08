import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryEntry } from '../../plugin-api/web.ts';
import { planChat, type ChatStep, type PlanItem } from './chatPlan.ts';

let n = 0;
const entry = (kind: HistoryEntry['kind'], extra: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ i: n++, kind, at: null, ...extra }) as HistoryEntry;
const tool = (extra: Partial<HistoryEntry> = {}) => entry('tool', { tool: 'Bash', summary: '', result: 'ok', ...extra });

type Item = PlanItem & { id: string };
const edits: Item = { id: 'edits', match: (e) => !!(e.edit || e.edits?.length), run: { key: () => 'edits', render: () => null } };
const git: Item = { id: 'git', match: (e) => !!e.git?.length, run: { key: () => 'git', render: () => null } };
const shell: Item = { id: 'shell', match: (e) => !!e.shell };
const ITEMS = [edits, git, shell];

/** A compact picture of the plan: card ids with the entries they hold, step counts, default entries. */
const show = (steps: ChatStep<Item>[]) =>
  steps.map((s) =>
    s.kind === 'card' ? `${s.item.id}${s.run ? '*' : ''}[${s.entries.map((e) => e.i).join(',')}]` : s.kind === 'steps' ? `steps:${s.count}` : `${s.entry.kind}:${s.entry.i}`,
  );

const edit = (path = 'a.ts') => tool({ tool: 'Edit', edit: { path } as HistoryEntry['edit'] });
const gitOp = () => tool({ git: [{ kind: 'commit' }] as unknown as HistoryEntry['git'] });

test('file changes in a row are one run; tool steps in between fold and come after it', () => {
  n = 0;
  const es = [entry('user', { text: 'go' }), tool(), edit(), tool(), edit('b.ts'), entry('assistant', { text: 'done' })];
  assert.deepEqual(show(planChat(es, ITEMS)), ['user:0', 'steps:1', 'edits*[2,4]', 'steps:1', 'assistant:5']);
});

test('a git op ends an edit run and opens its own; one entry with edits and git feeds both, edits first', () => {
  n = 0;
  const both = tool({ edits: [{ path: 'x' }] as HistoryEntry['edits'], git: [{ kind: 'restore' }] as unknown as HistoryEntry['git'] });
  const es = [gitOp(), both, gitOp(), edit()];
  assert.deepEqual(show(planChat(es, ITEMS)), ['git*[1]', 'edits*[0]', 'git*[0,2]', 'edits*[3]']);
});

test('text, your messages, questions and cards without runs end a run', () => {
  n = 0;
  const q = tool({ tool: 'AskUserQuestion', questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] as HistoryEntry['questions'] });
  const es = [edit(), q, edit(), entry('user', { text: 'x', shell: { command: 'ls' } as HistoryEntry['shell'] }), edit()];
  assert.deepEqual(show(planChat(es, ITEMS)), ['edits*[1]', 'tool:0', 'edits*[2]', 'shell[3]', 'edits*[4]']);
});

test('the pending question is skipped but still ends a run; a null run key draws that entry alone', () => {
  n = 0;
  const q = tool({ tool: 'AskUserQuestion', result: undefined, questions: [] as HistoryEntry['questions'] });
  const solo: Item = { id: 'solo', match: (e) => e.tool === 'Solo', run: { key: () => null, render: () => null } };
  const es = [edit(), q, edit(), tool({ tool: 'Solo' }), tool({ tool: 'Solo' })];
  assert.deepEqual(show(planChat(es, [...ITEMS, solo], q.i)), ['edits*[1]', 'edits*[2]', 'solo[3]', 'solo[4]']);
});

test('runs of the same item only join on an equal key; nothing matched means the default rendering', () => {
  n = 0;
  const byPath: Item = { id: 'p', match: (e) => !!e.edit, run: { key: (e) => e.edit!.path, render: () => null } };
  const es = [edit('a'), edit('a'), edit('b'), tool(), tool()];
  assert.deepEqual(show(planChat(es, [byPath])), ['p*[0,1]', 'p*[2]', 'steps:2']);
  assert.deepEqual(show(planChat(es, [])), ['steps:5']);
});
