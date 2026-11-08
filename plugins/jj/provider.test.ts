import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../../plugin-api/server.ts';
import { createJjProvider, firstBookmark, parseRepo } from './provider.ts';

// jj isn't installed here: every test runs against a fake `jj` (a node script) that records its argv and cwd and
// answers from rules: the first rule whose `match` is a substring of the joined argv wins.
type Rule = { match: string; out?: string; err?: string; code?: number };

function fake(rules: Rule[]) {
  const dir = mkdtempSync(join(tmpdir(), 'wh-jj-'));
  const bin = join(dir, 'jj');
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
  const provider = createJjProvider({ run, bin });
  const calls = (): { args: string[]; cwd: string }[] =>
    existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { dir, provider, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A secondary jj workspace on disk: `.jj/repo` is a file pointing at the store. */
function workspaceDir(base: string, own = false): string {
  const root = join(base, 'wt', 'repo', 'PROJ-1');
  mkdirSync(join(root, '.jj'), { recursive: true });
  if (own) mkdirSync(join(root, '.jj', 'repo'));
  else writeFileSync(join(root, '.jj', 'repo'), '/repos/repo/.jj/repo');
  writeFileSync(join(root, 'file.txt'), 'x');
  return root;
}

test('parsing: first bookmark without markers, owner/name from a remote', () => {
  assert.equal(firstBookmark('PROJ-1* main\n'), 'PROJ-1');
  assert.equal(firstBookmark('feat??'), 'feat');
  assert.equal(firstBookmark('  \n'), null);
  assert.equal(parseRepo('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(parseRepo('https://github.com/acme/widgets'), 'acme/widgets');
});

test('detect runs `jj root` in the folder; a failure is no match', async () => {
  const f = fake([{ match: 'root', out: '/w/repo\n' }]);
  try {
    assert.equal(await f.provider.detect(f.dir), '/w/repo');
    assert.deepEqual(f.calls()[0], { args: ['root'], cwd: await realpath(f.dir) });
  } finally {
    f.done();
  }
  const g = fake([{ match: 'root', err: 'There is no jj repo in "."', code: 1 }]);
  try {
    assert.equal(await g.provider.detect(g.dir), null);
  } finally {
    g.done();
  }
});

test('identity is owner/name of the origin remote, else null', async () => {
  const f = fake([{ match: 'git remote list', out: 'upstream git@x:o/u.git\norigin git@github.com:acme/widgets.git\n' }]);
  try {
    assert.deepEqual(await f.provider.identity('/w/repo'), { repo: 'acme/widgets' });
    assert.deepEqual(f.calls()[0].args, ['-R', '/w/repo', '--ignore-working-copy', 'git', 'remote', 'list']);
  } finally {
    f.done();
  }
  const g = fake([{ match: 'git remote list', out: '' }]);
  try {
    assert.deepEqual(await g.provider.identity('/w/repo'), { repo: null });
  } finally {
    g.done();
  }
});

test('line is the nearest local bookmark on @\'s ancestry, else the change id; head is the change id', async () => {
  const f = fake([
    { match: '-T local_bookmarks', out: 'PROJ-1*' },
    { match: 'change_id.short()', out: 'kxqzrwst' },
  ]);
  try {
    assert.deepEqual(await f.provider.line('/w/repo'), { line: 'PROJ-1', head: 'kxqzrwst' });
    const argv = f.calls().map((c) => c.args.join(' ')).sort();
    assert.deepEqual(argv, [
      '-R /w/repo --ignore-working-copy log -r @ --no-graph -T change_id.short()',
      '-R /w/repo --ignore-working-copy log -r latest(::@ & bookmarks()) --no-graph -T local_bookmarks',
    ]);
  } finally {
    f.done();
  }
  const g = fake([
    { match: '-T local_bookmarks', out: '' },
    { match: 'change_id.short()', out: 'kxqzrwst\n' },
  ]);
  try {
    assert.deepEqual(await g.provider.line('/w/repo'), { line: 'kxqzrwst', head: 'kxqzrwst' });
  } finally {
    g.done();
  }
});

test('sharedLines: main, master, trunk', () => {
  const f = fake([]);
  try {
    assert.deepEqual([...f.provider.sharedLines].sort(), ['main', 'master', 'trunk']);
  } finally {
    f.done();
  }
});

test('inspect: dirty when `jj diff --summary` lists files; clean otherwise; missing folder is removable', async () => {
  const f = fake([{ match: 'diff --summary', out: 'M file.txt\n' }]);
  try {
    const root = workspaceDir(f.dir);
    assert.deepEqual(await f.provider.inspect(root), { exists: true, dirty: true, unsaved: 0, removable: false, block: 'changes in its working-copy commit' });
    assert.deepEqual(f.calls()[0].args, ['-R', root, 'diff', '--summary']);
    assert.deepEqual(await f.provider.inspect(join(f.dir, 'gone')), { exists: false, dirty: false, unsaved: 0, removable: true, block: null });
  } finally {
    f.done();
  }
  const g = fake([{ match: 'diff --summary', out: '' }]);
  try {
    const root = workspaceDir(g.dir);
    assert.deepEqual(await g.provider.inspect(root), { exists: true, dirty: false, unsaved: 0, removable: true, block: null });
  } finally {
    g.done();
  }
});

test('remove refuses a dirty workspace unless forced, then forgets it and deletes the folder', async () => {
  const f = fake([{ match: 'diff --summary', out: 'M file.txt\n' }]);
  try {
    const root = workspaceDir(f.dir);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: false }), /changes in its working-copy commit/);
    assert.ok(existsSync(root));
    assert.ok(!f.calls().some((c) => c.args.includes('forget')));
    await f.provider.removeWorkingCopy(root, { force: true });
    assert.ok(!existsSync(root));
    assert.ok(existsSync(join(f.dir, 'wt', 'repo')), 'only the given root is deleted');
    assert.deepEqual(f.calls().at(-1)!.args, ['-R', root, 'workspace', 'forget']);
  } finally {
    f.done();
  }
});

test('remove of a clean workspace forgets then deletes; a failed forget keeps the folder', async () => {
  const f = fake([{ match: 'diff --summary', out: '' }]);
  try {
    const root = workspaceDir(f.dir);
    await f.provider.removeWorkingCopy(root, { force: false });
    assert.ok(!existsSync(root));
  } finally {
    f.done();
  }
  const g = fake([
    { match: 'diff --summary', out: '' },
    { match: 'workspace forget', err: 'Error: no such workspace', code: 1 },
  ]);
  try {
    const root = workspaceDir(g.dir);
    await assert.rejects(g.provider.removeWorkingCopy(root, { force: false }), /no such workspace/);
    assert.ok(existsSync(root));
  } finally {
    g.done();
  }
});

test("the repo's own workspace is never removed, even forced", async () => {
  const f = fake([{ match: 'diff --summary', out: '' }]);
  try {
    const root = workspaceDir(f.dir, true);
    const s = await f.provider.inspect(root);
    assert.equal(s.removable, false);
    assert.match(s.block!, /holds the store/);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: true }), /holds the store/);
    assert.ok(existsSync(root));
    assert.deepEqual(f.calls(), []);
  } finally {
    f.done();
  }
});

test('agentInstructions name the create commands, --vcs jj and the ticket as the name', () => {
  const f = fake([]);
  try {
    const opts = { workspaceId: 'ws-7', ticketKey: 'PROJ-1', whCommand: '/hub/bin/wh', worktreesDir: '/home/u/worktrees' };
    const lines = f.provider.agentInstructions(opts);
    assert.ok(lines.length <= 6);
    const text = lines.join('\n');
    const path = "'/home/u/worktrees/<repo>/PROJ-1'";
    assert.ok(text.includes(`\`jj -R <source> workspace add ${path} --name ws-7 -r '<base>'\``));
    assert.ok(text.includes(`\`jj -R ${path} bookmark create PROJ-1 -r @\``));
    assert.ok(text.includes('trunk()'));
    assert.equal(lines.at(-1), `\`/hub/bin/wh worktree add ws-7 --path ${path} --vcs jj --branch PROJ-1 --base '<base>'\``);
    assert.ok(text.includes(`\`/hub/bin/wh trust ${path}\``));
    const noTicket = f.provider.agentInstructions({ ...opts, ticketKey: null }).join('\n');
    assert.ok(noTicket.includes("'/home/u/worktrees/<repo>/<short-kebab-desc>'"));
    assert.ok(noTicket.includes('bookmark create <short-kebab-desc> -r @'));
    // A ticket key that isn't one never reaches the commands; a quote in the folder is escaped.
    const hostile = f.provider.agentInstructions({ ...opts, ticketKey: 'X-1; rm -rf ~', worktreesDir: "/it's" }).join('\n');
    assert.ok(!hostile.includes('rm -rf'));
    assert.ok(hostile.includes("'/it'\\''s/<repo>/<short-kebab-desc>'"));
  } finally {
    f.done();
  }
});

test('prereq runs `jj --version`', async () => {
  const f = fake([{ match: '--version', out: 'jj 0.30.0\n' }]);
  try {
    assert.deepEqual(await f.provider.prereq(), { ok: true, detail: 'jj 0.30.0' });
    assert.deepEqual(f.calls()[0].args, ['--version']);
  } finally {
    f.done();
  }
  const missing = createJjProvider({ run, bin: '/nonexistent/jj' });
  assert.equal((await missing.prereq()).ok, false);
});
