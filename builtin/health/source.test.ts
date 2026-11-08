import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubHostResolver, healthSource, parseMcpList } from './source.ts';

test('parseMcpList reads each state and marks watched servers', () => {
  const out = [
    'Checking MCP server health…',
    '',
    'tracker: https://mcp.example.com/mcp (HTTP) - ✔ Connected',
    'wiki: https://example.test/mcp (HTTP) - ! Needs authentication',
    'slow: npx slow-mcp - ! Connected · tools fetch failed — Request timed out',
    'broken: npx broken-mcp - ✘ Failed to connect — spawn ENOENT',
    'odd: npx odd - ! Something else',
  ].join('\n');
  assert.deepEqual(parseMcpList(out, ['tracker', 'wiki']), [
    { name: 'tracker', state: 'connected', detail: '', watched: true },
    { name: 'wiki', state: 'needs-auth', detail: 'Needs authentication', watched: true },
    { name: 'slow', state: 'connected', detail: 'Connected · tools fetch failed — Request timed out', watched: false },
    { name: 'broken', state: 'failed', detail: 'Failed to connect — spawn ENOENT', watched: false },
    { name: 'odd', state: 'unknown', detail: 'Something else', watched: false },
  ]);
});

test('the source runs the claude and gh checks and lists MCP servers (no TLS check)', async () => {
  const calls: string[] = [];
  const exec = {
    runJson: async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      return { loggedIn: true, authMethod: 'claude.ai' };
    },
    run: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push([cmd, ...args].join(' ') + (opts?.cwd ? ` @${opts.cwd}` : ''));
      if (cmd === 'gh') throw new Error('X\nnot logged in');
      return 'tracker: url - ✔ Connected\n';
    },
  };
  const src = healthSource({ intervalMs: 1000, watchedMcp: ['tracker'], githubHost: 'gh.example', scratchDir: '/tmp/x', exec: exec as never });
  assert.equal(src.id, 'health');
  assert.equal(src.intervalMs, 1000);
  const data = await src.fetch();
  assert.deepEqual(data.checks.map((c) => [c.id, c.ok]), [['claude-auth', true], ['gh-auth', false]]);
  assert.equal(data.checks[1].label, 'GitHub CLI (gh.example)');
  assert.equal(data.checks[1].detail, 'not logged in: run `gh auth login --hostname gh.example`');
  assert.deepEqual(data.mcp, [{ name: 'tracker', state: 'connected', detail: '', watched: true }]);
  assert.ok(calls.includes('claude mcp list @/tmp/x'));
  assert.ok(calls.includes('gh auth status --hostname gh.example'));
});

test('githubHostResolver: a configured host wins; else the github service host, asked on each check; else github.com', async () => {
  assert.equal(githubHostResolver('gh.config', () => ({ host: async () => 'gh.service' })), 'gh.config');
  let service: { host(): Promise<string> } | undefined;
  const r = githubHostResolver(undefined, () => service);
  assert.equal(typeof r, 'function');
  const ask = r as () => Promise<string>;
  assert.equal(await ask(), 'github.com');
  service = { host: async () => 'gh.service' };
  assert.equal(await ask(), 'gh.service');
  service = { host: async () => { throw new Error('gh missing'); } };
  assert.equal(await ask(), 'github.com');
});

test('the gh-auth check uses a resolved host', async () => {
  const calls: string[] = [];
  const exec = {
    runJson: async () => ({ loggedIn: true }),
    run: async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      return '';
    },
  };
  const src = healthSource({ intervalMs: 1000, watchedMcp: [], githubHost: async () => 'gh.lazy', scratchDir: '/tmp/x', exec: exec as never });
  const data = await src.fetch();
  assert.equal(data.checks[1].label, 'GitHub CLI (gh.lazy)');
  assert.ok(calls.includes('gh auth status --hostname gh.lazy'));
});
