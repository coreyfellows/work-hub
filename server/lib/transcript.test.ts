import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// transcript.ts reads ~/.claude/projects: point HOME at a scratch dir before it's imported.
const home = mkdtempSync(join(tmpdir(), 'wh-transcript-'));
process.env.HOME = home;
const project = join(home, '.claude', 'projects', '-tmp-x');
mkdirSync(project, { recursive: true });

type T = typeof import('./transcript.ts');
let t: T;
before(async () => {
  t = await import('./transcript.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const toolUse = (id: string, name: string, input: unknown, ts = '2026-11-04T10:00:00.000Z') =>
  line({ type: 'assistant', timestamp: ts, cwd: '/tmp/x', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, text: string, ts = '2026-11-04T10:00:01.000Z') =>
  line({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function transcript(sessionId: string, body: string): void {
  writeFileSync(join(project, `${sessionId}.jsonl`), body);
}

test("an enricher's onToolUse fields land on the tool entry", async () => {
  const seen: string[] = [];
  t.addEnricher<{ n: number }>({
    id: 'tag-tools',
    init: () => ({ n: 0 }),
    onToolUse(entry, tool, state) {
      if (!seen.includes(entry.id ?? '')) seen.push(entry.id ?? '');
      state.n++;
      return tool.name === 'Grep' ? { summary: `tagged ${(tool.input as { pattern: string }).pattern} #${state.n}` } : undefined;
    },
  }, 'tag-tools');
  transcript('s-tooluse', toolUse('t1', 'Grep', { pattern: 'foo' }) + toolUse('t2', 'Read', { file_path: '/a' }));
  const h = await t.readHistory('s-tooluse', {});
  assert.ok(h);
  assert.equal(h.entries[0].summary, 'tagged foo #1');
  assert.equal(h.entries[1].summary, '/a');
  assert.deepEqual(seen.slice(-2), ['t1', 't2']);
  t.removeEnrichers('tag-tools');
});

test('onRecord can consume a record and push its own entry', async () => {
  t.addEnricher(
    {
      id: 'notes',
      onRecord(rec, h) {
        const r = rec as { type?: string; note?: string };
        if (r.type !== 'note') return;
        h.push({ i: -1, at: h.at, kind: 'user', text: `note: ${r.note}` });
        return true;
      },
    },
    'notes-plugin',
  );
  transcript(
    's-record',
    line({ type: 'note', note: 'hi', timestamp: '2026-11-04T10:00:00.000Z' }) +
      line({ type: 'user', timestamp: '2026-11-04T10:00:02.000Z', message: { content: 'typed' } }),
  );
  const h = await t.readHistory('s-record', {});
  assert.ok(h);
  assert.deepEqual(
    h.entries.map((e) => [e.i, e.at, e.text]),
    [
      [0, '2026-11-04T10:00:00.000Z', 'note: hi'],
      [1, '2026-11-04T10:00:02.000Z', 'typed'],
    ],
  );
  t.removeEnrichers('notes-plugin');
  // Removed: a fresh session no longer gets it.
  transcript('s-record2', line({ type: 'note', note: 'x' }));
  assert.equal((await t.readHistory('s-record2', {}))?.entries.length, 0);
});

test('onToolResult sees the result; resolve runs once a result exists, and its changes show', async () => {
  const resolved: string[] = [];
  t.addEnricher<{ pending: Set<string> }>({
    id: 'late',
    init: () => ({ pending: new Set() }),
    onToolUse(entry, tool, state) {
      if (tool.name === 'Bash' && entry.id) state.pending.add(entry.id);
    },
    onToolResult(entry, result) {
      return { summary: `${entry.summary} → ${result.text.length} chars${result.isError ? ' (error)' : ''}` };
    },
    async resolve(_sid, entries, state) {
      let changed = false;
      for (const e of entries) {
        if (!e.id || !state.pending.has(e.id) || e.result === undefined) continue;
        state.pending.delete(e.id);
        resolved.push(e.id);
        e.text = `resolved ${e.id}`;
        changed = true;
      }
      return changed;
    },
  }, 'late');
  const sid = 's-resolve';
  transcript(sid, toolUse('b1', 'Bash', { command: 'ls' }));
  let h = await t.readHistory(sid, {});
  assert.equal(h?.entries[0].text, undefined);
  assert.deepEqual(resolved, []);
  appendFileSync(join(project, `${sid}.jsonl`), toolResult('b1', 'a\nb'));
  h = await t.readHistory(sid, {});
  assert.equal(h?.entries[0].result, 'a\nb');
  assert.equal(h?.entries[0].summary, 'ls → 3 chars');
  assert.equal(h?.entries[0].text, 'resolved b1');
  await t.readHistory(sid, {});
  assert.deepEqual(resolved, ['b1'], 'resolved once');
  t.removeEnrichers('late');
});

test('readHistory exposes the host from the host enricher state (null without one)', async () => {
  transcript('s-host', line({ type: 'system', content: '🦊 Fox has moved into your terminal.' }));
  assert.equal((await t.readHistory('s-host', {}))?.host, null);
  // Whatever enricher has HOST_ENRICHER_ID (the menagerie plugin's) supplies it.
  t.addEnricher<{ host: { name: string; at: number } | null }>(
    {
      id: t.HOST_ENRICHER_ID,
      init: () => ({ host: null }),
      onRecord(rec, h) {
        if ((rec as { type?: string }).type === 'system') h.state.host = { name: 'Fox', at: h.entries.length };
      },
    },
    'host-test',
  );
  try {
    assert.deepEqual((await t.readHistory('s-host', {}))?.host, { name: 'Fox', at: 0 });
  } finally {
    t.removeEnrichers('host-test');
  }
  assert.equal((await t.readHistory('s-host', {}))?.host, null);
});

test("sessionEdits collects the edit fields an enricher adds (the edit-cards feature's own cases: its edits.test.ts)", async () => {
  t.addEnricher(
    {
      id: 'edits-test',
      onToolUse: (entry, tool) => (tool.name === 'Write' ? { edit: { path: (tool.input as { file_path: string }).file_path, tool: 'Write', at: entry.at, content: 'c', lines: 1 } } : undefined),
      onToolResult: (entry, result) => {
        if (entry.edit) entry.edit.created = /^File created/.test(result.text);
      },
    },
    'edits-test',
  );
  try {
    const sid = 's-builtin';
    transcript(
      sid,
      line({ type: 'system', content: '🦊 Fox has moved into your terminal.' }) +
        toolUse('w1', 'Write', { file_path: '/tmp/x/a.txt', content: 'one\ntwo' }) +
        toolResult('w1', 'File created successfully at: /tmp/x/a.txt'),
    );
    const r = await t.readHistory(sid, {});
    assert.ok(r);
    assert.equal(r.host, null, 'the host enricher is the menagerie plugin\'s');
    assert.equal(r.entries[0].edit?.created, true, 'onToolResult can update what onToolUse added');
    assert.deepEqual((await t.sessionEdits(sid))?.map((e) => [e.path, e.content !== undefined]), [['/tmp/x/a.txt', true]]);
  } finally {
    t.removeEnrichers('edits-test');
  }
});

test("addEnricher's default owner is 'core', not the enricher id", async () => {
  t.addEnricher({ id: 'shell', onToolUse: () => ({ summary: 'core-owned' }) });
  t.removeEnrichers('shell'); // a plugin named like the enricher id must not take the core's away
  transcript('s-owner', toolUse('o1', 'Read', { file_path: '/b' }));
  assert.equal((await t.readHistory('s-owner', {}))?.entries[0].summary, 'core-owned');
  t.removeEnrichers('core');
  transcript('s-owner2', toolUse('o2', 'Read', { file_path: '/b' }));
  assert.equal((await t.readHistory('s-owner2', {}))?.entries[0].summary, '/b');
});

test('concurrent reads of new lines ingest them once (a question answered only on a duplicate stayed open)', async () => {
  const ask = { questions: [{ question: 'Q?', header: 'Q', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }] };
  transcript('s-race', toolUse('t0', 'Read', { file_path: '/a' }));
  await t.readHistory('s-race', {});
  appendFileSync(join(project, 's-race.jsonl'), toolUse('q1', 'AskUserQuestion', ask));
  // The claude source (openQuestion, lastActivity) and a history poll all read at once.
  await Promise.all([t.openQuestion('s-race'), t.readHistory('s-race', {}), t.openQuestion('s-race'), t.readHistory('s-race', { after: 0 })]);
  appendFileSync(join(project, 's-race.jsonl'), toolResult('q1', 'answered'));
  const h = await t.readHistory('s-race', {});
  assert.ok(h);
  assert.deepEqual(h.entries.map((e) => e.id), ['t0', 'q1']);
  assert.equal(h.entries[1].result, 'answered');
  assert.equal(await t.openQuestion('s-race'), null);
});

test('narration thinking blocks (shown in the terminal) become assistant entries; hidden reasoning stays out', async () => {
  // Signatures are base64 protobufs whose header names the block's kind (`narration` or `thinking`).
  const sig = (kind: string) => Buffer.concat([Buffer.from([8, 4, 18, 128, 21, 10, 17]), Buffer.from(`B${String.fromCharCode(kind.length)}${kind}`), Buffer.alloc(40, 7)]).toString('base64');
  transcript(
    's-narr',
    line({
      type: 'assistant',
      timestamp: '2026-11-06T10:00:00.000Z',
      message: {
        id: 'm1',
        content: [
          { type: 'thinking', thinking: '', signature: sig('thinking') },
          { type: 'thinking', thinking: 'Private reasoning.', signature: sig('thinking') },
          { type: 'thinking', thinking: "I've drafted the plan, marking my guesses.\n\n", signature: sig('narration') },
          { type: 'text', text: 'Reply.' },
        ],
      },
    }),
  );
  const h = await t.readHistory('s-narr', {});
  assert.ok(h);
  assert.deepEqual(
    h.entries.map((e) => [e.kind, e.text, e.narration]),
    [
      ['assistant', "I've drafted the plan, marking my guesses.", true],
      ['assistant', 'Reply.', undefined],
    ],
  );
});

test('slash commands show as typed; away summaries are notice entries; hooks and task notifications go to readNotices', async () => {
  const ts = '2026-11-06T11:00:00.000Z';
  const user = (content: unknown, extra = {}) => line({ type: 'user', timestamp: ts, message: { content }, ...extra });
  const attach = (attachment: unknown) => line({ type: 'attachment', timestamp: ts, attachment });
  const task = (status: string, summary: string, result = '') =>
    `<task-notification>\n<task-id>x</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n${result ? `<result>${result}</result>\n` : ''}</task-notification>`;
  transcript(
    's-notices',
    user('<command-name>/plugin</command-name>\n  <command-message>plugin</command-message>\n  <command-args>install foo@bar</command-args>') +
      user('<command-message>pr-tend</command-message> <command-name>/pr-tend</command-name>') +
      user('<local-command-stdout>done</local-command-stdout>') +
      user('Base directory for this skill: …', { isMeta: true }) +
      line({ type: 'system', subtype: 'away_summary', timestamp: ts, content: 'Goal: ship it. Next, run the tests. (disable recaps in /config)' }) +
      attach({ type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: 'lint failed', command: 'x' } }) +
      attach({ type: 'hook_non_blocking_error', hookName: 'PostToolUse:Edit', stderr: 'Failed with non-blocking status code: boom' }) +
      attach({ type: 'hook_system_message', hookName: 'SessionStart:startup', content: 'Indexing not ready' }) +
      attach({ type: 'hook_success', hookName: 'SessionStart:startup', content: '' }) +
      user(task('completed', 'Background command "build" completed (exit code 0)')) +
      attach({ type: 'queued_command', prompt: task('failed', 'Agent "Task 2" failed', 'API error') }) +
      user('<task-notification>\nmods loaded\n</task-notification>', { isMeta: true }) +
      user([{ type: 'text', text: '<task-notification>\nno summary here\n</task-notification>' }]),
  );
  const h = await t.readHistory('s-notices', {});
  assert.ok(h);
  assert.deepEqual(
    h.entries.map((e) => [e.kind, e.text, e.notice]),
    [
      ['user', '/plugin install foo@bar', undefined],
      ['user', '/pr-tend', undefined],
      ['notice', 'Goal: ship it. Next, run the tests.', 'away-summary'],
    ],
  );
  assert.equal(h.noticeCount, 5);
  // The old form of a local command's output (a user turn) lands on the command it belongs to.
  assert.deepEqual(h.entries.map((e) => e.localOutput), [undefined, 'done', undefined]);
  const n = await t.readNotices('s-notices');
  assert.ok(n);
  assert.deepEqual(
    n.notices.map((x) => [x.kind, x.level, x.title, x.text]),
    [
      ['hook', 'blocked', 'Stop', 'lint failed'],
      ['hook', 'error', 'PostToolUse:Edit', 'boom'],
      ['hook', 'info', 'SessionStart:startup', 'Indexing not ready'],
      ['task', 'info', 'Background command "build" completed (exit code 0)', undefined],
      ['task', 'error', 'Agent "Task 2" failed', 'API error'],
    ],
  );
});

test('a slash command Claude Code runs itself carries its output, so nothing waits for a reply', async () => {
  const ts = '2026-11-06T11:00:00.000Z';
  const user = (content: unknown) => line({ type: 'user', timestamp: ts, message: { content } });
  transcript(
    's-local',
    user('<command-name>/reload-plugins</command-name>\n  <command-message>reload-plugins</command-message>\n  <command-args></command-args>') +
      line({ type: 'system', subtype: 'local_command', timestamp: ts, content: '<local-command-stdout>Reloaded: 28 plugins\n6 errors</local-command-stdout>' }) +
      user('<command-name>/work-hub:scrutinize-pr</command-name>\n  <command-args>42</command-args>') +
      // Output with nothing it belongs to (no slash command just before) is ignored.
      line({ type: 'system', subtype: 'local_command', timestamp: ts, content: '<local-command-stdout>late</local-command-stdout>' }),
  );
  const h = await t.readHistory('s-local', {});
  assert.ok(h);
  assert.deepEqual(
    h.entries.map((e) => [e.text, e.localOutput]),
    [
      ['/reload-plugins', 'Reloaded: 28 plugins\n6 errors'],
      ['/work-hub:scrutinize-pr 42', 'late'],
    ],
  );
});

test('backgroundTasks maps a background task id to the description of the call that started it', async () => {
  transcript(
    's-bg',
    toolUse('t1', 'Bash', { command: 'sleep 20; ./wait.sh', description: 'Wait for CI checks', run_in_background: true }) +
      line({
        type: 'user',
        timestamp: '2026-11-04T10:00:01.000Z',
        toolUseResult: { backgroundTaskId: 'bu7' },
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bu7. Output is being written to: /tmp/x/tasks/bu7.output. You will be notified.' }] },
      }),
  );
  const d = await t.backgroundTasks('s-bg');
  assert.deepEqual(d?.get('bu7'), { description: 'Wait for CI checks', outputFile: '/tmp/x/tasks/bu7.output' });
});
