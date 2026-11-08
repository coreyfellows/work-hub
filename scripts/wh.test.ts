import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const WH = join(import.meta.dirname, 'wh.ts');
let tmp: string;
let env: NodeJS.ProcessEnv;
let ws: string;

function wh(...args: string[]) {
  const r = spawnSync('node', [WH, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function recorded(path: string) {
  const w = JSON.parse(wh('show', ws, '--json').out) as { worktrees: Array<{ path: string; repo: string | null; branch: string | null; vcs: string }> };
  return w.worktrees.find((t) => t.path === path);
}

before(() => {
  // Inside the checkout, not the system temp folder: /private/var is a system folder, never recordable as a plain folder.
  // GIT_CEILING_DIRECTORIES keeps git from finding the checkout itself above the test folders.
  tmp = realpathSync(mkdtempSync(join(import.meta.dirname, '..', '.wh-test-')));
  env = {
    ...process.env,
    WORK_HUB_STATE_DIR: join(tmp, 'state'),
    WORK_HUB_CONFIG_DIR: join(tmp, 'config'),
    WORK_HUB_CACHE_DIR: join(tmp, 'cache'),
    WORK_HUB_REPOS_DIR: join(tmp, 'roots', 'repos'),
    TW_WORKTREES_ROOT: join(tmp, 'roots', 'worktrees'),
    WORK_HUB_PLAIN_DIR: join(tmp, 'roots', 'plain'),
    GIT_CEILING_DIRECTORIES: tmp,
  };
  for (const r of ['repos', 'worktrees', 'plain']) mkdirSync(join(tmp, 'roots', r), { recursive: true });
  ws = wh('new', '--title', 'test').out;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('wh worktree add', () => {
  it('records a directory git does not know as vcs folder, repo null', () => {
    const dir = join(tmp, 'plain');
    mkdirSync(dir);
    const r = wh('worktree', 'add', ws, '--path', dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `recorded folder ${dir} in ${ws}`);
    const t = recorded(dir)!;
    assert.deepEqual([t.repo, t.branch, t.vcs], [null, null, 'folder']);
  });

  it('records --vcs and --branch for a non-git working copy', () => {
    const dir = join(tmp, 'jjcopy');
    mkdirSync(dir);
    const r = wh('worktree', 'add', ws, '--path', dir, '--vcs', 'jj', '--branch', 'feat');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `recorded jj@feat ${dir} in ${ws}`);
    const t = recorded(dir)!;
    assert.equal(t.vcs, 'jj');
    assert.equal(t.branch, 'feat');
    assert.equal(t.repo, null);
  });

  it('keeps --repo for a non-git working copy', () => {
    const dir = join(tmp, 'p4copy');
    mkdirSync(dir);
    assert.equal(wh('worktree', 'add', ws, '--path', dir, '--vcs', 'p4', '--repo', 'depot/main').code, 0);
    assert.equal(recorded(dir)!.repo, 'depot/main');
  });

  it('missing path without --vcs dies with the old message and records nothing', () => {
    const dir = join(tmp, 'nope');
    const r = wh('worktree', 'add', ws, '--path', dir);
    assert.equal(r.code, 1);
    assert.equal(r.err, `wh: couldn't detect the repo for ${dir}; pass --repo owner/name`);
    assert.equal(recorded(dir), undefined);
  });

  it('missing path with an explicit non-git --vcs dies', () => {
    const dir = join(tmp, 'nope2');
    const r = wh('worktree', 'add', ws, '--path', dir, '--vcs', 'jj');
    assert.equal(r.code, 1);
    assert.match(r.err, /doesn't exist/);
    assert.equal(recorded(dir), undefined);
  });

  it('--vcs folder prints the same as the auto-detected folder', () => {
    const dir = join(tmp, 'explicit');
    mkdirSync(dir);
    const r = wh('worktree', 'add', ws, '--path', dir, '--vcs', 'folder');
    assert.equal(r.out, `recorded folder ${dir} in ${ws}`);
    assert.equal(recorded(dir)!.vcs, 'folder');
  });

  it('rejects a malformed --vcs', () => {
    const r = wh('worktree', 'add', ws, '--path', tmp, '--vcs', 'Bad_Id');
    assert.equal(r.code, 1);
    assert.match(r.err, /--vcs must be a lowercase id/);
  });

  it('git directory: detection and output unchanged', () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', 'topic', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/acme/widgets.git']);
    const r = wh('worktree', 'add', ws, '--path', dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `recorded acme/widgets@topic ${dir} in ${ws}`);
    const t = recorded(dir)!;
    assert.deepEqual([t.repo, t.branch, t.vcs], ['acme/widgets', 'topic', 'git']);
  });

  it('git directory without origin is recorded as local/<folder>', () => {
    const dir = join(tmp, 'localrepo');
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    const r = wh('worktree', 'add', ws, '--path', dir);
    assert.equal(r.out, `recorded local/localrepo@main ${dir} in ${ws}`);
    assert.equal(recorded(dir)!.vcs, 'git');
  });

  it('re-recording a provider copy without --vcs keeps its vcs and repo', () => {
    const dir = join(tmp, 'hgcopy');
    mkdirSync(dir);
    assert.equal(wh('worktree', 'add', ws, '--path', dir, '--vcs', 'hg', '--repo', 'acme/hgrepo', '--branch', 'feat').code, 0);
    const r = wh('worktree', 'add', ws, '--path', dir, '--base', 'default');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `recorded acme/hgrepo@feat ${dir} in ${ws}`);
    const t = recorded(dir)!;
    assert.deepEqual([t.vcs, t.repo, t.branch], ['hg', 'acme/hgrepo', 'feat']);
  });

  it('a recorded folder that became a git repo is re-recorded as git', () => {
    const dir = join(tmp, 'grew-git');
    mkdirSync(dir);
    assert.equal(wh('worktree', 'add', ws, '--path', dir).out, `recorded folder ${dir} in ${ws}`);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    assert.equal(wh('worktree', 'add', ws, '--path', dir).out, `recorded local/grew-git@main ${dir} in ${ws}`);
    assert.equal(recorded(dir)!.vcs, 'git');
  });

  for (const root of ['repos', 'worktrees', 'plain']) {
    it(`refuses the ${root} root as a folder (no --vcs: the old message)`, () => {
      const dir = join(tmp, 'roots', root);
      const r = wh('worktree', 'add', ws, '--path', dir);
      assert.equal(r.code, 1);
      assert.equal(r.err, `wh: couldn't detect the repo for ${dir}; pass --repo owner/name`);
      const f = wh('worktree', 'add', ws, '--path', dir, '--vcs', 'folder');
      assert.equal(f.code, 1);
      assert.match(f.err, /won't record .* as a folder: .* is \(or contains\) the /);
      assert.equal(recorded(dir), undefined);
    });
  }

  it('refuses a folder containing the roots', () => {
    const dir = join(tmp, 'roots');
    assert.equal(wh('worktree', 'add', ws, '--path', dir).code, 1);
    assert.equal(wh('worktree', 'add', ws, '--path', dir, '--vcs', 'folder').code, 1);
    assert.equal(recorded(dir), undefined);
  });

  it('refuses a system folder and the home folder', () => {
    for (const dir of ['/usr', resolve(env.HOME ?? '/nonexistent-home')]) {
      const r = wh('worktree', 'add', ws, '--path', dir, '--vcs', 'folder');
      assert.equal(r.code, 1, dir);
      assert.equal(recorded(dir), undefined);
    }
  });

  it('a folder inside a root is still recorded', () => {
    const dir = join(tmp, 'roots', 'plain', 'notes');
    mkdirSync(dir);
    assert.equal(wh('worktree', 'add', ws, '--path', dir).out, `recorded folder ${dir} in ${ws}`);
  });
});
