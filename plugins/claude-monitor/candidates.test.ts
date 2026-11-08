import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginListEntry } from '../../plugin-api/server.ts';
import { candidates, readmeExcerpt } from './candidates.ts';

function plugin(root: string, id: string, manifest: Record<string, unknown>, readme = `# ${id}`): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, apiVersion: 1, ...manifest }));
  writeFileSync(join(dir, 'README.md'), readme);
  return dir;
}

test('candidates: active official and local plugins with their claudeVersion', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cands-'));
  const a = plugin(root, 'a', { description: 'A plugin', claudeVersion: '2.1.320' });
  const b = plugin(root, 'b', { claudeVersion: 'garbage' });
  const entry = (id: string, dir: string, kind: PluginListEntry['kind'], status: PluginListEntry['status'] = 'active'): PluginListEntry => ({ id, aliases: [], title: id, dir, kind, status });
  const list = [entry('a', a, 'official'), entry('b', b, 'local'), entry('h', join(root, 'h'), 'builtin'), entry('off', join(root, 'off'), 'official', 'disabled')];
  const c = candidates(list);
  assert.deepEqual(
    c.map((x) => [x.id, x.kind, x.manifestVersion, x.description]),
    [
      ['a', 'official', '2.1.320', 'A plugin'],
      ['b', 'local', null, ''],
    ],
  );
  assert.equal(candidates(list, { readmes: false })[0].readme, '');
});

test('readmeExcerpt includes feature READMEs from subfolders', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-readme-'));
  const dir = plugin(root, 'cv', {}, 'x'.repeat(5000));
  mkdirSync(join(dir, 'questions'));
  writeFileSync(join(dir, 'questions', 'README.md'), '# questions\nanswers forms');
  mkdirSync(join(dir, 'empty'));
  const text = readmeExcerpt(dir);
  assert.ok(text.startsWith('x'.repeat(3000) + '\n\n'), 'main README cut to 3000');
  assert.match(text, /#### Feature `questions`\n# questions\nanswers forms/);
  assert.doesNotMatch(text, /empty/);
});
