import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../plugin-api/server.ts';
import { createHgProvider, parseRepo } from './provider.ts';

// hg isn't installed here: every test runs against a fake `hg` (a node script) that records its argv and cwd and
// answers from rules: the first rule whose `match` is a substring of the joined argv wins.
type Rule = { match: string; out?: string; err?: string; code?: number };

function fake(rules: Rule[]) {
  const dir = mkdtempSync(join(tmpdir(), 'wh-hg-'));
  const bin = join(dir, 'hg');
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls'), JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf8'));
const r = rules.find((r) => args.join(' ').includes(r.match));
if (r) { if (r.out) process.stdout.write(r.out); if (r.err) process.stderr.write(r.err); process.exit(r.code ?? 0); }
`,
  );
  chmodSync(bin, 0o755);
  const provider = createHgProvider({ run, bin });
  const calls = (): { args: string[]; cwd: string }[] =>
    existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { dir, provider, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An hg working copy on disk: a share (`.hg/sharedpath`) unless `own`. */
function copyDir(base: string, own = false): string {
  const root = join(base, 'wt', 'repo', 'PROJ-1');
  mkdirSync(join(root, '.hg'), { recursive: true });
  if (!own) writeFileSync(join(root, '.hg', 'sharedpath'), '/repos/repo/.hg');
  writeFileSync(join(root, 'file.txt'), 'x');
  return root;
}

test('parseRepo: owner/name from a default path', () => {
  assert.equal(parseRepo('https://hg.example.com/acme/widgets'), 'acme/widgets');
  assert.equal(parseRepo('ssh://hg@example.com/acme/widgets/'), 'acme/widgets');
});

test('detect runs `hg root` in the folder; a failure is no match', async () => {
  const f = fake([{ match: 'root', out: '/w/repo\n' }]);
  try {
    assert.equal(await f.provider.detect(f.dir), '/w/repo');
    assert.deepEqual(f.calls()[0], { args: ['root'], cwd: await realpath(f.dir) });
  } finally {
    f.done();
  }
  const g = fake([{ match: 'root', err: 'abort: no repository found', code: 255 }]);
  try {
    assert.equal(await g.provider.detect(g.dir), null);
  } finally {
    g.done();
  }
});

test('identity is owner/name of `hg paths default`, else null', async () => {
  const f = fake([{ match: 'paths default', out: 'https://hg.example.com/acme/widgets\n' }]);
  try {
    assert.deepEqual(await f.provider.identity('/w/repo'), { repo: 'acme/widgets' });
    assert.deepEqual(f.calls()[0].args, ['-R', '/w/repo', 'paths', 'default']);
  } finally {
    f.done();
  }
  const g = fake([{ match: 'paths default', err: 'not found!', code: 1 }]);
  try {
    assert.deepEqual(await g.provider.identity('/w/repo'), { repo: null });
  } finally {
    g.done();
  }
});

test('line is the active bookmark, else the branch; head is the short node', async () => {
  const f = fake([
    { match: '{activebookmark}', out: 'PROJ-1' },
    { match: '{node|short}', out: 'a1b2c3d4e5f6' },
    { match: 'branch', out: 'default\n' },
  ]);
  try {
    assert.deepEqual(await f.provider.line('/w/repo'), { line: 'PROJ-1', head: 'a1b2c3d4e5f6' });
    const argv = f.calls().map((c) => c.args.join(' '));
    assert.ok(argv.includes('-R /w/repo log -r . -T {activebookmark}'));
    assert.ok(!argv.includes('-R /w/repo branch'), 'no branch call when a bookmark is active');
  } finally {
    f.done();
  }
  const g = fake([
    { match: '{activebookmark}', out: '' },
    { match: '{node|short}', out: 'a1b2c3d4e5f6' },
    { match: 'branch', out: 'stable\n' },
  ]);
  try {
    assert.deepEqual(await g.provider.line('/w/repo'), { line: 'stable', head: 'a1b2c3d4e5f6' });
    assert.ok(g.calls().some((c) => c.args.join(' ') === '-R /w/repo branch'));
  } finally {
    g.done();
  }
});

test('sharedLines: default', () => {
  const f = fake([]);
  try {
    assert.deepEqual([...f.provider.sharedLines], ['default']);
  } finally {
    f.done();
  }
});

test('inspect: dirty when `hg status` lists files; clean otherwise; missing folder is removable', async () => {
  const f = fake([{ match: 'status', out: 'M file.txt\n' }]);
  try {
    const root = copyDir(f.dir);
    assert.deepEqual(await f.provider.inspect(root), { exists: true, dirty: true, unsaved: 0, removable: false, block: 'uncommitted changes' });
    assert.deepEqual(f.calls()[0].args, ['-R', root, 'status']);
    assert.deepEqual(await f.provider.inspect(join(f.dir, 'gone')), { exists: false, dirty: false, unsaved: 0, removable: true, block: null });
  } finally {
    f.done();
  }
  const g = fake([{ match: 'status', out: '' }]);
  try {
    assert.deepEqual(await g.provider.inspect(copyDir(g.dir)), { exists: true, dirty: false, unsaved: 0, removable: true, block: null });
  } finally {
    g.done();
  }
});

test('remove refuses a dirty share unless forced, then deletes only its folder', async () => {
  const f = fake([{ match: 'status', out: 'M file.txt\n' }]);
  try {
    const root = copyDir(f.dir);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: false }), /uncommitted changes/);
    assert.ok(existsSync(root));
    await f.provider.removeWorkingCopy(root, { force: true });
    assert.ok(!existsSync(root));
    assert.ok(existsSync(join(f.dir, 'wt', 'repo')), 'only the given root is deleted');
  } finally {
    f.done();
  }
  const g = fake([{ match: 'status', out: '' }]);
  try {
    const root = copyDir(g.dir);
    await g.provider.removeWorkingCopy(root, { force: false });
    assert.ok(!existsSync(root));
  } finally {
    g.done();
  }
});

test("a repo's own clone (not a share) is never removed, even forced", async () => {
  const f = fake([{ match: 'status', out: '' }]);
  try {
    const root = copyDir(f.dir, true);
    const s = await f.provider.inspect(root);
    assert.equal(s.removable, false);
    assert.match(s.block!, /not an hg share/);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: true }), /not an hg share/);
    assert.ok(existsSync(root));
  } finally {
    f.done();
  }
});

test('agentInstructions name share -B / update / bookmark, --vcs hg and the ticket as the name', () => {
  const f = fake([]);
  try {
    const opts = { workspaceId: 'ws-7', ticketKey: 'PROJ-1', whCommand: '/hub/bin/wh', worktreesDir: '/home/u/worktrees' };
    const lines = f.provider.agentInstructions(opts);
    assert.ok(lines.length <= 6);
    const text = lines.join('\n');
    const path = "'/home/u/worktrees/<repo>/PROJ-1'";
    assert.ok(text.includes(`\`hg share -B <source> ${path}\``));
    assert.ok(text.includes(`\`hg -R ${path} update <base>\``));
    assert.ok(text.includes(`\`hg -R ${path} bookmark PROJ-1\``));
    assert.ok(text.includes(`\`/hub/bin/wh trust ${path}\``));
    assert.equal(lines.at(-1), `\`/hub/bin/wh worktree add ws-7 --path ${path} --vcs hg --branch PROJ-1 --base <base>\``);
    const noTicket = f.provider.agentInstructions({ ...opts, ticketKey: null }).join('\n');
    assert.ok(noTicket.includes("'/home/u/worktrees/<repo>/<short-kebab-desc>'"));
    assert.ok(noTicket.includes('bookmark <short-kebab-desc>'));
    // A ticket key that isn't one never reaches the commands; a quote in the folder is escaped.
    const hostile = f.provider.agentInstructions({ ...opts, ticketKey: 'X-1; rm -rf ~', worktreesDir: "/it's" }).join('\n');
    assert.ok(!hostile.includes('rm -rf'));
    assert.ok(hostile.includes("'/it'\\''s/<repo>/<short-kebab-desc>'"));
  } finally {
    f.done();
  }
});

test('prereq runs `hg --version`', async () => {
  const f = fake([{ match: '--version', out: 'Mercurial Distributed SCM (version 6.8)\n(see https://mercurial-scm.org)\n' }]);
  try {
    assert.deepEqual(await f.provider.prereq(), { ok: true, detail: 'Mercurial Distributed SCM (version 6.8)' });
    assert.deepEqual(f.calls()[0].args, ['--version']);
  } finally {
    f.done();
  }
  assert.equal((await createHgProvider({ run, bin: '/nonexistent/hg' }).prereq()).ok, false);
});
