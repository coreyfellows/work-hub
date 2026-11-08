import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { processRequests } from './requests.ts';
import { parseRefArg, parseRemote, requestsDir } from './skills/scrutinize-pr/scrutinize-pr.ts';

const ID = '0f8e6c1a-1111-4222-8333-444455556666';

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'scr-req-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const answer = async (dir: string) => JSON.parse(await readFile(join(dir, `${ID}.response.json`), 'utf8'));

test('a request is taken once, handed over, and answered beside it', () =>
  withDir(async (dir) => {
    await writeFile(join(dir, `${ID}.json`), JSON.stringify({ owner: 'o', repo: 'r', number: 7, requestedAt: new Date().toISOString() }));
    const seen: unknown[] = [];
    const n = await processRequests(dir, async (req, respond) => {
      seen.push(req);
      await respond({ status: 'started', url: 'u' });
    });
    assert.equal(n, 1);
    assert.equal((seen[0] as { number: number }).number, 7);
    assert.deepEqual(await readdir(dir), [`${ID}.response.json`]);
    assert.equal((await answer(dir)).status, 'started');
    assert.equal(await processRequests(dir, async () => assert.fail('taken twice')), 0);
  }));

test('stale, unreadable and failing requests are answered as failed', () =>
  withDir(async (dir) => {
    const never = async () => assert.fail('should not run');
    await writeFile(join(dir, `${ID}.json`), JSON.stringify({ owner: 'o', requestedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
    await processRequests(dir, never);
    assert.match((await answer(dir)).error, /over an hour old/);
    await writeFile(join(dir, `${ID}.json`), '{not json');
    await processRequests(dir, never);
    assert.match((await answer(dir)).error, /unreadable/);
    await writeFile(join(dir, `${ID}.json`), JSON.stringify({ requestedAt: new Date().toISOString() }));
    await processRequests(dir, async () => {
      throw new Error('boom');
    });
    assert.deepEqual([(await answer(dir)).status, (await answer(dir)).error], ['failed', 'boom']);
  }));

test('old answers are cleaned up; other files are left alone', () =>
  withDir(async (dir) => {
    const old = join(dir, `${ID}.response.json`);
    await writeFile(old, '{}');
    await utimes(old, new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000));
    await writeFile(join(dir, 'x.tmp'), '');
    await processRequests(dir, async () => {});
    assert.deepEqual(await readdir(dir), ['x.tmp']);
  }));

test('the skill reads PR references the way the user types them', () => {
  const here = { host: 'gh.example', owner: 'o', repo: 'r' };
  assert.deepEqual(parseRefArg('42', here), { ...here, number: 42 });
  assert.deepEqual(parseRefArg('#42', here), { ...here, number: 42 });
  assert.deepEqual(parseRefArg('a/b#3', here), { host: 'gh.example', owner: 'a', repo: 'b', number: 3 });
  assert.deepEqual(parseRefArg('https://gh.other/a/b/pull/9/files', null), { host: 'gh.other', owner: 'a', repo: 'b', number: 9 });
  assert.throws(() => parseRefArg('42', null), /just a number/);
  assert.throws(() => parseRefArg('nope', here), /can't read/);
});

test('git remotes in ssh and https form', () => {
  assert.deepEqual(parseRemote('git@ghe.example.com:web-team/site-src.git'), { host: 'ghe.example.com', owner: 'web-team', repo: 'site-src' });
  assert.deepEqual(parseRemote('https://github.com/a/b'), { host: 'github.com', owner: 'a', repo: 'b' });
  assert.deepEqual(parseRemote('ssh://git@host.x/a/b.git'), { host: 'host.x', owner: 'a', repo: 'b' });
});

test('the skill and the server agree on the requests folder', () => {
  assert.equal(requestsDir({ WORK_HUB_STATE_DIR: '/s' }), '/s/plugins/scrutinize-pr/requests');
});
