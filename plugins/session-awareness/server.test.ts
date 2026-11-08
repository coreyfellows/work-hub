import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { PromptContext, PromptFragmentFn, PromptFragmentKind, ServerPluginContext, Session, Workspace } from '../../plugin-api/server.ts';
import register from './server.ts';

const now = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(25);
  }
}

const live = (id: string, status = 'idle'): Session =>
  ({ sessionId: id, shortId: id.slice(0, 8), name: id, cwd: `/w/hub/${id}`, kind: 'background', status, rawStatus: null, promptState: null, waitingFor: null, needsInput: false, background: 0, unread: false, questionId: null, detail: null, intent: null, startedAt: now - 1000, lastActiveAt: null, pid: null, branch: null, repo: null }) as Session;

const workspace = (id: string, sessionIds: string[], status = 'active'): Workspace =>
  ({
    id,
    title: id,
    origin: 'prompt',
    ticketKey: null,
    prompt: null,
    epicKey: null,
    epicTitle: null,
    epicCheckedAt: null,
    status,
    notes: null,
    createdAt: '',
    updatedAt: '',
    worktrees: [],
    sessions: sessionIds.map((s, i) => ({ id: i, claudeSessionId: s, shortId: s.slice(0, 8), role: 'main', name: s, cwd: `/w/hub/${s}` })),
    views: [],
    links: [],
    events: [],
  }) as Workspace;

function fakeCtx(over: { config?: Record<string, unknown>; workspaces?: Workspace[] } = {}) {
  const app = new Hono();
  const listeners = new Map<string, Array<(p: unknown) => void>>();
  const fragments = new Map<PromptFragmentKind, PromptFragmentFn[]>();
  const starts: Array<() => void | Promise<void>> = [];
  const launchArgs: Array<(info: { cwd: string; purpose: string }) => string[] | Promise<string[]>> = [];
  let workspaces = over.workspaces ?? [workspace('ws', ['uuid-aaaa', 'uuid-bbbb']), workspace('solo', ['uuid-cccc'])];
  const pluginState = mkdtempSync(join(tmpdir(), 'sa-state-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'sa-hub-'));
  const noop = () => {};
  const ctx = {
    id: 'session-awareness',
    app,
    pluginDir: '/repo/plugins/session-awareness',
    paths: { pluginState, stateDir, whCommand: '/repo/bin/wh' },
    config: { get: (k: string, d: unknown) => (k in (over.config ?? {}) ? over.config![k] : d) },
    events: {
      on: (name: string, fn: (p: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
        return noop;
      },
      emit: (name: string, p: unknown) => (listeners.get(name) ?? []).forEach((fn) => fn(p)),
    },
    prompts: {
      addFragment: (kind: PromptFragmentKind, fn: PromptFragmentFn) => fragments.set(kind, [...(fragments.get(kind) ?? []), fn]),
    },
    sessions: {
      list: () => [live('uuid-aaaa', 'working'), live('uuid-bbbb'), live('uuid-cccc')],
      boundWorktrees: () => [],
      sessionEdits: async () => null,
      addLaunchArgs: (fn: (typeof launchArgs)[number]) => launchArgs.push(fn),
    },
    store: {
      getWorkspace: (id: string) => workspaces.find((w) => w.id === id) ?? null,
      listWorkspaces: () => workspaces.filter((w) => w.status !== 'done'),
      listEvents: () => [],
    },
    services: { get: () => undefined },
    exec: { run: async () => { throw new Error('no git in tests'); } },
    git: { baseRef: async () => null },
    revalidate: noop,
    onStart: (fn: () => void | Promise<void>) => starts.push(fn),
    registry: { on: noop },
    log: { info: noop, warn: noop, error: noop },
  };
  return {
    ctx: ctx as unknown as ServerPluginContext,
    app,
    pluginState,
    emit: ctx.events.emit,
    fragment: (kind: PromptFragmentKind, c: PromptContext) => (fragments.get(kind) ?? []).map((f) => f(c) ?? '').join('\n'),
    start: async () => { for (const s of starts) await s(); },
    launchArgs,
    setWorkspaces: (w: Workspace[]) => { workspaces = w; },
  };
}

const get = (app: Hono, path: string) => app.request(`http://h${path}`);

test('GET digest is 404 before a build and 200 with blocks after a workspace-event; a done workspace loses its digest', async () => {
  const f = fakeCtx({ config: { rebuildDebounceMs: 20 } });
  register(f.ctx);
  assert.equal((await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status, 404);
  f.emit('workspace-event', { workspaceId: 'ws', type: 'claim', detail: 'x', sessionId: 'uuid-aaaa' });
  await until(async () => (await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status === 200);
  const r = await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest');
  assert.equal(r.status, 200);
  const d = (await r.json()) as { blocks: Array<{ sessionId: string }> };
  assert.deepEqual(d.blocks.map((b) => b.sessionId).sort(), ['uuid-aaaa', 'uuid-bbbb']);

  f.setWorkspaces([workspace('ws', ['uuid-aaaa', 'uuid-bbbb'], 'done')]);
  f.emit('workspace-event', { workspaceId: 'ws', type: 'status', detail: 'done', sessionId: null });
  await until(async () => (await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status === 404);
  assert.equal((await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status, 404);
});

test('source-changed for claude rebuilds every workspace and dates the live facts', async () => {
  const f = fakeCtx({ config: { rebuildDebounceMs: 20 } });
  register(f.ctx);
  f.emit('source-changed', { id: 'claude' });
  await until(async () => (await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status === 200);
  const d = (await (await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).json()) as { liveAt: number | null };
  assert.ok(d.liveAt && d.liveAt >= now, 'liveAt is set once the claude source has changed');
});

test('session-context fragment is empty for a workspace with one session and holds the heading with two', async () => {
  const f = fakeCtx({ config: { rebuildDebounceMs: 20 } });
  register(f.ctx);
  f.emit('session-started', { shortId: 'x', sessionId: 'x', cwd: '/w', name: '', purpose: 'manual' });
  await until(async () => (await get(f.app, '/api/plugins/session-awareness/workspaces/solo/digest')).status === 200);
  // the starting session isn't in the digest yet, so even a one-session workspace has a sibling to show
  assert.ok(f.fragment('session-context', { workspaceId: 'solo' }).includes('**uuid-ccc**'));
  const two = f.fragment('session-context', { workspaceId: 'ws' });
  assert.match(two, /^## Other sessions in this workspace\n/);
  assert.ok(two.includes('**uuid-aaa**') && two.includes('**uuid-bbb**'));
  assert.equal(f.fragment('session-context', { workspaceId: 'unknown' }), '');
});

test('startPrompt=false adds no session-context', async () => {
  const f = fakeCtx({ config: { rebuildDebounceMs: 20, startPrompt: false } });
  register(f.ctx);
  f.emit('workspace-event', { workspaceId: 'ws', type: 'claim', detail: 'x', sessionId: 'uuid-aaaa' });
  await until(async () => (await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status === 200);
  assert.equal(f.fragment('session-context', { workspaceId: 'ws' }), '');
});

test('workspace-rules fragment names wh claim, wh done and team.sh with the state folder', () => {
  const f = fakeCtx();
  register(f.ctx);
  const rules = f.fragment('workspace-rules', { workspaceId: 'ws' });
  assert.ok(rules.includes('`/repo/bin/wh claim <ws>'), rules);
  assert.ok(rules.includes('`/repo/bin/wh done <ws>'), rules);
  assert.ok(rules.includes(`WORK_HUB_SESSION_AWARENESS_DIR=${f.pluginState} /repo/plugins/session-awareness/claude/scripts/team.sh <ws>`), rules);
});

test('app-started sessions get the hook through --settings, pointed at the plugin state folder', async () => {
  const f = fakeCtx({ config: { nudgeIntervalMs: 0 } });
  register(f.ctx);
  assert.equal(f.launchArgs.length, 1);
  const args = await f.launchArgs[0]({ cwd: '/w', purpose: 'new-session' });
  assert.equal(args[0], '--settings');
  const s = JSON.parse(args[1]) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.deepEqual(Object.keys(s.hooks), ['UserPromptSubmit']);
  assert.ok(s.hooks.UserPromptSubmit[0].hooks[0].command.includes(`WORK_HUB_SESSION_AWARENESS_DIR='${f.pluginState}'`));
  assert.ok(s.hooks.UserPromptSubmit[0].hooks[0].command.endsWith("'/repo/plugins/session-awareness/claude/hooks/awareness.mjs'"));
});

test('the digest route only serves ids that are workspaces: a traversal-shaped id is a 404 and reads no file', async () => {
  const f = fakeCtx({ config: { rebuildDebounceMs: 20 } });
  register(f.ctx);
  // a file a traversal would reach: <pluginState>/../secret.json
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(f.pluginState, '..', 'sa-secret.json'), '{"secret":true}');
  const r = await get(f.app, '/api/plugins/session-awareness/workspaces/..%2F..%2Fsa-secret/digest');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'no digest' });
  assert.equal((await get(f.app, '/api/plugins/session-awareness/workspaces/not-a-workspace/digest')).status, 404);
});

test('the digest on disk follows liveAt once it has moved by more than a minute, even when no block changed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000_000_000 });
  const f = fakeCtx({ config: { rebuildDebounceMs: 20 } });
  register(f.ctx);
  const { readFileSync } = await import('node:fs');
  const fileLiveAt = () => (JSON.parse(readFileSync(join(f.pluginState, 'digests', 'ws.json'), 'utf8')) as { liveAt: number }).liveAt;
  const settle = () => new Promise((r) => setTimeout(r, 200));
  f.emit('source-changed', { id: 'claude' });
  await settle();
  assert.equal(fileLiveAt(), 2_000_000_000_000);
  t.mock.timers.setTime(2_000_000_030_000);
  f.emit('source-changed', { id: 'claude' });
  await settle();
  assert.equal(fileLiveAt(), 2_000_000_000_000, 'under a minute: not rewritten');
  t.mock.timers.setTime(2_000_000_070_000);
  f.emit('source-changed', { id: 'claude' });
  await settle();
  assert.equal(fileLiveAt(), 2_000_000_070_000, 'more than a minute since the last write: rewritten');
});

test('the session-context fragment leaves out excludeSessionId (a handoff passes the session it replaces)', async () => {
  const f = fakeCtx({ config: { rebuildDebounceMs: 20 } });
  register(f.ctx);
  f.emit('workspace-event', { workspaceId: 'ws', type: 'claim', detail: 'x', sessionId: 'uuid-aaaa' });
  await until(async () => (await get(f.app, '/api/plugins/session-awareness/workspaces/ws/digest')).status === 200);
  const md = f.fragment('session-context', { workspaceId: 'ws', excludeSessionId: 'uuid-aaaa' });
  assert.ok(md.includes('**uuid-bbb**') && !md.includes('**uuid-aaa**'), md);
});
