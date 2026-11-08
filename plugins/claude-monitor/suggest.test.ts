import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyBody, bannerFor } from './bannerState.ts';
import { parseChangelog } from './changelog.ts';
import { MIGRATIONS, monitorStore } from './store.ts';
import { analysisPrompt, baselineOf, filterSuggestions, nextRecord, workList, type Candidate, type PluginRecord } from './suggest.ts';
import type { MonitorData } from './types.ts';
import { updatePrompt, updateSlug } from './updatePrompt.ts';

const entries = parseChangelog(`## 2.1.322\n- Added X\n\n## 2.1.321\n- Added Y\n\n## 2.1.320\n- Added Z\n`);
const cand = (id: string, manifestVersion: string | null = null): Candidate => ({
  id,
  title: id.toUpperCase(),
  kind: 'official',
  dir: `/repo/plugins/${id}`,
  description: `${id} does things`,
  readme: `# ${id}`,
  manifestVersion,
});
const rec = (pluginId: string, version: string, action: PluginRecord['action'] = 'seen'): PluginRecord => ({ pluginId, version, action, workspaceId: null, at: 't' });

test('baselineOf: the newer of manifest and record', () => {
  assert.deepEqual(baselineOf(null, undefined), { version: null, from: null });
  assert.deepEqual(baselineOf('2.1.321', rec('a', '2.1.320', 'skipped')), { version: '2.1.321', from: 'manifest' });
  assert.deepEqual(baselineOf('2.1.320', rec('a', '2.1.321', 'skipped')), { version: '2.1.321', from: 'skipped' });
  assert.deepEqual(baselineOf(null, rec('a', '2.1.320', 'updating')), { version: '2.1.320', from: 'updating' });
});

test('workList: only versions after each baseline; nothing to do is up to date', () => {
  const records = new Map([
    ['b', rec('b', '2.1.321', 'skipped')],
    ['c', rec('c', '2.1.322')],
  ]);
  const { work, upToDate } = workList([cand('a', '2.1.320'), cand('b'), cand('c'), cand('d')], records, entries, '2.1.322');
  assert.deepEqual(
    work.map((w) => [w.cand.id, w.entries.map((e) => e.version)]),
    [
      ['a', ['2.1.322', '2.1.321']],
      ['b', ['2.1.322']],
    ],
  );
  assert.deepEqual(upToDate, ['c', 'd'], 'd has no baseline: never the whole history');
});

test('analysisPrompt has each version once and each plugin with its range', () => {
  const { work } = workList([cand('a', '2.1.320'), cand('b', '2.1.321')], new Map(), entries, '2.1.322');
  const { prompt, dropped } = analysisPrompt(work);
  assert.equal(dropped, 0);
  assert.equal(prompt.match(/## 2\.1\.322/g)?.length, 1);
  assert.match(prompt, /Plugin `a`[^\n]*\nOnly consider changes in versions newer than 2\.1\.320/);
  assert.match(prompt, /Plugin `b`[^\n]*\nOnly consider changes in versions newer than 2\.1\.321/);
  assert.doesNotMatch(prompt, /## 2\.1\.320/);
});

test('filterSuggestions keeps only known plugins and in-range versions', () => {
  const { work } = workList([cand('a', '2.1.320'), cand('b', '2.1.321')], new Map(), entries, '2.1.322');
  const raw = {
    suggestions: [
      { plugin: 'b', items: [{ version: '2.1.321', change: 'Added Y', idea: 'too old for b' }, { version: 'v2.1.322', change: 'Added X', idea: 'use X' }] },
      { plugin: 'zzz', items: [{ version: '2.1.322', change: 'Added X', idea: 'unknown plugin' }] },
      { plugin: 'a', items: [{ version: '2.1.321', change: 'Added Y', idea: 'use Y' }, { version: '2.1.321', change: 'Added Y', idea: 'dup' }, { version: '2.1.322', change: '', idea: 'empty' }] },
      'junk',
    ],
  };
  const out = filterSuggestions(raw, work);
  assert.deepEqual(
    out.map((s) => [s.plugin, s.since, s.items.map((i) => `${i.version}:${i.idea}`)]),
    [
      ['a', '2.1.320', ['2.1.321:use Y']],
      ['b', '2.1.321', ['2.1.322:use X']],
    ],
  );
  assert.deepEqual(filterSuggestions(null, work), []);
  assert.deepEqual(filterSuggestions({ suggestions: 'no' }, work), []);
});

test('nextRecord never moves a plugin backwards', () => {
  assert.equal(nextRecord(rec('a', '2.1.322'), rec('a', '2.1.320', 'skipped')).version, '2.1.322');
  assert.equal(nextRecord(rec('a', '2.1.320'), rec('a', '2.1.320', 'updating')).action, 'updating');
  assert.equal(nextRecord(undefined, rec('a', '2.1.320', 'skipped')).action, 'skipped');
});

test('monitorStore: state and records in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  const s = monitorStore(() => db, () => 'now');
  assert.equal(s.get('acknowledged'), null);
  s.set('acknowledged', '2.1.320');
  s.set('acknowledged', '2.1.321');
  assert.equal(s.get('acknowledged'), '2.1.321');
  s.record({ pluginId: 'a', version: '2.1.321', action: 'skipped', workspaceId: null });
  s.record({ pluginId: 'a', version: '2.1.320', action: 'seen', workspaceId: null });
  s.record({ pluginId: 'b', version: '2.1.321', action: 'updating', workspaceId: 'ws1' });
  const r = s.records();
  assert.deepEqual(r.get('a'), { pluginId: 'a', version: '2.1.321', action: 'skipped', workspaceId: null, at: 'now' });
  assert.equal(r.get('b')?.workspaceId, 'ws1');
});

const data = (over: Partial<MonitorData> = {}): MonitorData => ({
  installed: '2.1.320',
  latest: '2.1.320',
  channel: 'latest',
  updateAvailable: false,
  acknowledged: '2.1.320',
  whatsNew: false,
  checkedAt: 1,
  checkError: null,
  updating: false,
  analysis: { status: 'none', version: null, count: 0, error: null },
  ...over,
});

test('bannerFor', () => {
  assert.equal(bannerFor(null, null).kind, 'none');
  assert.equal(bannerFor(data(), null).kind, 'none');
  assert.deepEqual(bannerFor(data({ updateAvailable: true, latest: '2.1.321' }), null), { kind: 'update', installed: '2.1.320', latest: '2.1.321' });
  assert.equal(bannerFor(data({ updateAvailable: true, latest: '2.1.321' }), '2.1.321').kind, 'none', 'dismissed for that version');
  assert.equal(bannerFor(data({ updateAvailable: true, latest: '2.1.322' }), '2.1.321').kind, 'update', 'a newer one shows again');
  assert.equal(bannerFor(data({ whatsNew: true }), null).kind, 'whats-new');
  assert.equal(bannerFor(data({ updating: true, whatsNew: true }), null).kind, 'updating');
});

test('applyBody: ticked are updated, the rest skipped', () => {
  assert.deepEqual(applyBody('2.1.320', ['a', 'b', 'c'], new Set(['b']), true), { version: '2.1.320', update: ['b'], skip: ['a', 'c'] });
  assert.deepEqual(applyBody('2.1.320', ['a', 'b'], new Set(), true), { version: '2.1.320', update: [], skip: ['a', 'b'] });
  assert.deepEqual(applyBody('2.1.320', ['a', 'b'], new Set(['a']), false), { version: '2.1.320', update: ['a'], skip: [] });
});

test('updateSlug and updatePrompt', () => {
  assert.equal(updateSlug('2.1.320', 'conversation-view'), 'claude-2-1-320-conversation-view');
  const p = updatePrompt({
    workspaceId: 'ws1',
    version: '2.1.322',
    suggestion: { plugin: 'a', title: 'A', kind: 'local', since: '2.1.320', items: [{ version: '2.1.321', change: 'Added Y', idea: 'use Y' }] },
    pluginDir: '/home/u/my-plugins/a',
    worktree: '/home/u/worktrees/work-hub/claude-2-1-322-a',
    branch: 'claude-2-1-322-a',
    base: 'origin/main',
    appRepo: '/home/u/repos/work-hub',
    whCommand: 'wh',
    rules: ['RULES'],
  });
  assert.match(p, /local work-hub plugin `a`/);
  assert.match(p, /\*\*2\.1\.321\*\*: Added Y\n {2}- Idea: use Y/);
  assert.match(p, /"claudeVersion": "2\.1\.322"/);
  assert.match(p, /pnpm check-plugin \/home\/u\/my-plugins\/a/);
  assert.match(p, /never edit files there/);
  assert.ok(p.endsWith('RULES'));
});
