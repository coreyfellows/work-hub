import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostResolver, parseGhAuthHost } from './ghHost.ts';

test('parseGhAuthHost: the first "Logged in to" host', () => {
  const out = [
    'github.example.net',
    '  ✓ Logged in to github.example.net account someone (keyring)',
    '  - Active account: true',
    'github.com',
    '  ✓ Logged in to github.com account someone (keyring)',
  ].join('\n');
  assert.equal(parseGhAuthHost(out), 'github.example.net');
  assert.equal(parseGhAuthHost('You are not logged into any GitHub hosts. To log in, run: gh auth login'), undefined);
  assert.equal(parseGhAuthHost(''), undefined);
});

test('hostResolver: a configured host never runs the lookup', async () => {
  let calls = 0;
  const host = hostResolver('gh.example', async () => (calls++, 'other'));
  assert.equal(await host(), 'gh.example');
  assert.equal(calls, 0);
});

test('hostResolver: a missing answer falls back without sticking; a found host is kept', async () => {
  const answers: Array<string | undefined> = [undefined, 'gh.example', 'later.example'];
  let calls = 0;
  const host = hostResolver(undefined, async () => answers[calls++]);
  assert.equal(await host(), 'github.com');
  assert.equal(await host(), 'gh.example');
  assert.equal(await host(), 'gh.example');
  assert.equal(calls, 2);
});

test('hostResolver: concurrent first calls share one lookup; a failing lookup is retried', async () => {
  let calls = 0;
  let release!: (v: string) => void;
  const host = hostResolver(undefined, () => (calls++, new Promise<string>((r) => (release = r))));
  const both = Promise.all([host(), host()]);
  release('gh.example');
  assert.deepEqual(await both, ['gh.example', 'gh.example']);
  assert.equal(calls, 1);

  let tries = 0;
  const flaky = hostResolver(undefined, async () => {
    if (tries++ === 0) throw new Error('no network');
    return 'gh.example';
  });
  assert.equal(await flaky(), 'github.com');
  assert.equal(await flaky(), 'gh.example');
});
