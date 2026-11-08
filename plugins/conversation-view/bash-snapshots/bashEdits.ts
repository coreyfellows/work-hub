import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDiff, run } from '../../../plugin-api/server.ts';
import type { FileEdit } from '../../../plugin-api/server.ts';

/**
 * File changes made by Bash commands (sed -i, python, formatters…), which the transcript doesn't record.
 * `claude/hooks/bash-snapshot.sh` (a Claude Code Pre/PostToolUse hook) snapshots the git working tree of the command's
 * cwd before and after as tree objects; this diffs the two and turns each hunk into the same old/new pair an Edit
 * call carries, so the log draws them with the same diff cards. Only files inside that repo are seen.
 */

const MAX_FILES = 20;
const MAX_DIFF = 400_000;

interface Snap {
  top?: string;
  before?: string;
  after?: string;
  head?: string;
  headAfter?: string;
}

/**
 * The changes Bash call `toolUseId` made: an array (possibly empty) once known, or null while the after-snapshot
 * isn't there yet (caller retries). No snapshot at all (no hook, not a git repo) → [].
 */
export async function bashEdits(snapDir: string, sessionId: string, toolUseId: string, at: string | null): Promise<FileEdit[] | null> {
  if (!/^[\w-]+$/.test(sessionId) || !/^[\w-]+$/.test(toolUseId)) return [];
  let snap: Snap;
  try {
    snap = JSON.parse(await readFile(join(snapDir, sessionId, `${toolUseId}.json`), 'utf8')) as Snap;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  if (!snap.after) return null;
  const sha = /^[0-9a-f]{40,64}$/;
  if (!snap.top || !snap.before || !sha.test(snap.before) || !sha.test(snap.after)) return [];
  if (snap.before === snap.after) return [];
  // HEAD moved (checkout, pull, merge, rebase, reset): that's history, not an edit, so don't show it as one.
  if ((snap.head ?? '') !== (snap.headAfter ?? '')) return [];
  let diff: string;
  try {
    diff = await run('git', ['-C', snap.top, 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U2', snap.before, snap.after], {
      timeoutMs: 10_000,
    });
  } catch {
    return [];
  }
  if (diff.length > MAX_DIFF) return [];
  return parseDiff(diff, snap.top, at).slice(0, MAX_FILES);
}
