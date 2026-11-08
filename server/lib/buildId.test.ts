import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildId } from './buildId.ts';

test('reads the id the build wrote', () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-build-'));
  writeFileSync(join(d, 'build.txt'), '1793750000000\n');
  assert.equal(readBuildId(d), '1793750000000');
});

test('no build (dev) → null', () => {
  assert.equal(readBuildId(mkdtempSync(join(tmpdir(), 'wh-build-'))), null);
});
