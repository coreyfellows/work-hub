import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Digest } from './digest.ts';
import { digestPaths, readDigest, removeDigest, sessionMapPath, writeDigest } from './files.ts';

const block = (sessionId: string) => ({
  sessionId,
  shortId: sessionId.slice(0, 8),
  name: null,
  role: 'main',
  status: 'idle',
  started: 'today',
  active: null,
  intent: null,
  claim: null,
  done: [],
  worktree: null,
  prs: [],
  commits: [],
  files: [],
  version: `v-${sessionId}`,
});

test('writeDigest writes json+md atomically and a session map per block; removeDigest clears them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-files-'));
  const d: Digest = { workspaceId: 'ws', builtAt: 1, liveAt: null, blocks: [block('uuid-aaaa'), block('uuid-bbbb')] };
  await writeDigest(dir, d, '- **uuid-aaa**\n');
  const { json, md } = digestPaths(dir, 'ws');
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), d);
  assert.equal(readFileSync(md, 'utf8'), '- **uuid-aaa**\n');
  assert.deepEqual(JSON.parse(readFileSync(sessionMapPath(dir, 'uuid-aaaa'), 'utf8')), { workspaceId: 'ws' });
  assert.deepEqual(await readDigest(dir, 'ws'), d);
  assert.equal(await readDigest(dir, 'other'), null);

  // a session that left the digest loses its map file; one in another workspace is untouched
  await writeDigest(dir, { ...d, workspaceId: 'ws2', blocks: [block('uuid-cccc')] }, '');
  await writeDigest(dir, { ...d, blocks: [block('uuid-aaaa')] }, '');
  assert.ok(!existsSync(sessionMapPath(dir, 'uuid-bbbb')), 'bbbb left ws');
  assert.ok(existsSync(sessionMapPath(dir, 'uuid-cccc')), 'cccc is in ws2');

  await removeDigest(dir, 'ws');
  assert.ok(!existsSync(json) && !existsSync(md));
  assert.ok(!existsSync(sessionMapPath(dir, 'uuid-aaaa')));
  assert.ok(existsSync(sessionMapPath(dir, 'uuid-cccc')));
  await removeDigest(dir, 'never-existed');
});

test('the hook\'s seen files go when their session leaves the digest or the workspace is removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-seen-'));
  const seen = (sid: string) => join(dir, 'seen', `${sid}.json`);
  mkdirSync(join(dir, 'seen'), { recursive: true });
  for (const sid of ['uuid-aaaa', 'uuid-bbbb', 'uuid-cccc']) writeFileSync(seen(sid), '{}');
  const d: Digest = { workspaceId: 'ws', builtAt: 1, liveAt: null, blocks: [block('uuid-aaaa'), block('uuid-bbbb')] };
  await writeDigest(dir, d, '');
  await writeDigest(dir, { ...d, workspaceId: 'ws2', blocks: [block('uuid-cccc')] }, '');
  await writeDigest(dir, { ...d, blocks: [block('uuid-aaaa')] }, '');
  assert.ok(!existsSync(seen('uuid-bbbb')), 'bbbb left ws');
  assert.ok(existsSync(seen('uuid-aaaa')) && existsSync(seen('uuid-cccc')));
  await removeDigest(dir, 'ws');
  assert.ok(!existsSync(seen('uuid-aaaa')));
  assert.ok(existsSync(seen('uuid-cccc')), 'another workspace\'s is kept');
});
