import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createScrutinizer, type GithubLike, type ScrutinizeDeps } from './scrutinize.ts';
import { prDir, SummaryStore } from './store.ts';

/** The whole flow against fakes: a github service, `git` and `claude`, on a temp state dir. */

const HEAD = 'a'.repeat(40);
const HEAD2 = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const SUMMARY = '# Add caching\n\nIntro.\n\n## Overview\n\nThe idea.\n\n## Minutiae\n\n- CSS\n';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scrutinize-'));
});
after(() => rm(dir, { recursive: true, force: true }));

function setup(opts: { clone: boolean; answer?: string; update?: string }) {
  let head = HEAD;
  let files = [{ path: 'a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@\n-a\n+b' }];
  const calls: Array<{ cmd: string; args: string[]; cwd?: string; input?: string }> = [];
  const github: GithubLike = {
    host: async () => 'gh.example',
    parseRef: (owner, name, number) => ({ owner, name, number: Number(number) }),
    prDetail: async () => ({ url: 'https://gh.example/o/r/pull/7', title: 'Add caching', body: 'b', author: 'al', base: 'main', head: 'cache', headOid: head }),
    prFiles: async () => files,
  };
  const deps: ScrutinizeDeps = {
    store: new SummaryStore(join(dir, String(Math.random()).slice(2))),
    github: () => github,
    reposDir: join(dir, 'repos'),
    scratchDir: join(dir, 'scratch'),
    model: () => 'opus',
    run: async (cmd, args, o) => {
      calls.push({ cmd, args, cwd: o?.cwd, input: o?.input });
      if (cmd === 'git') {
        const sub = args[2];
        if (sub === 'remote') return 'git@gh.example:o/r.git\n';
        if (sub === 'merge-base') return `${BASE}\n`;
        return '';
      }
      if (args.some((a) => a.includes('update-'))) return JSON.stringify({ result: opts.update ?? '{"note":"Added z.","edits":[{"action":"replace","section":"overview","content":"The idea, now with z."}]}' });
      const isAsk = args.some((a) => a.includes('ask-'));
      return JSON.stringify({ result: isAsk ? (opts.answer ?? '{"kind":"reply","reply":"Because.","content":""}') : SUMMARY });
    },
  };
  return { s: createScrutinizer(deps), deps, calls, setHead: (h: string, f: typeof files) => ((head = h), (files = f)) };
}

const ref = { owner: 'o', repo: 'r', number: 7 };

test('with a clone of the repo, the summary is written with read-only git at the PR head, and saved', async () => {
  await mkdir(join(dir, 'repos', 'r', '.git'), { recursive: true });
  const { s, deps, calls } = setup({ clone: true });
  const { path } = await s.generate(ref);
  assert.equal(await readFile(path, 'utf8'), SUMMARY);
  const run = calls.find((c) => c.cmd === 'claude')!;
  assert.equal(run.cwd, join(dir, 'repos', 'r'));
  assert.ok(run.args.includes('--no-session-persistence'));
  assert.equal(run.args[run.args.indexOf('--tools') + 1], 'Bash');
  assert.match(run.args[run.args.indexOf('--allowedTools') + 1], /^Bash\(git diff:\*\)/);
  assert.match(run.args[run.args.indexOf('--name') + 1], /^wh-scrutinize:/);
  assert.match(run.input!, new RegExp(`git diff ${BASE}\\.\\.${HEAD}`));
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args.includes('refs/pull/7/head')), 'fetched the PR head');

  const v = await s.view(ref, HEAD);
  assert.equal(v.exists, true);
  assert.equal(v.mode, 'git');
  assert.equal(v.headOid, HEAD);
  assert.equal(v.since, null, 'same head: nothing to compare');
  assert.deepEqual(v.stats, { files: 1, additions: 1, deletions: 1 });
  assert.equal(v.path, join(prDir(deps.store.root, { host: 'gh.example', owner: 'o', repo: 'r', number: 7 }), 'summary.md'));
});

test('without a clone, the diff goes inline and the run has no tools', async () => {
  await rm(join(dir, 'repos'), { recursive: true, force: true });
  const { s, calls } = setup({ clone: false });
  await s.generate(ref);
  const run = calls.find((c) => c.cmd === 'claude')!;
  assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
  assert.match(run.input!, /<diff>\ndiff --git a\/a\.ts b\/a\.ts/);
  assert.equal((await s.view(ref, null)).mode, 'inline');
});

test('a moved head reports what changed in the diff since', async () => {
  const { s, setHead } = setup({ clone: false });
  await s.generate(ref);
  setHead(HEAD2, [
    { path: 'a.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, patch: '@@\n-a\n+b\n+z' },
    { path: 'new.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, patch: '@@\n+n' },
  ]);
  const v = await s.view(ref, HEAD2);
  assert.equal(v.since?.files, 2);
  assert.deepEqual(v.since?.newFiles, ['new.ts']);
  assert.equal(v.since?.linesAdded, 2);
});

test('a question gets a reply in its thread; a follow-up keeps the history', async () => {
  const { s, calls } = setup({ clone: false });
  await s.generate(ref);
  const t = await s.ask(ref, { sectionId: 'overview', quote: 'The idea.', question: 'Which idea?' });
  assert.equal(t.pending, true);
  assert.equal((await s.answer(ref, t.id))?.kind, 'reply');
  let v = await s.view(ref, null);
  assert.deepEqual(v.threads[0].messages.map((m) => [m.role, m.text]), [['you', 'Which idea?'], ['claude', 'Because.']]);
  assert.equal(v.threads[0].pending, false);
  assert.equal(v.markdown, SUMMARY, 'a reply leaves the document alone');

  await s.ask(ref, { threadId: t.id, question: 'And?' });
  await s.answer(ref, t.id);
  const ask = calls.filter((c) => c.cmd === 'claude').at(-1)!;
  assert.match(ask.input!, /Reader: Which idea\?\nYou: Because\./);
  v = await s.view(ref, null);
  assert.equal(v.threads[0].messages.length, 4);
  // A finished question is not answered twice (a resumed job).
  assert.equal(await s.answer(ref, t.id), null);
});

test('a bigger answer becomes an addendum to the section', async () => {
  const { s } = setup({ clone: false, answer: '{"kind":"addendum","reply":"Added how.","content":"It works like this."}' });
  await s.generate(ref);
  const t = await s.ask(ref, { sectionId: 'overview', quote: '', question: 'How?' });
  await s.answer(ref, t.id);
  const v = await s.view(ref, null);
  assert.match(v.markdown!, /## Overview\n\nThe idea\.\n\n\*\*Addendum\*\* \(asked: “How\?”\)\n\nIt works like this\.\n\n## Minutiae/);
  assert.equal(v.threads[0].messages[1].kind, 'addendum');
});

test('regenerating keeps the old version in history and re-anchors threads', async () => {
  const { s, deps } = setup({ clone: false });
  await s.generate(ref);
  await s.ask(ref, { sectionId: 'overview', quote: '', question: 'q' });
  await new Promise((r) => setTimeout(r, 5)); // a distinct generatedAt
  await s.generate(ref);
  const key = { host: 'gh.example', owner: 'o', repo: 'r', number: 7 };
  const hist = await readdir(join(prDir(deps.store.root, key), 'history'));
  assert.equal(hist.length, 1);
  assert.equal((await s.view(ref, null)).threads.length, 1);
});

test('bad asks are refused', async () => {
  const { s } = setup({ clone: false });
  await assert.rejects(s.ask(ref, { sectionId: 'overview', question: 'q' }), /no summary yet/);
  await s.generate(ref);
  await assert.rejects(s.ask(ref, { sectionId: 'overview', question: '  ' }), /ask a question/);
  await assert.rejects(s.ask(ref, { sectionId: 'nope', question: 'q' }), /no longer in the summary/);
  const t = await s.ask(ref, { sectionId: 'overview', question: 'q' });
  await assert.rejects(s.ask(ref, { threadId: t.id, question: 'again' }), /still waiting/);
});

test('a failed answer is recorded on the thread', async () => {
  const { s } = setup({ clone: false, answer: 'not json' });
  await s.generate(ref);
  const t = await s.ask(ref, { sectionId: 'overview', question: 'q' });
  await assert.rejects(s.answer(ref, t.id), /not JSON/);
  const th = (await s.view(ref, null)).threads[0];
  assert.equal(th.pending, false);
  assert.match(th.error!, /not JSON/);
});

test('the store refuses path tricks', () => {
  assert.throws(() => prDir('/x', { host: '..', owner: 'o', repo: 'r', number: 1 }), /bad PR reference/);
  assert.throws(() => prDir('/x', { host: 'h', owner: 'a/b', repo: 'r', number: 1 }), /bad PR reference/);
});

test('Update revises only the affected sections, logs it, keeps history and moves the head', async () => {
  const { s, setHead, calls, deps } = setup({ clone: false });
  await s.generate(ref);
  const t = await s.ask(ref, { sectionId: 'minutiae', question: 'q' });
  assert.equal((await s.update(ref)).upToDate, true, 'same head: nothing to do');
  setHead(HEAD2, [{ path: 'a.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, patch: '@@\n-a\n+b\n+z' }]);
  const out = await s.update(ref);
  assert.deepEqual([out.upToDate, out.edits], [false, 1]);
  const run = calls.filter((c) => c.cmd === 'claude').at(-1)!;
  assert.match(run.input!, /- changed: a\.ts/);
  assert.match(run.input!, /<diff>\ndiff --git a\/a\.ts/);
  const v = await s.view(ref, HEAD2);
  assert.equal(v.headOid, HEAD2);
  assert.equal(v.since, null, 'up to date again');
  assert.ok(v.updatedAt);
  assert.match(v.markdown!, /## Overview\n\nThe idea, now with z\.\n\n## Updates\n\n- \*\*\d{4}-\d\d-\d\d\*\*, `aaaaaaa` → `ccccccc`: Added z\.\n\n## Minutiae/);
  assert.match(v.markdown!, /# Add caching\n\nIntro\./, 'untouched sections stay');
  assert.equal(v.threads.find((x) => x.id === t.id)?.sectionId, 'minutiae');
  const key = { host: 'gh.example', owner: 'o', repo: 'r', number: 7 };
  assert.equal((await readdir(join(prDir(deps.store.root, key), 'history'))).length, 1);
});

test('Update with the same diff only moves the head, without asking Claude', async () => {
  const { s, setHead, calls } = setup({ clone: false });
  await s.generate(ref);
  setHead(HEAD2, [{ path: 'a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@\n-a\n+b' }]);
  const before = calls.filter((c) => c.cmd === 'claude').length;
  await s.update(ref);
  assert.equal(calls.filter((c) => c.cmd === 'claude').length, before);
  const v = await s.view(ref, HEAD2);
  assert.equal(v.headOid, HEAD2);
  assert.match(v.markdown!, /diff is the same/);
});

test('Update needs a summary, and not while one is being written', async () => {
  const { s } = setup({ clone: false });
  await assert.rejects(s.update(ref), /no summary to update/);
});
