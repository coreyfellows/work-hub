import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../plugin-api/server.ts';
import { createP4Provider, parseTemplates, type P4Template } from './provider.ts';

// p4 isn't installed here: every test runs against a fake `p4` (a node script) that records its argv and answers from
// rules: the first rule whose `match` is a substring of the joined argv wins. `{dir}` in an output is the temp dir.
type Rule = { match: string; out?: string; err?: string; code?: number };

function fake(rules: Rule[], templates: P4Template[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'wh-p4-'));
  const bin = join(dir, 'p4');
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules).replaceAll('{dir}', dir));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls'), JSON.stringify({ args }) + '\\n');
fs.appendFileSync(path.join(__dirname, 'ctx'), JSON.stringify({ cwd: process.cwd(), P4CONFIG: process.env.P4CONFIG }) + '\\n');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf8'));
const r = rules.find((r) => args.join(' ').includes(r.match));
if (r) { if (r.out) process.stdout.write(r.out); if (r.err) process.stderr.write(r.err); process.exit(r.code ?? 0); }
`,
  );
  chmodSync(bin, 0o755);
  const provider = createP4Provider({ run, bin, templates, p4config: '.p4config' });
  const calls = (): string[] =>
    existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l).args as string[]).join(' ')) : [];
  const ctx = (): { cwd: string; P4CONFIG?: string }[] =>
    existsSync(join(dir, 'ctx')) ? readFileSync(join(dir, 'ctx'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { dir, provider, calls, ctx, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The client folder the fake's `clients --me` points at. */
function clientDir(base: string): string {
  const root = join(base, 'wt', 'game', 'PROJ-1');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'file.txt'), 'x');
  return root;
}

const CLIENTS: Rule = { match: 'clients --me', out: 'u-other /elsewhere\nu-wh-ws-7 {dir}/wt/game/PROJ-1\n' };
const CLEAN: Rule[] = [CLIENTS, { match: 'opened', err: 'File(s) not opened on this client.\n' }, { match: 'changes -s shelved', out: '' }];

test('parseTemplates keeps well-formed { name, client } entries only', () => {
  assert.deepEqual(parseTemplates([{ name: ' game ', client: 'u-game-tmpl' }, { name: 'x' }, 'y', null, { name: '', client: 'c' }]), [{ name: 'game', client: 'u-game-tmpl' }]);
  assert.deepEqual(parseTemplates('[{"name":"a","client":"b"}]'), []);
  assert.deepEqual(parseTemplates(undefined), []);
});

test('detect: the client root from `p4 -d <dir> info` when it contains the dir', async () => {
  const f = fake([{ match: 'info', out: '{dir}\n' }]);
  try {
    const sub = join(f.dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    assert.equal(await f.provider.detect(sub), f.dir);
    assert.deepEqual(f.calls(), [`-d ${sub} -F %clientRoot% info`]);
    // Run in the folder, with P4CONFIG defaulting to the file the instructions write.
    assert.deepEqual(f.ctx()[0], { cwd: await realpath(sub), P4CONFIG: '.p4config' });
  } finally {
    f.done();
  }
  const g = fake([{ match: 'info', out: '/somewhere/else\n' }]);
  try {
    assert.equal(await g.provider.detect(g.dir), null, 'a client rooted elsewhere is no match');
  } finally {
    g.done();
  }
  const h = fake([{ match: 'info', out: '\n' }]);
  try {
    assert.equal(await h.provider.detect(h.dir), null, 'no client');
  } finally {
    h.done();
  }
});

test('line is the client (as recorded); head the latest synced change; identity the stream', async () => {
  const f = fake([CLIENTS, { match: 'client -o u-wh-ws-7', out: '//Game/Main\n' }, { match: 'changes -m1', out: '12345\n' }]);
  try {
    const root = clientDir(f.dir);
    assert.deepEqual(await f.provider.line(root), { line: 'u-wh-ws-7', head: '12345' });
    assert.ok(f.calls().includes('-F %client% %Root% clients --me'));
    assert.ok(f.calls().includes('-c u-wh-ws-7 -F %change% changes -m1 //u-wh-ws-7/...#have'));
    assert.deepEqual(await f.provider.identity(root), { repo: '//Game/Main' });
    assert.ok(f.calls().includes('-F %Stream% client -o u-wh-ws-7'));
    assert.deepEqual(await f.provider.line(join(f.dir, 'not-a-client')), { line: null, head: null });
  } finally {
    f.done();
  }
});

test('inspect: clean; opened files make it dirty; shelved changelists count as unsaved; both block', async () => {
  const f = fake(CLEAN);
  try {
    const root = clientDir(f.dir);
    assert.deepEqual(await f.provider.inspect(root), { exists: true, dirty: false, unsaved: 0, removable: true, block: null });
    assert.ok(f.calls().includes('-c u-wh-ws-7 opened'));
    assert.ok(f.calls().includes('changes -s shelved -c u-wh-ws-7'));
    assert.deepEqual(await f.provider.inspect(join(f.dir, 'gone')), { exists: false, dirty: false, unsaved: 0, removable: true, block: null });
  } finally {
    f.done();
  }
  const g = fake([
    CLIENTS,
    { match: 'opened', out: '//Game/Main/a.cpp#3 - edit default change (text)\n//Game/Main/b.h#1 - add default change (text)\n' },
    { match: 'changes -s shelved', out: "Change 777 on 2026/11/01 by u@u-wh-ws-7 *pending* 'wip'\n" },
  ]);
  try {
    const root = clientDir(g.dir);
    assert.deepEqual(await g.provider.inspect(root), { exists: true, dirty: true, unsaved: 1, removable: false, block: '2 files opened, 1 shelved changelist' });
  } finally {
    g.done();
  }
});

test('a folder that is no client of yours is never removed, even forced', async () => {
  const f = fake([{ match: 'clients --me', out: 'u-other /elsewhere\n' }]);
  try {
    const root = clientDir(f.dir);
    assert.match((await f.provider.inspect(root)).block!, /no p4 client/);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: true }), /no p4 client/);
    assert.ok(existsSync(root));
    assert.ok(!f.calls().some((c) => c.startsWith('client -d')));
  } finally {
    f.done();
  }
});

test("a client that isn't work-hub's (no -wh-) is never removed, even forced", async () => {
  const f = fake([{ match: 'clients --me', out: 'u-personal {dir}/wt/game/PROJ-1\n' }, ...CLEAN.slice(1)]);
  try {
    const root = clientDir(f.dir);
    assert.match((await f.provider.inspect(root)).block!, /u-personal is not a work-hub client/);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: true }), /not a work-hub client/);
    assert.ok(existsSync(root));
    assert.ok(!f.calls().some((c) => c.startsWith('client -d') || c.includes('revert')));
  } finally {
    f.done();
  }
});

test('remove refuses opened or shelved unless forced', async () => {
  for (const rule of [{ match: 'opened', out: '//Game/Main/a.cpp#3 - edit default change (text)\n' }, { match: 'changes -s shelved', out: "Change 777 on 2026/11/01 by u@c *pending* 'wip'\n" }]) {
    const f = fake([CLIENTS, rule, { match: 'opened', out: '' }, { match: 'changes', out: '' }]);
    try {
      const root = clientDir(f.dir);
      await assert.rejects(f.provider.removeWorkingCopy(root, { force: false }), /opened|shelved/);
      assert.ok(existsSync(root));
      assert.ok(!f.calls().some((c) => c.startsWith('client -d')));
    } finally {
      f.done();
    }
  }
});

test('remove deletes the client then the folder; forced, opened files are reverted first', async () => {
  const f = fake(CLEAN);
  try {
    const root = clientDir(f.dir);
    await f.provider.removeWorkingCopy(root, { force: false });
    assert.ok(!existsSync(root));
    assert.ok(existsSync(join(f.dir, 'wt', 'game')), 'only the given root is deleted');
    assert.equal(f.calls().at(-1), 'client -d u-wh-ws-7');
    assert.ok(!f.calls().some((c) => c.includes('revert')));
  } finally {
    f.done();
  }
  const g = fake([CLIENTS, { match: 'opened', out: '//Game/Main/a.cpp#3 - edit default change (text)\n' }, { match: 'changes', out: '' }]);
  try {
    const root = clientDir(g.dir);
    await g.provider.removeWorkingCopy(root, { force: true });
    assert.ok(!existsSync(root));
    assert.deepEqual(g.calls().slice(-2), ['-c u-wh-ws-7 revert //u-wh-ws-7/...', 'client -d u-wh-ws-7']);
  } finally {
    g.done();
  }
});

test('a failed `p4 client -d` keeps the folder', async () => {
  const f = fake([...CLEAN, { match: 'client -d', err: "Client 'u-wh-ws-7' has files shelved; use 'shelve -df' to remove them.", code: 1 }]);
  try {
    const root = clientDir(f.dir);
    await assert.rejects(f.provider.removeWorkingCopy(root, { force: true }), /shelved/);
    assert.ok(existsSync(root));
  } finally {
    f.done();
  }
});

test('agentInstructions: template copy, sync, --vcs p4 with the client as the branch; templates listed', () => {
  const f = fake([], [{ name: 'game', client: 'u-game-tmpl' }, { name: 'engine', client: 'u-engine-tmpl' }]);
  try {
    const opts = { workspaceId: 'ws-7', ticketKey: 'PROJ-1', whCommand: '/hub/bin/wh', worktreesDir: '/home/u/worktrees' };
    const lines = f.provider.agentInstructions(opts);
    assert.ok(lines.length <= 6);
    const text = lines.join('\n');
    const path = "'/home/u/worktrees/<template>/PROJ-1'";
    assert.ok(text.includes('`game` (`u-game-tmpl`), `engine` (`u-engine-tmpl`)'));
    assert.ok(text.includes('`<user>-wh-ws-7`') && text.includes('`<user>-wh-ws-7-<template>`'));
    assert.ok(text.includes('`p4 -c <client> …`'));
    assert.ok(!text.includes('export') && !text.includes('${P4CONFIG'), 'env vars do not carry over to the agent');
    assert.ok(text.includes(`\`p4 client -t <template client> -o <client> | R=${path} awk '/^Root:/ { print "Root:\\t" ENVIRON["R"]; next } 1' | p4 client -i\``));
    assert.ok(text.includes(`\`mkdir -p ${path} && cd ${path} && p4 -c <client> sync && echo "P4CLIENT=<client>" > '.p4config'\``));
    assert.ok(text.includes(`\`/hub/bin/wh trust ${path}\``));
    assert.equal(lines.at(-1), `\`/hub/bin/wh worktree add ws-7 --path ${path} --vcs p4 --branch <client>\``);
    // A ticket key that isn't one never reaches the commands; a quote in the folder is escaped.
    const hostile = f.provider.agentInstructions({ ...opts, ticketKey: 'X-1; rm -rf ~', worktreesDir: "/it's" }).join('\n');
    assert.ok(!hostile.includes('rm -rf'));
    assert.ok(hostile.includes("'/it'\\''s/<template>/<short-kebab-desc>'"));
  } finally {
    f.done();
  }
  const g = fake([]);
  try {
    const text = g.provider.agentInstructions({ workspaceId: 'ws-7', ticketKey: null, whCommand: 'wh', worktreesDir: '/w' }).join('\n');
    assert.match(text, /No template clients are configured.*ask the user which existing client to copy/);
    assert.ok(text.includes("'/w/<template>/<short-kebab-desc>'"));
  } finally {
    g.done();
  }
});

test('the P4CONFIG file name the provider uses is the one the instructions write (quoted)', async () => {
  const f = fake([{ match: 'info', out: '{dir}\n' }]);
  try {
    const other = createP4Provider({ run, bin: join(f.dir, 'p4'), p4config: "my p4'cfg" });
    const text = other.agentInstructions({ workspaceId: 'ws-7', ticketKey: null, whCommand: 'wh', worktreesDir: '/w' }).join('\n');
    assert.ok(text.includes(`echo "P4CLIENT=<client>" > 'my p4'\\''cfg'`));
    await other.detect(f.dir);
    assert.equal(f.ctx()[0].P4CONFIG, "my p4'cfg");
  } finally {
    f.done();
  }
});

test('prereq runs `p4 -V`', async () => {
  const f = fake([{ match: '-V', out: 'Perforce - The Fast Software Configuration Management System.\nRev. P4/MACOSX12ARM64/2025.1/2761706 (2025/05/01).\n' }]);
  try {
    assert.deepEqual(await f.provider.prereq(), { ok: true, detail: 'Rev. P4/MACOSX12ARM64/2025.1/2761706 (2025/05/01).' });
    assert.deepEqual(f.calls(), ['-V']);
  } finally {
    f.done();
  }
  assert.equal((await createP4Provider({ run, bin: '/nonexistent/p4' }).prereq()).ok, false);
});
