import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { linkPrsPass, prLabel } from './prLinks.ts';
import type { PullRequest } from './types.ts';

test('prLabel', () => {
  assert.equal(prLabel('https://ghe.example.com/web-team/site-src/pull/3615'), 'site-src#3615');
  assert.equal(prLabel('https://github.com/o/r/pull/7/'), 'r#7');
  assert.equal(prLabel('https://github.com/o/r/issues/7'), null);
});

function fakeStore(linked: string[]) {
  const links: Array<{ ws: string; url: string; label: string | null }> = [];
  const store = {
    sessionOwners: () => new Map([['sess-1', 'ws1']]),
    allWorktrees: () => [
      { workspaceId: 'ws1', repo: 'o/app', path: '/w/app/A', branch: 'feat-a' },
      { workspaceId: 'ws2', repo: 'o/app', path: '/w/app/B', branch: 'main' },
    ],
    linkedUrls: () => new Set(linked),
    addLink: (ws: string, l: { url: string; label: string | null }) => void links.push({ ws, url: l.url, label: l.label }),
    logEvent: () => {},
  };
  return { store, links };
}

const pr = (over: Partial<PullRequest>) => ({ url: 'https://gh/o/app/pull/1', repo: 'o/app', branch: 'feat-a', number: 1, ...over }) as PullRequest;

test('linkPrsPass: job children and branch matches, never a shared branch or an already linked URL', async () => {
  const jobs = mkdtempSync(join(tmpdir(), 'gh-jobs-'));
  mkdirSync(join(jobs, 'abcd1234'));
  writeFileSync(join(jobs, 'abcd1234', 'state.json'), JSON.stringify({ children: [{ kind: 'pr', href: 'https://gh/o/app/pull/9/' }, { kind: 'issue', href: 'x' }] }));
  const { store, links } = fakeStore(['https://gh/o/app/pull/3']);
  const prs = [pr({}), pr({ url: 'https://gh/o/app/pull/2', branch: 'main' }), pr({ url: 'https://gh/o/app/pull/3/', branch: 'feat-a' })];
  const pass = linkPrsPass(() => prs, jobs);
  const sessions = [{ sessionId: 'sess-1', shortId: 'abcd1234', kind: 'background' }];
  const changed = await pass({ sessions, store } as never);
  assert.equal(changed, true);
  assert.deepEqual(links, [
    { ws: 'ws1', url: 'https://gh/o/app/pull/9', label: 'app#9' },
    { ws: 'ws1', url: 'https://gh/o/app/pull/1', label: 'app#1' },
  ]);
});

test('linkPrsPass: a copy with no repo (a folder, jj, hg, p4) never claims a PR', async () => {
  const links: string[] = [];
  const store = {
    sessionOwners: () => new Map(),
    allWorktrees: () => [{ workspaceId: 'ws1', vcs: 'jj', repo: null, path: '/w/copy', branch: 'feat-a' }],
    linkedUrls: () => new Set<string>(),
    addLink: (_ws: string, l: { url: string }) => void links.push(l.url),
    logEvent: () => {},
  };
  assert.equal(await linkPrsPass(() => [pr({})], mkdtempSync(join(tmpdir(), 'gh-jobs-')))({ sessions: [], store } as never), false);
  assert.deepEqual(links, []);
});
