import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucket, buildDigest, renderBlock, renderDigest, type DigestInput } from './digest.ts';

const now = 1_000_000_000_000;
const H = 3_600_000;
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    workspaceId: 'ws',
    now,
    liveAt: now - 60_000,
    sessions: [
      { sessionId: 'uuid-a', shortId: 'aaaa1111', name: 'Add PR button', role: 'main', status: 'working', intent: 'Ship the PR button', startedAt: now - 2 * H, lastActiveAt: now - 60_000, branch: 'feat/pr-button', repo: 'org/hub' },
      { sessionId: 'uuid-b', shortId: '9c1d2e3f', name: 'Fix registry', role: 'main', status: 'idle', intent: null, startedAt: now - 5 * H, lastActiveAt: now - 40 * 60_000, branch: 'fix/registry', repo: 'org/hub' },
    ],
    worktrees: {
      'uuid-a': [{ path: '/w/hub/pr-button', repo: 'org/hub', branch: 'feat/pr-button', baseBranch: 'main' }],
      'uuid-b': [{ path: '/w/hub/registry', repo: 'org/hub', branch: 'fix/registry', baseBranch: 'main' }],
    },
    events: [
      { at: iso(10_000), type: 'done', detail: 'done four', sessionId: 'uuid-a' },
      { at: iso(20_000), type: 'done', detail: 'done three', sessionId: 'uuid-a' },
      { at: iso(30_000), type: 'done', detail: 'done two', sessionId: 'uuid-a' },
      { at: iso(40_000), type: 'done', detail: 'done one', sessionId: 'uuid-a' },
      { at: iso(50_000), type: 'claim', detail: 'the PR button end to end', sessionId: 'uuid-a' },
      { at: iso(60_000), type: 'claim', detail: 'an older claim', sessionId: 'uuid-a' },
      { at: iso(5_000), type: 'claim', detail: 'registry polling', sessionId: 'uuid-b' },
    ],
    prs: [
      { number: 41, title: 'PR button', url: 'https://gh/org/hub/pull/41', repo: 'Org/Hub', branch: 'feat/pr-button', isDraft: false, checks: 'PENDING' },
      { number: 7, title: 'elsewhere', url: 'https://gh/org/other/pull/7', repo: 'org/other', branch: 'feat/pr-button', isDraft: true, checks: null },
    ],
    commits: { '/w/hub/pr-button': [{ sha: 'abc1234', subject: 'Add the button' }] },
    edits: {
      'uuid-a': [
        { path: '/w/hub/pr-button/server/registry.ts', at: now - 10 * 60_000 },
        { path: '/w/hub/pr-button/web/src/Button.tsx', at: now - 20 * 60_000 },
      ],
      'uuid-b': [
        { path: '/w/hub/registry/server/registry.ts', at: now - 30 * 60_000 },
        { path: '/w/hub/registry/server/old.ts', at: now - 3 * H },
      ],
    },
    maxBlockChars: 600,
    maxDigestChars: 4000,
    overlapWindowMs: 2 * H,
    ...over,
  };
}

test('one block per session with claim, last three dones, PRs on its branch and commits', () => {
  const d = buildDigest(input());
  assert.equal(d.workspaceId, 'ws');
  assert.equal(d.blocks.length, 2);
  const a = d.blocks.find((b) => b.sessionId === 'uuid-a')!;
  assert.equal(a.shortId, 'aaaa1111');
  assert.equal(a.status, 'working');
  assert.equal(a.intent, 'Ship the PR button');
  assert.equal(a.claim, 'the PR button end to end');
  assert.deepEqual(a.done, ['done four', 'done three', 'done two']);
  assert.deepEqual(a.worktree, { path: '/w/hub/pr-button', branch: 'feat/pr-button', base: 'main' });
  assert.deepEqual(a.prs, [{ number: 41, title: 'PR button', url: 'https://gh/org/hub/pull/41', state: 'open', checks: 'PENDING' }]);
  assert.deepEqual(a.commits, [{ sha: 'abc1234', subject: 'Add the button' }]);
  const b = d.blocks.find((b) => b.sessionId === 'uuid-b')!;
  assert.equal(b.claim, 'registry polling');
  assert.deepEqual(b.done, []);
  assert.deepEqual(b.prs, []);
});

test('files are relative to the worktree, capped at 8, newest first, and overlaps name the other session', () => {
  const d = buildDigest(input());
  const a = d.blocks.find((b) => b.sessionId === 'uuid-a')!;
  assert.deepEqual(a.files, [
    { path: 'server/registry.ts', alsoBy: ['9c1d2e3f'] },
    { path: 'web/src/Button.tsx', alsoBy: [] },
  ]);
  const b = d.blocks.find((b) => b.sessionId === 'uuid-b')!;
  assert.deepEqual(b.files, [
    { path: 'server/registry.ts', alsoBy: ['aaaa1111'] },
    { path: 'server/old.ts', alsoBy: [] },
  ]);
  // an edit older than the overlap window does not count as an overlap
  const stale = buildDigest(input({ edits: { 'uuid-a': [{ path: '/w/hub/pr-button/x.ts', at: now - 3 * H }], 'uuid-b': [{ path: '/w/hub/registry/x.ts', at: now - 1000 }] } }));
  assert.deepEqual(stale.blocks.find((b) => b.sessionId === 'uuid-b')!.files[0].alsoBy, []);
  // nine edits → eight files, distinct
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `/w/hub/pr-button/f${i}.ts`, at: now - i * 1000 }));
  const capped = buildDigest(input({ edits: { 'uuid-a': [...many, many[0]] } }));
  assert.equal(capped.blocks.find((b) => b.sessionId === 'uuid-a')!.files.length, 8);
  assert.equal(capped.blocks.find((b) => b.sessionId === 'uuid-a')!.files[0].path, 'f0.ts');
});

test('a file outside the worktree shows its last two path segments', () => {
  const d = buildDigest(input({ edits: { 'uuid-a': [{ path: '/elsewhere/deep/dir/file.ts', at: now }] } }));
  assert.equal(d.blocks.find((b) => b.sessionId === 'uuid-a')!.files[0].path, 'dir/file.ts');
});

test('version is stable across time buckets and liveAt but changes on a new PR or claim', () => {
  const v = (i: DigestInput) => buildDigest(i).blocks.find((b) => b.sessionId === 'uuid-a')!.version;
  const base = v(input());
  assert.equal(v(input({ now: now + H, liveAt: now + H })), base, 'only the buckets moved (edits are still inside the overlap window)');
  assert.notEqual(v(input({ prs: [] })), base, 'a PR went away');
  assert.notEqual(v(input({ events: [{ at: iso(1), type: 'claim', detail: 'something else', sessionId: 'uuid-a' }] })), base, 'a new claim');
  assert.notEqual(v(input({ sessions: input().sessions.map((s) => (s.sessionId === 'uuid-a' ? { ...s, status: 'needs-input' } : s)) })), base, 'status changed');
});

test('a block over maxBlockChars drops dones, then commits, then intent, then files, and never exceeds the cap', () => {
  const long = (p: string) => Array.from({ length: 3 }, (_, i) => ({ at: iso(i), type: 'done', detail: `${p} ${'x'.repeat(120)} ${i}`, sessionId: 'uuid-a' }));
  const d = buildDigest(input({ maxBlockChars: 300, events: [...long('done'), { at: iso(50), type: 'claim', detail: 'claim '.repeat(10), sessionId: 'uuid-a' }] }));
  const a = d.blocks.find((b) => b.sessionId === 'uuid-a')!;
  assert.ok(renderBlock(a, { stale: false, liveAt: now, now }).length <= 300, 'within the cap');
  assert.ok(a.done.length < 3, 'dones were trimmed first');
  const tiny = buildDigest(input({ maxBlockChars: 120 })).blocks.find((b) => b.sessionId === 'uuid-a')!;
  assert.deepEqual(tiny.done, []);
  assert.deepEqual(tiny.commits, []);
  assert.deepEqual(tiny.files, []);
  assert.ok(renderBlock(tiny, { stale: false, liveAt: now, now }).includes('aaaa1111'), 'the identity line always survives');
});

test('the whole digest stays under maxDigestChars by dropping files, then commits, then dones from every block', () => {
  const d = buildDigest(input({ maxDigestChars: 500 }));
  const total = d.blocks.reduce((n, b) => n + renderBlock(b, { stale: false, liveAt: now, now }).length, 0);
  assert.ok(total <= 500, `total ${total}`);
  assert.ok(d.blocks.every((b) => b.files.length === 0), 'files went first');
});

test('renderDigest excludes the asker, orders working first and failed last, returns "" with no siblings, and stamps stale live facts', () => {
  const three = input({
    sessions: [
      ...input().sessions,
      { sessionId: 'uuid-c', shortId: 'cccc3333', name: 'Broken', role: 'review', status: 'failed', intent: null, startedAt: now - H, lastActiveAt: null, branch: null, repo: null },
    ],
  });
  const d = buildDigest(three);
  const md = renderDigest(d, { excludeSessionId: 'uuid-b', staleAfterMs: 600_000, now });
  assert.ok(!md.includes('**9c1d2e3f**'), 'the asker has no block of its own');
  assert.ok(md.indexOf('aaaa1111') < md.indexOf('cccc3333'), 'working before failed');
  assert.ok(md.includes('#41'), 'PRs are rendered');
  assert.ok(md.includes('also edited by 9c1d2e3f'), 'overlaps name the other session even when it is the asker');
  assert.ok(!md.includes('status as of'), 'fresh live facts carry no stamp');
  assert.equal(renderDigest(buildDigest(input({ sessions: [input().sessions[0]] })), { excludeSessionId: 'uuid-a', staleAfterMs: 600_000, now }), '');
  const stale = renderDigest(buildDigest(input({ liveAt: now - 2 * H })), { staleAfterMs: 600_000, now });
  assert.ok(stale.includes('status as of 2h'), stale);
  assert.ok(stale.includes('work-hub was idle'));
});

test('bucket', () => {
  assert.equal(bucket(now - 30_000, now), 'just now');
  assert.equal(bucket(now - 3 * 60_000, now), '5m');
  assert.equal(bucket(now - 20 * 60_000, now), '30m');
  assert.equal(bucket(now - 90 * 60_000, now), '2h');
  assert.equal(bucket(now - 10 * H, now), 'today');
  assert.equal(bucket(now - 30 * H, now), 'older');
});

test('long fields are clipped so files survive: a context-prompt intent keeps only its task line', () => {
  const task = 'Session in a workspace should be aware of what the other sessions are working on. More detail here.';
  const intent = `You're working in the work-hub workspace "x" (X). What it's about:\n\n- Original request:\n${'blah '.repeat(3000)}\n\nYour task:\n\n${task}\n\nRules for this session (work-hub shows your messages): more rules`;
  const withIntent = (i: string, claim = 'the PR button end to end', maxBlockChars = 600) =>
    buildDigest(input({
      maxBlockChars,
      sessions: input().sessions.map((s) => (s.sessionId === 'uuid-a' ? { ...s, intent: i } : s)),
      events: [{ at: iso(1), type: 'claim', detail: claim, sessionId: 'uuid-a' }],
    })).blocks.find((b) => b.sessionId === 'uuid-a')!;
  const a = withIntent(intent);
  assert.equal(a.intent, task);
  assert.equal(a.files.length, 2, 'files survive a huge intent');
  // clip lengths, measured with a cap that doesn't trim
  const plain = withIntent(`first line ${'x'.repeat(500)}\nsecond line`, 'c'.repeat(1000), 5000);
  assert.ok(plain.intent!.length <= 160 && plain.intent!.endsWith('…') && plain.intent!.startsWith('first line'), plain.intent!);
  assert.ok(plain.claim!.length <= 160 && plain.claim!.endsWith('…'));
  // under the default cap the intent goes before the files do
  const capped = withIntent(`first line ${'x'.repeat(500)}`, 'c'.repeat(1000));
  assert.equal(capped.files.length, 2);
  assert.ok(renderBlock(capped, { stale: false, liveAt: now, now }).length <= 600);
});

test('paths compare through normPath: Windows spellings and trailing slashes still land inside the worktree', () => {
  const edits = { 'uuid-a': [{ path: 'c:\\w\\hub\\pr-button\\server\\a.ts', at: now }], 'uuid-b': [{ path: 'C:/w/hub/pr-button/server/a.ts', at: now }] };
  const worktrees = {
    'uuid-a': [{ path: 'C:/w/hub/pr-button', repo: 'org/hub', branch: 'feat/pr-button', baseBranch: 'main' }],
    'uuid-b': [{ path: 'C:/w/hub/pr-button/', repo: 'org/hub', branch: 'feat/pr-button', baseBranch: 'main' }],
  };
  const prev = process.env.WORK_HUB_PLATFORM;
  process.env.WORK_HUB_PLATFORM = 'win32';
  try {
    const d = buildDigest(input({ edits, worktrees }));
    assert.deepEqual(d.blocks.find((b) => b.sessionId === 'uuid-a')!.files, [{ path: 'server/a.ts', alsoBy: ['9c1d2e3f'] }]);
    assert.deepEqual(d.blocks.find((b) => b.sessionId === 'uuid-b')!.files, [{ path: 'server/a.ts', alsoBy: ['aaaa1111'] }]);
  } finally {
    if (prev === undefined) delete process.env.WORK_HUB_PLATFORM;
    else process.env.WORK_HUB_PLATFORM = prev;
  }
});

test('a worktree recorded with a trailing slash still contains its files (POSIX)', () => {
  const d = buildDigest(input({ worktrees: { 'uuid-a': [{ path: '/w/hub/pr-button/', repo: 'org/hub', branch: 'feat/pr-button', baseBranch: 'main' }], 'uuid-b': [] } }));
  assert.equal(d.blocks.find((b) => b.sessionId === 'uuid-a')!.files[0].path, 'server/registry.ts');
});
