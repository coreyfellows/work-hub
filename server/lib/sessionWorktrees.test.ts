import assert from 'node:assert/strict';
import test from 'node:test';
import { openSessionsIn } from './worktreeCleanup.ts';
import { chunkWorktrees, commandWorktrees, fileWorktree } from './sessionWorktrees.ts';

const root = '/Users/me/worktrees';
const home = '/Users/me';

test('commandWorktrees: creating or moving into a worktree counts, merely naming it does not', () => {
  const wt = '/Users/me/worktrees/work-hub/perm';
  assert.deepEqual(commandWorktrees(`git worktree add ${wt} -b perm main`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`git worktree add -b perm ${wt} main`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`git worktree add ~/worktrees/work-hub/perm -b perm`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`cd $HOME/worktrees/work-hub/perm && pnpm test`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`cd "${wt}/web" && ls`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`git -C ${wt} status`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`wh worktree add work-hub --path ${wt} --base main`, root, home), [wt]);
  assert.deepEqual(commandWorktrees(`grep -rn foo ${wt}/web`, root, home), []);
  assert.deepEqual(commandWorktrees(`cat ${wt}/a.ts`, root, home), []);
  assert.deepEqual(commandWorktrees('cd /tmp && ls', root, home), []);
});

test('fileWorktree: a file inside a worktree, not the root or a repo folder', () => {
  assert.equal(fileWorktree('/Users/me/worktrees/r/x/web/a.ts', root), '/Users/me/worktrees/r/x');
  assert.equal(fileWorktree('/Users/me/worktrees/r/x', root), null);
  assert.equal(fileWorktree('/Users/me/repos/r/a.ts', root), null);
});

test('chunkWorktrees: Bash and edit tool uses, ignoring reads and junk lines', () => {
  const use = (name: string, input: object) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });
  const chunk = [
    use('Bash', { command: 'git worktree add /Users/me/worktrees/r/a -b a' }),
    use('Edit', { file_path: '/Users/me/worktrees/r/b/src/x.ts' }),
    use('Read', { file_path: '/Users/me/worktrees/r/c/src/x.ts' }),
    'not json "tool_use"',
    JSON.stringify({ message: { content: 'text' } }),
  ].join('\n');
  assert.deepEqual(chunkWorktrees(chunk, root, home).sort(), ['/Users/me/worktrees/r/a', '/Users/me/worktrees/r/b']);
});

test('openSessionsIn: a session bound to a worktree keeps it from being orphaned, wherever its cwd is', () => {
  const live = [
    { sessionId: 'a', name: 'A', cwd: '/w/other', status: 'idle' },
    { sessionId: 'b', name: 'B', cwd: '/w/other', status: 'done' },
  ];
  assert.deepEqual(openSessionsIn('/w/x', live), []);
  assert.deepEqual(openSessionsIn('/w/x', live, new Set(), new Set(['a', 'b'])).map((s) => s.sessionId), ['a']);
  assert.deepEqual(openSessionsIn('/w/x', live, new Set(['a']), new Set(['a'])), []);
});

test('a worktree shared by several sessions is released only when the last one closes', () => {
  const live = [
    { sessionId: 'a', name: 'A', cwd: '/w/start', status: 'idle' },
    { sessionId: 'b', name: 'B', cwd: '/w/x/sub', status: 'working' }, // inside it by cwd
    { sessionId: 'c', name: 'C', cwd: '/w/else', status: 'idle' }, // bound to it
  ];
  const bound = new Set(['a', 'c']);
  const holders = (closed: string[]) => openSessionsIn('/w/x', live, new Set(closed), bound).map((s) => s.sessionId);
  assert.deepEqual(holders(['a']), ['b', 'c']); // closing a: still held
  assert.deepEqual(holders(['a', 'b']), ['c']);
  assert.deepEqual(holders(['a', 'b', 'c']), []); // last one out: orphaned, removable
  // A session that finished on its own no longer holds it.
  assert.deepEqual(openSessionsIn('/w/x', live.map((s) => (s.sessionId === 'c' ? { ...s, status: 'stopped' } : s)), new Set(['a', 'b']), bound), []);
});
