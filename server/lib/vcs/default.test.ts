import assert from 'node:assert/strict';
import test from 'node:test';
import { setVcsDefaultResolver } from '../../config.ts';
import { effectiveVcsDefault, vcsGroup } from './default.ts';
import { registerProvider, removeProviders } from './registry.ts';
import { folderProvider } from './folder.ts';

test('vcsGroup: a static select defaulting to detect', () => {
  const d = vcsGroup().defs[0];
  assert.deepEqual(d.options?.map((o) => o.value), ['detect', 'git', 'folder', 'jj', 'hg', 'p4']);
  assert.equal(d.default, 'detect');
});

test('effectiveVcsDefault: null for detect or an unregistered provider', () => {
  registerProvider(folderProvider, 'test-default');
  try {
    setVcsDefaultResolver(() => undefined);
    assert.equal(effectiveVcsDefault(), null);
    setVcsDefaultResolver(() => 'jj');
    assert.equal(effectiveVcsDefault(), null);
    setVcsDefaultResolver(() => 'folder');
    assert.equal(effectiveVcsDefault(), 'folder');
  } finally {
    setVcsDefaultResolver(null);
    removeProviders('test-default');
  }
});
