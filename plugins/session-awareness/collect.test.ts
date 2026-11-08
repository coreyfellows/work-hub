import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, Workspace } from '../../plugin-api/server.ts';
import { createCollector, createGitLog, sessionWorktrees } from './collect.ts';

const now = 1_000_000_000_000;

const ws = (over: Partial<Workspace> = {}): Workspace =>
  ({
    id: 'ws',
    title: 'WS',
    origin: 'prompt',
    ticketKey: null,
    prompt: null,
    epicKey: null,
    epicTitle: null,
    epicCheckedAt: null,
    status: 'active',
    notes: null,
    createdAt: '',
    updatedAt: '',
    worktrees: [
      { id: 1, vcs: 'git', repo: 'org/hub', path: '/w/hub/a', branch: 'feat/a', baseBranch: 'main' },
      { id: 2, vcs: 'git', repo: 'org/hub', path: '/w/hub/b', branch: 'feat/b', baseBranch: 'main' },
    ],
    sessions: [
      { id: 1, claudeSessionId: 'uuid-a', shortId: 'aaaa1111', role: 'main', name: 'A', cwd: '/w/hub/a' },
      { id: 2, claudeSessionId: 'uuid-b', shortId: 'bbbb2222', role: 'main', name: 'B', cwd: '/w/hub/a' },
      { id: 3, claudeSessionId: 'uuid-done', shortId: 'dddd4444', role: 'review', name: 'Old', cwd: '/w/hub/a' },
      { id: 4, claudeSessionId: 'uuid-gone', shortId: 'gggg5555', role: 'main', name: 'Gone', cwd: null },
    ],
    views: [],
    links: [],
    events: [],
    ...over,
  }) as Workspace;

const live = (id: string, status: string, over: Partial<Session> = {}): Session =>
  ({ sessionId: id, shortId: id.slice(0, 8), name: id, cwd: '/w/hub/a', kind: 'background', status, rawStatus: null, promptState: null, waitingFor: null, needsInput: false, background: 0, unread: false, questionId: null, detail: null, intent: null, startedAt: now - 1000, lastActiveAt: null, pid: null, branch: 'feat/a', repo: 'org/hub', ...over }) as Session;

function deps(over: Partial<Parameters<typeof createCollector>[0]> = {}) {
  return {
    getWorkspace: (id: string) => (id === 'ws' ? ws() : null),
    listEvents: () => [{ at: new Date(now).toISOString(), type: 'claim', detail: 'thing', sessionId: 'uuid-a' }],
    liveSessions: () => [live('uuid-a', 'working'), live('uuid-b', 'idle', { cwd: '/w/hub/b/sub' }), live('uuid-done', 'done')],
    liveAt: () => now - 5000,
    boundWorktrees: (id: string) => (id === 'uuid-a' ? ['/w/hub/b', '/not/recorded'] : []),
    sessionEdits: async (id: string) => {
      if (id === 'uuid-b') throw new Error('transcript missing');
      return [{ path: '/w/hub/a/x.ts', tool: 'Edit', at: new Date(now).toISOString() }];
    },
    prs: () => [],
    gitLog: async (cwd: string) => (cwd === '/w/hub/a' ? [{ sha: 'abc', subject: 'one' }] : []),
    settings: () => ({ maxBlockChars: 600 }),
    now: () => now,
    ...over,
  };
}

test('collect joins recorded sessions to live ones, skips done/stopped and unknown, and survives a missing transcript', async () => {
  const d = await createCollector(deps()).collect('ws');
  assert.ok(d);
  assert.deepEqual(d.blocks.map((b) => b.sessionId).sort(), ['uuid-a', 'uuid-b']);
  const a = d.blocks.find((b) => b.sessionId === 'uuid-a')!;
  assert.equal(a.claim, 'thing');
  assert.deepEqual(a.worktree, { path: '/w/hub/a', branch: 'feat/a', base: 'main' }, 'the start folder comes first');
  assert.deepEqual(a.commits, [{ sha: 'abc', subject: 'one' }]);
  assert.deepEqual(a.files, [{ path: 'x.ts', alsoBy: [] }]);
  const b = d.blocks.find((b) => b.sessionId === 'uuid-b')!;
  assert.deepEqual(b.worktree, { path: '/w/hub/b', branch: 'feat/b', base: 'main' }, 'the recorded worktree containing the cwd');
  assert.deepEqual(b.files, [], 'a missing transcript means no files, not a failure');
  assert.equal(d.liveAt, now - 5000);
  assert.equal(d.builtAt, now);
});

test('sessionWorktrees: the start worktree first, then recorded bound ones that differ from it', () => {
  const wts = ws().worktrees;
  const out = sessionWorktrees(wts, '/w/hub/a/sub', ['/w/hub/b', '/w/hub/a', '/not/recorded']);
  assert.deepEqual(out.map((t) => t.path), ['/w/hub/a', '/w/hub/b']);
  assert.deepEqual(sessionWorktrees(wts, '/elsewhere', ['/w/hub/b']).map((t) => t.path), ['/w/hub/b'], 'no start worktree: bound ones only');
});

test('sessionWorktrees compares Windows spellings and trailing slashes through normPath', () => {
  const recorded = [{ id: 1, vcs: 'git', repo: 'org/hub', path: 'C:/w/hub/a/', branch: 'a', baseBranch: 'main' }, { id: 2, vcs: 'git', repo: 'org/hub', path: 'C:/w/hub/b', branch: 'b', baseBranch: 'main' }];
  const prev = process.env.WORK_HUB_PLATFORM;
  process.env.WORK_HUB_PLATFORM = 'win32';
  try {
    assert.deepEqual(sessionWorktrees(recorded, 'c:\\w\\hub\\a\\sub', ['c:\\w\\hub\\b']).map((t) => t.id), [1, 2]);
  } finally {
    if (prev === undefined) delete process.env.WORK_HUB_PLATFORM;
    else process.env.WORK_HUB_PLATFORM = prev;
  }
  assert.deepEqual(sessionWorktrees([{ ...recorded[0], path: '/w/hub/a/' }], '/w/hub/a/x', []).map((t) => t.id), [1], 'POSIX trailing slash');
});

test('collect returns null for a missing or done workspace', async () => {
  assert.equal(await createCollector(deps()).collect('nope'), null);
  assert.equal(await createCollector(deps({ getWorkspace: () => ws({ status: 'done' }) })).collect('ws'), null);
});

test('createGitLog caches by HEAD and returns [] when git fails', async () => {
  const calls: string[][] = [];
  let head = 'h1';
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes('rev-parse')) return `${head}\n`;
    if (args[0] === 'log') return 'abc1234\tAdd one\ndef5678\tAdd two\n';
    throw new Error('unexpected');
  };
  let clock = 0;
  const gitLog = createGitLog(run, async () => 'origin/main', () => clock);
  assert.deepEqual(await gitLog('/w/x', 'main'), [
    { sha: 'abc1234', subject: 'Add one' },
    { sha: 'def5678', subject: 'Add two' },
  ]);
  assert.deepEqual(await gitLog('/w/x', 'main'), [
    { sha: 'abc1234', subject: 'Add one' },
    { sha: 'def5678', subject: 'Add two' },
  ]);
  assert.equal(calls.filter((a) => a[0] === 'log').length, 1, 'the log ran once for an unchanged HEAD');
  assert.equal(calls.filter((a) => a.includes('rev-parse')).length, 1, 'a burst within 30 s runs rev-parse once');
  clock = 31_000;
  assert.equal((await gitLog('/w/x', 'main')).length, 2, 'unchanged HEAD after 30 s: rev-parse again, same commits');
  assert.equal(calls.filter((a) => a.includes('rev-parse')).length, 2);
  assert.equal(calls.filter((a) => a[0] === 'log').length, 1);
  await gitLog('/w/other', 'main');
  assert.equal(calls.filter((a) => a.includes('rev-parse')).length, 3, 'the memo is per folder');
  head = 'h2';
  clock = 70_000;
  await gitLog('/w/x', 'main');
  assert.equal(calls.filter((a) => a[0] === 'log').length, 3, 'a new HEAD runs the log again');
  assert.ok(calls.find((a) => a[0] === 'log')!.includes('origin/main..HEAD'), 'the range comes from baseRef');
  const failing = createGitLog(async () => { throw new Error('not a repo'); }, async () => null);
  assert.deepEqual(await failing('/w/none', null), []);
});

test('no live open sessions: the digest is empty and nothing else is read', async () => {
  const touched: string[] = [];
  const spy = (name: string, v: unknown) => (..._a: unknown[]) => (touched.push(name), v);
  const base = deps({
    listEvents: spy('listEvents', []) as never,
    boundWorktrees: spy('boundWorktrees', []) as never,
    sessionEdits: spy('sessionEdits', Promise.resolve([])) as never,
    gitLog: spy('gitLog', Promise.resolve([])) as never,
    prs: spy('prs', []) as never,
  });
  // every recorded session is done or unknown
  const d = await createCollector({ ...base, liveSessions: () => [live('uuid-a', 'done'), live('uuid-b', 'stopped')] }).collect('ws');
  assert.deepEqual(d?.blocks, []);
  assert.equal(d?.workspaceId, 'ws');
  // no recorded sessions at all: the live list isn't even asked for
  const none = await createCollector({ ...base, getWorkspace: () => ws({ sessions: [] }), liveSessions: spy('liveSessions', []) as never }).collect('ws');
  assert.deepEqual(none?.blocks, []);
  assert.deepEqual(touched, [], 'no events, transcripts, git or PRs');
});
