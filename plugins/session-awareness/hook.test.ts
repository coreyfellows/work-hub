import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Digest } from './digest.ts';

const HOOK = join(import.meta.dirname, 'claude', 'hooks', 'awareness.mjs');

function run(dir: string, stdin: string | null, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, WORK_HUB_SESSION_AWARENESS_DIR: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    if (stdin == null) p.stdin.end();
    else p.stdin.end(stdin);
  });
}

const block = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  shortId: sessionId.slice(0, 8),
  name: 'N',
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
  version: `v-${sessionId}-${JSON.stringify(over)}`,
  ...over,
});

function state(blocks: unknown[], liveAt: number | null = Date.now()): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-hook-'));
  mkdirSync(join(dir, 'digests'));
  mkdirSync(join(dir, 'sessions'));
  const d = { workspaceId: 'ws', builtAt: Date.now(), liveAt, blocks } as unknown as Digest;
  writeFileSync(join(dir, 'digests', 'ws.json'), JSON.stringify(d));
  writeFileSync(join(dir, 'sessions', 'uuid-self.json'), JSON.stringify({ workspaceId: 'ws' }));
  return dir;
}
const setBlocks = (dir: string, blocks: unknown[], liveAt: number | null = Date.now()) =>
  writeFileSync(join(dir, 'digests', 'ws.json'), JSON.stringify({ workspaceId: 'ws', builtAt: Date.now(), liveAt, blocks }));
const input = (event: string) => JSON.stringify({ session_id: 'uuid-self', hook_event_name: event, cwd: '/w' });
const context = (out: string) => (out.trim() ? (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput : null);

test('first run seeds silently (the start prompt already had the digest); a sibling change afterwards is reported once', async () => {
  const dir = state([block('uuid-self'), block('uuid-aaaa', { claim: 'a' })]);
  const first = await run(dir, input('UserPromptSubmit'));
  assert.equal(first.code, 0);
  assert.equal(first.out, '', 'nothing on the first run');
  const seen = JSON.parse(readFileSync(join(dir, 'seen', 'uuid-self.json'), 'utf8')) as { versions: Record<string, string> };
  assert.ok(seen.versions['uuid-aaaa'] && !seen.versions['uuid-self']);

  setBlocks(dir, [block('uuid-self'), block('uuid-aaaa', { claim: 'b' })]);
  const second = await run(dir, input('UserPromptSubmit'));
  const ctx = context(second.out);
  assert.equal(ctx?.hookEventName, 'UserPromptSubmit');
  assert.equal(ctx?.additionalContext, 'work-hub: session uuid-aaa "N" is now responsible for: b.');
  const third = await run(dir, input('UserPromptSubmit'));
  assert.equal(third.out, '', 'reported once');
});

test('PreToolUse within the nudge interval prints nothing even when changed; after it, prints', async () => {
  const dir = state([block('uuid-self'), block('uuid-aaaa', { claim: 'a' })]);
  await run(dir, input('UserPromptSubmit'));
  setBlocks(dir, [block('uuid-self'), block('uuid-aaaa', { claim: 'b' })]);
  const throttled = await run(dir, input('PreToolUse'), { WORK_HUB_SESSION_AWARENESS_NUDGE_MS: '300000' });
  assert.equal(throttled.out, '');
  const due = await run(dir, input('PreToolUse'), { WORK_HUB_SESSION_AWARENESS_NUDGE_MS: '0' });
  assert.equal(context(due.out)?.hookEventName, 'PreToolUse');
  assert.match(context(due.out)!.additionalContext, /responsible for: b/);
});

test('no stdin, bad JSON, unknown session, missing digest or missing dir: exit 0, empty stdout, quickly', async () => {
  const dir = state([block('uuid-self'), block('uuid-aaaa')]);
  for (const [label, r] of [
    ['no stdin', await run(dir, null)],
    ['bad json', await run(dir, 'nope')],
    ['unknown session', await run(dir, JSON.stringify({ session_id: 'uuid-other', hook_event_name: 'UserPromptSubmit' }))],
    ['missing dir', await run(join(dir, 'nope'), input('UserPromptSubmit'))],
  ] as const) {
    assert.equal(r.code, 0, label);
    assert.equal(r.out, '', label);
    assert.ok(r.ms < 2000, `${label}: ${r.ms}ms`);
  }
  writeFileSync(join(dir, 'digests', 'ws.json'), '');
  const gone = await run(dir, input('UserPromptSubmit'));
  assert.equal(gone.code, 0);
  assert.equal(gone.out, '');
});
