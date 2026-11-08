import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFragment, removeFragments } from './prompts.ts';
import { addLaunchArgs, extraLaunchArgs, launchArgv, mergeSettingsArgs, removeLaunchArgs, withAppRules } from './sessions.ts';

test('launchArgv: addDirs become --add-dir=<dir>, blanks dropped, before launch args', () => {
  // The `=` form: --add-dir is variadic, so a bare `--add-dir /a <prompt>` would take the prompt as a second folder.
  assert.deepEqual(launchArgv({ prompt: 'p', addDirs: ['/a', ' ', '/b c'] }, ['--x']), ['--bg', '--add-dir=/a', '--add-dir=/b c', '--x', 'p']);
  assert.deepEqual(launchArgv({ prompt: 'p', addDirs: [] }), ['--bg', 'p']);
  assert.deepEqual(launchArgv({ name: 'n', model: 'opus', prompt: 'p', addDirs: ['/d'] }), ['--bg', '--name', 'n', '--model', 'opus', '--add-dir=/d', 'p']);
});

test('launchArgv: --name and --model only when given, launch args before the prompt', () => {
  assert.deepEqual(launchArgv({ prompt: 'do it' }), ['--bg', 'do it']);
  assert.deepEqual(launchArgv({ name: '  ', model: '', prompt: 'p' }), ['--bg', 'p']);
  assert.deepEqual(launchArgv({ name: ' n ', prompt: 'p' }), ['--bg', '--name', 'n', 'p']);
  assert.deepEqual(launchArgv({ name: 'n', model: 'opus', prompt: 'p' }, ['--x', 'y']), ['--bg', '--name', 'n', '--model', 'opus', '--x', 'y', 'p']);
});

test('extraLaunchArgs: registration order, awaited, a throwing fn skipped, removable by owner', async () => {
  addLaunchArgs(() => ['--a'], 'p1');
  addLaunchArgs(async ({ purpose }) => [`--purpose=${purpose}`], 'p2');
  addLaunchArgs(() => {
    throw new Error('broken');
  }, 'p3');
  assert.deepEqual(await extraLaunchArgs({ cwd: '/tmp', purpose: 'manual' }), ['--a', '--purpose=manual']);
  removeLaunchArgs('p1');
  removeLaunchArgs('p2');
  removeLaunchArgs('p3');
  assert.deepEqual(await extraLaunchArgs({ cwd: '/tmp', purpose: 'manual' }), []);
});

test('withAppRules: appends app-rules fragments except for headless, unchanged when none', () => {
  assert.equal(withAppRules('do it', 'new-session'), 'do it');
  addFragment('app-rules', () => 'RULES', 'test-app-rules');
  assert.equal(withAppRules('do it', 'new-session'), 'do it\n\nRULES');
  for (const p of ['explorer', 'handoff', 'pr-session', 'review', 'manual']) assert.ok(withAppRules('x', p).endsWith('\n\nRULES'));
  assert.equal(withAppRules('do it', 'headless'), 'do it');
  removeFragments('test-app-rules');
  assert.equal(withAppRules('do it', 'manual'), 'do it');
});

// trustWorktree only ever runs against a temp config file and a temp worktrees root here, never ~/.claude.json.
test('trustWorktree: adds the entry under the worktrees root, keeps the rest, atomic, no-op when trusted', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, stat, readdir, realpath, symlink, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { trustWorktree } = await import('./sessions.ts');
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wh-trust-')));
  const root = join(base, 'worktrees');
  const wt = join(root, 'repo', 'TICKET-1');
  await mkdir(wt, { recursive: true });
  await mkdir(join(base, 'elsewhere'));
  const configFile = join(base, 'claude.json');
  await writeFile(configFile, JSON.stringify({ numStartups: 3, projects: { '/x': { allowedTools: ['a'] }, [wt]: { lastCost: 1 } } }));
  await chmod(configFile, 0o600);
  // isTrusted stubbed so the refusal cases never open the real hub.db.
  const opts = { configFile, worktreesRoot: root, isTrusted: () => false };

  assert.deepEqual(await trustWorktree(wt, opts), { path: wt, changed: true });
  const after = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(after.numStartups, 3);
  assert.deepEqual(after.projects['/x'], { allowedTools: ['a'] });
  assert.deepEqual(after.projects[wt], { lastCost: 1, hasTrustDialogAccepted: true });
  assert.equal((await stat(configFile)).mode & 0o777, 0o600);
  assert.ok((await readdir(base)).includes('claude.json.bak-trust-worktree'));
  assert.ok(!(await readdir(base)).some((f) => f.includes('.trust-')), 'no temp file left');

  // Already trusted: nothing written.
  const before = (await stat(configFile)).mtimeMs;
  assert.deepEqual(await trustWorktree(wt, opts), { path: wt, changed: false });
  assert.equal((await stat(configFile)).mtimeMs, before);

  // A symlink into the root is trusted by its real path; a new entry is created.
  const other = join(root, 'repo', 'review-2');
  await mkdir(other);
  await symlink(other, join(base, 'link'));
  assert.deepEqual(await trustWorktree(join(base, 'link'), opts), { path: other, changed: true });
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')).projects[other], { hasTrustDialogAccepted: true });

  await assert.rejects(trustWorktree(join(base, 'elsewhere'), opts), /outside the worktrees root/);
  await assert.rejects(trustWorktree(root, opts), /outside the worktrees root/);
  await assert.rejects(trustWorktree(join(root, 'missing'), opts), /not a directory/);
  await assert.rejects(trustWorktree(wt, { configFile: join(base, 'none.json'), worktreesRoot: root, isTrusted: () => false }), /not found/);
});

test('trustWorktree: also accepts the plain root and folders the user confirmed', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, realpath, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { trustWorktree } = await import('./sessions.ts');
  // Not under tmpdir: that is /private/var, a refused system folder. The checkout is inside the home folder.
  const base = await realpath(await mkdtemp(join(process.cwd(), '.wh-trust-plain-')));
  try {
    const plain = join(base, 'workspaces');
    const inPlain = join(plain, 'x');
    const elsewhere = join(base, 'elsewhere');
    await mkdir(inPlain, { recursive: true });
    await mkdir(elsewhere);
    const configFile = join(base, 'claude.json');
    await writeFile(configFile, JSON.stringify({ projects: {} }));
    const opts = { configFile, worktreesRoot: join(base, 'worktrees'), plainRoot: plain };

    assert.deepEqual(await trustWorktree(inPlain, { ...opts, isTrusted: () => false }), { path: inPlain, changed: true });
    assert.equal(JSON.parse(await readFile(configFile, 'utf8')).projects[inPlain].hasTrustDialogAccepted, true);
    await assert.rejects(trustWorktree(elsewhere, { ...opts, isTrusted: () => false }), /outside the worktrees root/);
    await assert.rejects(trustWorktree(plain, { ...opts, isTrusted: () => false }), /outside the worktrees root/);
    const asked: string[] = [];
    const confirmed = (p: string) => (asked.push(p), p === elsewhere);
    assert.deepEqual(await trustWorktree(elsewhere, { ...opts, isTrusted: confirmed }), { path: elsewhere, changed: true });
    assert.deepEqual(asked, [elsewhere]);

  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('trustWorktree: a plain root set to a system folder does not make its contents trustable', async () => {
  const { mkdtemp, writeFile, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { trustWorktree } = await import('./sessions.ts');
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wh-trust-sys-')));
  try {
    const configFile = join(base, 'claude.json');
    await writeFile(configFile, JSON.stringify({ projects: {} }));
    const opts = { configFile, worktreesRoot: join(base, 'w'), plainRoot: '/usr', isTrusted: () => true };
    await assert.rejects(trustWorktree('/usr/local', opts), /outside the worktrees root/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('trustWorktree: a plain root set to the home folder does not make all of home trustable', async () => {
  const { mkdtemp, mkdir, writeFile, realpath, rm } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { trustWorktree } = await import('./sessions.ts');
  // Inside the checkout, so inside the home folder.
  const base = await realpath(await mkdtemp(join(process.cwd(), '.wh-trust-home-')));
  try {
    const dir = join(base, 'anything');
    await mkdir(dir);
    const configFile = join(base, 'claude.json');
    await writeFile(configFile, JSON.stringify({ projects: {} }));
    const opts = { configFile, worktreesRoot: join(base, 'w'), isTrusted: () => false };
    await assert.rejects(trustWorktree(dir, { ...opts, plainRoot: homedir() }), /outside the worktrees root/);
    // The same folder under a proper plain root is accepted.
    assert.deepEqual(await trustWorktree(dir, { ...opts, plainRoot: base }), { path: dir, changed: true });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('mergeSettingsArgs: inline --settings folded into one (Claude keeps only the last), paths and other args untouched', () => {
  const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } });
  const allow = JSON.stringify({ permissions: { allow: ['Read', 'Bash(git log:*)'] } });
  const more = JSON.stringify({ permissions: { allow: ['Read', 'Bash(ls:*)'] }, model: 'x' });
  const out = mergeSettingsArgs(['--plugin-dir', '/p', '--settings', hooks, '--settings', '/some/file.json', '--settings', allow, '--settings', more]);
  assert.deepEqual(out.slice(0, 3), ['--plugin-dir', '/p', '--settings']);
  assert.deepEqual(JSON.parse(out[3]), {
    hooks: { PreToolUse: [{ matcher: 'Bash' }] },
    permissions: { allow: ['Read', 'Bash(git log:*)', 'Bash(ls:*)'] },
    model: 'x',
  });
  assert.deepEqual(out.slice(4), ['--settings', '/some/file.json']);
  assert.deepEqual(mergeSettingsArgs(['--a', 'b']), ['--a', 'b']);
});

test('extraLaunchArgs: two plugins\' --settings come out as one', async () => {
  addLaunchArgs(() => ['--settings', '{"permissions":{"allow":["A"]}}'], 'merge-a');
  addLaunchArgs(() => ['--settings', '{"permissions":{"allow":["B"]}}'], 'merge-b');
  try {
    const out = await extraLaunchArgs({ cwd: '/', purpose: 'manual' });
    assert.equal(out.filter((a) => a === '--settings').length, 1);
    assert.deepEqual(JSON.parse(out[out.indexOf('--settings') + 1]).permissions.allow, ['A', 'B']);
  } finally {
    removeLaunchArgs('merge-a');
    removeLaunchArgs('merge-b');
  }
});
