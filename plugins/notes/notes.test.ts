import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { ServerPluginContext, Workspace } from '../../plugin-api/server.ts';
import { createNotes, notePage } from './notes.ts';
import register from './server.ts';

const ws = (over: Partial<Workspace> = {}): Workspace =>
  ({ id: 'fix-login', title: 'Fix login', origin: 'prompt', ticketKey: null, prompt: 'Fix the\nlogin', status: 'active', worktrees: [], sessions: [], links: [], ...over }) as Workspace;

test('note pages: tickets/<KEY> for ticket workspaces, workspaces/<id> otherwise; URLs encode each segment', async () => {
  assert.equal(notePage({ id: 'x', ticketKey: 'tkt-12' }), 'tickets/TKT-12');
  assert.equal(notePage({ id: 'a b', ticketKey: null }), 'workspaces/a b');
  const notes = createNotes({ notesDir: '/n', url: '/notes', scriptsDir: '/s', run: async () => '' });
  assert.deepEqual(await notes.noteInfo({ id: 'a b', ticketKey: null }), {
    page: 'workspaces/a b',
    path: '/n/workspaces/a b.md',
    url: '/notes/workspaces/a%20b',
    exists: false,
  });
});

test('ensureNote writes the skeleton for a non-ticket workspace, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const notes = createNotes({ notesDir: dir, url: '/notes', scriptsDir: '/s', run: async () => assert.fail('no script for non-ticket') });
  const w = ws({ worktrees: [{ id: 1, repo: 'o/r', path: '/wt/r', branch: 'b', baseBranch: null }] as Workspace['worktrees'] });
  const info = await notes.ensureNote(w);
  assert.equal(info.exists, true);
  const body = readFileSync(join(dir, 'workspaces/fix-login.md'), 'utf8');
  assert.match(body, /^---\ntags: workspace\nworkspace: fix-login\nworktree: \/wt\/r\ncreated: \d{4}-\d\d-\d\d\n---\n# Fix login\n\n> Fix the\n> login\n\n## Scripts/);
  await notes.ensureNote(w); // exists: left alone
  assert.equal(readFileSync(join(dir, 'workspaces/fix-login.md'), 'utf8'), body);
});

test('ensureNote runs ensure-ticket-note.sh for a ticket workspace', async () => {
  const calls: unknown[] = [];
  const notes = createNotes({ notesDir: '/nowhere', url: '/notes', scriptsDir: '/s', run: async (...a) => void calls.push(a) });
  await notes.ensureNote(ws({ ticketKey: 'TKT-1', title: 'TKT-1: Fix it', worktrees: [{ path: '/wt/x' }] as Workspace['worktrees'] }));
  assert.deepEqual(calls, [['/s/ensure-ticket-note.sh', ['TKT-1', '--path-only', '--title', 'Fix it', '--worktree', '/wt/x'], { timeoutMs: 15_000 }]]);
});

/** register() against a fake context: the store, events and prompt fragments are in-memory. */
function fakeCtx(dir: string, store: Map<string, Workspace>) {
  const listeners: Array<(e: { workspaceId: string; type: string; detail: string | null }) => void> = [];
  const fragments: Array<(c: Record<string, unknown>) => string | null | undefined> = [];
  const events: Array<[string, string, string | undefined]> = [];
  const settings: Record<string, unknown> = { notesDir: dir, url: '/notes' };
  const ctx = {
    app: new Hono(),
    config: { get: (k: string, d: unknown) => settings[k] ?? d },
    exec: { run: async () => '' },
    paths: { ticketWorkflowScripts: '/s' },
    services: { expose: () => {} },
    prompts: { addFragment: (_k: string, fn: (typeof fragments)[number]) => void fragments.push(fn) },
    events: { on: (_n: string, fn: (typeof listeners)[number]) => void listeners.push(fn) },
    store: {
      getWorkspace: (id: string) => store.get(id) ?? null,
      logEvent: (id: string, type: string, detail?: string) => void events.push([id, type, detail]),
    },
  } as unknown as ServerPluginContext;
  register(ctx);
  const emit = (workspaceId: string, type: string) => listeners.forEach((l) => l({ workspaceId, type, detail: null }));
  return { ctx, emit, fragments, events };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('a new workspace gets its note from the created event; a PR workspace waits for its worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const store = new Map([
    ['a', ws({ id: 'a' })],
    ['p', ws({ id: 'p', origin: 'pr' })],
  ]);
  const { emit, events } = fakeCtx(dir, store);
  emit('a', 'created');
  emit('p', 'created');
  await tick();
  assert.equal(existsSync(join(dir, 'workspaces/a.md')), true);
  assert.equal(existsSync(join(dir, 'workspaces/p.md')), false, 'the PR workspace waits for its worktree');
  store.set('p', ws({ id: 'p', origin: 'pr', worktrees: [{ path: '/wt/p' }] as Workspace['worktrees'] }));
  emit('p', 'worktree');
  await tick();
  assert.match(readFileSync(join(dir, 'workspaces/p.md'), 'utf8'), /worktree: \/wt\/p/);
  assert.deepEqual(events, [
    ['a', 'note', 'workspaces/a'],
    ['p', 'note', 'workspaces/p'],
  ]);
});

test('the session-context fragment names the note only once it exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const { fragments, emit } = fakeCtx(dir, new Map([['a', ws({ id: 'a' })]]));
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0]({ workspaceId: 'a', ticketKey: null }), null);
  emit('a', 'created');
  await tick();
  assert.equal(fragments[0]({ workspaceId: 'a', ticketKey: null }), `- Its note (scripts, manual steps, context): ${join(dir, 'workspaces/a.md')}`);
});

test('routes: GET the note, POST creates it, 404 for an unknown workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const { ctx } = fakeCtx(dir, new Map([['a', ws({ id: 'a' })]]));
  assert.equal((await ctx.app.request('/api/plugins/notes/workspaces/nope')).status, 404);
  assert.equal(((await (await ctx.app.request('/api/plugins/notes/workspaces/a')).json()) as { exists: boolean }).exists, false);
  const made = (await (await ctx.app.request('/api/workspaces/a/note', { method: 'POST' })).json()) as { exists: boolean; url: string };
  assert.deepEqual([made.exists, made.url], [true, '/notes/workspaces/a']);
});

test('without the ticket-workflow scripts a ticket note gets the skeleton made here', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const calls: unknown[] = [];
  const notes = createNotes({ notesDir: dir, url: '/notes', scriptsDir: '', run: async (...a) => void calls.push(a) });
  const info = await notes.ensureNote(ws({ id: 'w', ticketKey: 'TKT-2', title: 'TKT-2: Fix' }));
  assert.equal(calls.length, 0);
  assert.equal(info.exists, true);
  assert.equal(info.path, join(dir, 'tickets/TKT-2.md'));
  assert.match(readFileSync(info.path, 'utf8'), /^---\ntags: ticket\nticket: TKT-2\nworkspace: w\n/);
});
