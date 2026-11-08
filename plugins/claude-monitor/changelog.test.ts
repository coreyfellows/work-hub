import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { between, newestIn, parseChangelog, toMarkdown } from './changelog.ts';
import { changelogLoader } from './changelogSource.ts';

const MD = `# Changelog

## 2.1.320

- Added \`--foo\` flag
- Fixed a thing that
  wrapped onto two lines

## 2.1.319

- Changed hooks

## 2.1.9

* Old item
`;

test('parseChangelog: sections, items, continuation lines', () => {
  const e = parseChangelog(MD);
  assert.deepEqual(
    e.map((x) => x.version),
    ['2.1.320', '2.1.319', '2.1.9'],
  );
  assert.deepEqual(e[0].items, ['Added `--foo` flag', 'Fixed a thing that wrapped onto two lines']);
  assert.deepEqual(e[2].items, ['Old item']);
  assert.equal(newestIn(e), '2.1.320');
});

test('between: exclusive from, inclusive to, newest first', () => {
  const e = parseChangelog(MD);
  assert.deepEqual(
    between(e, '2.1.9', '2.1.320').map((x) => x.version),
    ['2.1.320', '2.1.319'],
  );
  assert.deepEqual(
    between(e, null, '2.1.319').map((x) => x.version),
    ['2.1.319', '2.1.9'],
  );
  assert.deepEqual(between(e, '2.1.320', '2.1.320'), []);
});

test('toMarkdown drops the oldest sections past the budget, without gaps', () => {
  const e = [
    { version: '3.0.0', items: ['a'.repeat(50)] },
    { version: '2.0.0', items: ['b'.repeat(500)] },
    { version: '1.0.0', items: ['c'] },
  ];
  const r = toMarkdown(e, 100);
  assert.equal(r.dropped, 2);
  assert.match(r.text, /## 3\.0\.0/);
  assert.doesNotMatch(r.text, /1\.0\.0/);
  assert.equal(toMarkdown(e).dropped, 0);
});

test('changelogLoader: fetches when the cache lacks the version, falls back to the local copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-'));
  const local = join(dir, 'local.md');
  writeFileSync(local, '## 2.1.319\n- local\n');
  let fetches = 0;
  let t = 1_000_000;
  const loader = changelogLoader({
    cacheDir: join(dir, 'cache'),
    url: () => 'https://example.invalid/CHANGELOG.md',
    localFile: () => local,
    now: () => t,
    fetchText: async () => {
      fetches++;
      if (fetches === 1) throw new Error('offline');
      return MD;
    },
  });
  const a = await loader.load('2.1.320');
  assert.equal(a.from, 'local');
  assert.match(a.error ?? '', /offline/);
  // Within 10 minutes: no new fetch.
  await loader.load('2.1.320');
  assert.equal(fetches, 1);
  t += 11 * 60_000;
  const b = await loader.load('2.1.320');
  assert.equal(fetches, 2);
  assert.equal(b.from, 'remote');
  assert.equal(b.error, null);
  assert.equal(b.entries[0].version, '2.1.320');
  // Cached now: covered, no fetch.
  t += 11 * 60_000;
  await loader.load('2.1.320');
  assert.equal(fetches, 2);
});
