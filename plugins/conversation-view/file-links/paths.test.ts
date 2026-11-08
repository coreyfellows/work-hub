import test from 'node:test';
import assert from 'node:assert/strict';
import { pathCandidates } from './paths.ts';

const found = (t: string) => pathCandidates(t).map((c) => c[2]);

test('finds relative, absolute, home and bare-file paths', () => {
  assert.deepEqual(found('The doc is at docs/superpowers/specs/2026-11-04-portable-plugins-design.md (core).'), [
    'docs/superpowers/specs/2026-11-04-portable-plugins-design.md',
  ]);
  assert.deepEqual(found('see /tmp/work-hub/x/do-thing.sh, and ~/notes/a.md.'), ['/tmp/work-hub/x/do-thing.sh', '~/notes/a.md']);
  assert.deepEqual(found('edit CLAUDE.md now'), ['CLAUDE.md']);
  assert.deepEqual(found('server/index.ts:42 and web/src/a.tsx#L7'), ['server/index.ts:42', 'web/src/a.tsx#L7']);
});

test('ignores prose that only looks similar', () => {
  assert.deepEqual(found('e.g. this, v1.2.3 and 3.14 or and/or'), ['and/or']);
  assert.deepEqual(found('plain words only.'), []);
});
