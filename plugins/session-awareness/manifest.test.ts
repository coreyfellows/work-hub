import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8')) as { settings: Array<{ key: string; type: string; default: unknown; min?: number; max?: number; label: string }> };
const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

test('every setting server.ts reads is declared in plugin.json and listed in the README', () => {
  const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/config\.get\('(\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5);
  for (const k of new Set(keys)) {
    assert.ok(manifest.settings.some((s) => s.key === k), `${k} is not declared in plugin.json`);
    assert.ok(readme.includes(`\`${k}\``), `${k} is not in the README`);
  }
});

test('rebuildDebounceMs: number, default 2000, 0..60000', () => {
  const s = manifest.settings.find((x) => x.key === 'rebuildDebounceMs');
  assert.ok(s);
  assert.deepEqual([s.type, s.default, s.min, s.max], ['number', 2000, 0, 60000]);
});
