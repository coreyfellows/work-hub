#!/usr/bin/env node
// Claude Code hook (UserPromptSubmit, and PreToolUse throttled): tell a session what changed about its sibling
// sessions since it last heard, from the digest files the work-hub server writes. No HTTP, no tokens when nothing
// changed, never blocks a turn: any problem means exit 0 with no output.
//
// Env (set in the command line the server passes with --settings):
//   WORK_HUB_SESSION_AWARENESS_DIR        the plugin's state folder (digests/, sessions/, seen/)
//   WORK_HUB_SESSION_AWARENESS_NUDGE_MS   PreToolUse checks at most this often (default 300000)
//   WORK_HUB_SESSION_AWARENESS_STALE_MS   live facts older than this are stamped (default 600000)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changeLines, seenDiff } from './changes.mjs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function main() {
  const dir = process.env.WORK_HUB_SESSION_AWARENESS_DIR;
  if (!dir) return;
  const nudgeMs = Number(process.env.WORK_HUB_SESSION_AWARENESS_NUDGE_MS ?? 300_000);
  const staleMs = Number(process.env.WORK_HUB_SESSION_AWARENESS_STALE_MS ?? 600_000);
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }
  const sessionId = input?.session_id;
  const event = input?.hook_event_name ?? 'UserPromptSubmit';
  if (typeof sessionId !== 'string' || !sessionId) return;
  const map = readJson(join(dir, 'sessions', `${sessionId}.json`));
  if (!map?.workspaceId) return;
  const seenPath = join(dir, 'seen', `${sessionId}.json`);
  const seen = readJson(seenPath);
  const now = Date.now();
  if (event === 'PreToolUse' && seen?.checkedAt && now - seen.checkedAt < nudgeMs) return;
  const digest = readJson(join(dir, 'digests', `${map.workspaceId}.json`));
  if (!digest?.blocks) return;
  const versions = Object.fromEntries(digest.blocks.filter((b) => b.sessionId !== sessionId).map((b) => [b.sessionId, b.version]));
  const record = () => writeJson(seenPath, { versions, blocks: digest.blocks, checkedAt: now });
  if (!seen) {
    // First time: the start prompt already carried the digest, so just remember what was in it.
    record();
    return;
  }
  const { changed, gone } = seenDiff(seen.versions, digest.blocks, sessionId);
  if (!changed.length && !gone.length) {
    if (event === 'PreToolUse') writeJson(seenPath, { ...seen, checkedAt: now });
    return;
  }
  const own = digest.blocks.find((b) => b.sessionId === sessionId);
  const self = { sessionId, shortId: own?.shortId ?? sessionId.slice(0, 8) };
  const stale = digest.liveAt == null || now - digest.liveAt > staleMs;
  const lines = changeLines(seen.blocks ?? [], digest.blocks, self, { stale, liveAt: digest.liveAt, now, max: 5 });
  record();
  if (lines.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } }));
}

try {
  main();
} catch {
  /* never fail a turn */
}
process.exit(0);
