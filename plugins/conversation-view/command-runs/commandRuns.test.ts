import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { HistoryEntry } from '../../../plugin-api/server.ts';
import { runStore } from './commandRuns.ts';
import { ranInEntries, shellEnricher, shellOutputs, SHELL_ID, type ShellState } from './shell.ts';

test('ranInEntries: a finished `!` run or a finished Bash call naming the script counts, a failed or unrelated one does not', () => {
  const cmd = '/s/scripts/legalhub-route-ids.sh --apply';
  const bash = (summary: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ i: 0, at: null, kind: 'tool', tool: 'Bash', summary, doneAt: '2026-11-05T19:00:00Z', ...extra });
  assert.equal(ranInEntries([bash('mkdir -p $D; sed -e s/a/legalhub-route-ids.sh/ …')], cmd), true);
  assert.equal(ranInEntries([bash('ls', { isError: false })], cmd), false);
  assert.equal(ranInEntries([bash('bash legalhub-route-ids.sh', { isError: true })], cmd), false);
  assert.equal(ranInEntries([bash('bash legalhub-route-ids.sh', { doneAt: null })], cmd), false);
  assert.equal(ranInEntries([{ i: 0, at: null, kind: 'user', shell: { command: cmd, output: 'ok' } }], cmd), true);
  assert.equal(ranInEntries([{ i: 0, at: null, kind: 'user', shell: { command: cmd } }], cmd), false);
  assert.equal(ranInEntries([bash('echo hi')], 'echo hi'), true);
  assert.equal(ranInEntries([bash('echo hi again')], 'echo hi'), true);
  assert.equal(ranInEntries([bash('ls')], 'echo hi'), false);
});

// The core's tables as migrations 4-6 leave them (only the columns this plugin reads).
function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE sessions (workspace_id TEXT NOT NULL, claude_session_id TEXT NOT NULL UNIQUE);
    CREATE TABLE command_runs (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT, command TEXT NOT NULL, status TEXT NOT NULL,
      queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), done_at TEXT, error TEXT,
      output TEXT, output_at TEXT, stderr INTEGER, via TEXT NOT NULL DEFAULT 'session', exit_code INTEGER, term_id TEXT
    );
    INSERT INTO sessions VALUES ('ws1', 'sid-1');
  `);
  return d;
}

test('the run store: queue once per command, finish logs command-ran, latest per command, output', () => {
  const d = db();
  const events: string[][] = [];
  const s = runStore({ db: () => d, logEvent: (ws, type, detail) => events.push([ws, type, detail ?? '']) });
  const a = s.enqueueRun('sid-1', 'echo hi');
  assert.equal(s.enqueueRun('sid-1', 'echo hi').id, a.id, 'already queued: the same row');
  assert.equal(a.workspaceId, 'ws1');
  assert.deepEqual(s.sessionsWithQueued(), ['sid-1']);
  s.finishRun(a.id, 'ran');
  assert.deepEqual(events, [['ws1', 'command-ran', 'echo hi']]);
  assert.equal(s.queuedRuns('sid-1').length, 0);
  assert.deepEqual(s.runsAwaitingOutput(60_000).map((r) => r.id), [a.id]);
  s.recordOutput(a.id, 'one\ntwo', false, '2026-11-04T10:00:00.000Z');
  assert.deepEqual(s.latestRuns('sid-1').map((r) => [r.command, r.status, r.outputLines, r.outputAt]), [['echo hi', 'ran', 2, '2026-11-04T10:00:00.000Z']]);
  assert.equal(s.runOutput(a.id)?.output, 'one\ntwo');
  const b = s.enqueueRun('sid-2', 'ls');
  assert.equal(b.workspaceId, null);
  assert.equal(s.cancelRun('sid-2', 'ls'), true);
  assert.equal(s.cancelRun('sid-2', 'ls'), false);
  assert.equal(events.length, 1, 'only ran runs in a workspace are logged');
});

/** Feed transcript records through the enricher the way the core does. */
function read(records: unknown[]): { entries: HistoryEntry[]; state: ShellState } {
  const entries: HistoryEntry[] = [];
  const state = shellEnricher.init!('s');
  for (const rec of records) {
    const at = (rec as { timestamp?: string }).timestamp ?? null;
    shellEnricher.onRecord!(rec, { entries, push: (e) => entries.push({ ...e, i: entries.length }), state, at });
  }
  return { entries, state };
}

test('the shell enricher: <bash-input> then its output make one entry; long output kept whole in state', async () => {
  const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const { entries, state } = read([
    { type: 'user', timestamp: '2026-11-04T10:00:00.000Z', message: { content: '<bash-input>echo hi</bash-input>' } },
    { type: 'user', timestamp: '2026-11-04T10:00:01.000Z', message: { content: '<bash-stdout>\x1b[32mhi\x1b[0m</bash-stdout><bash-stderr></bash-stderr>' } },
    { type: 'user', isSidechain: true, message: { content: '<bash-input>ignored</bash-input>' } },
    { type: 'user', timestamp: '2026-11-04T10:01:00.000Z', message: { content: [{ type: 'text', text: '<bash-input>seq</bash-input>' }] } },
    { type: 'user', timestamp: '2026-11-04T10:01:01.000Z', message: { content: `<bash-stdout>${long}</bash-stdout><bash-stderr>oops</bash-stderr>` } },
  ]);
  assert.deepEqual(entries[0], { i: 0, at: '2026-11-04T10:00:00.000Z', kind: 'user', text: '! echo hi', shell: { command: 'echo hi', output: 'hi', stderr: false } });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].shell?.stderr, true);
  assert.equal(entries[1].shell?.output?.length, 6001, 'entries carry 6000 chars + …');
  assert.equal(state.full.get(1), `${long}\noops`);

  const outputs = shellOutputs(async () => ({ entries, state: <S>(id: string) => (id === SHELL_ID ? (state as S) : undefined) }));
  assert.deepEqual(await outputs.at('s', 0), { command: 'echo hi', output: 'hi', stderr: false, at: '2026-11-04T10:00:00.000Z' });
  assert.equal((await outputs.at('s', 1))?.output, `${long}\noops`);
  assert.equal(await outputs.at('s', 5), null);
  assert.deepEqual(await outputs.since('s', 'echo hi', Date.parse('2026-11-04T09:59:00.000Z')), { output: 'hi', stderr: false, at: '2026-11-04T10:00:00.000Z' });
  assert.equal(await outputs.since('s', 'echo hi', Date.parse('2026-11-04T10:00:30.000Z')), null, 'older than `since`');
});
