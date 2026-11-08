/**
 * Which worktrees a session is bound to. `claude agents` only knows the folder a session was started in, but a session
 * often makes a worktree (`git worktree add`) or moves into one (`cd`, `git -C`) and works there for the rest of its life.
 * Those are found in its transcript: Bash commands that create or point at a folder under the worktrees root, and file
 * edits inside one. Reading a file there doesn't count. Bound worktrees count as "in use" by that session, so they aren't
 * orphaned while it is open, and closing it can remove them (worktreeRoutes.ts `cleanupAfterClose`).
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { normPath } from './platform.ts';
import { findTranscript } from './transcript.ts';
import { config } from '../config.ts';
import { bindSessionWorktree, getScanOffset, setScanOffset } from '../store/sessionWorktrees.ts';
import { getWorkspace } from '../store/workspaces.ts';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Worktree folders (`<root>/<repo>/<name>`) that a Bash command creates or points at. `~` and `$HOME` are expanded. */
export function commandWorktrees(command: string, root: string, home: string): string[] {
  const text = command.replace(/(^|[\s'"=])~\//g, `$1${home}/`).replace(/\$\{?HOME\}?\//g, `${home}/`);
  const dir = `(${escapeRe(root.replace(/\/+$/, ''))}/[^/\\s'"\\\;|&)<>]+/[^/\\s'"\\\;|&)<>]+)`;
  const verb = `(?:\\bcd|\\bpushd|\\s-C|\\bworktree\\s+add(?:\\s+-\\S+(?:\\s+(?!/)\\S+)?)*|--path|--cwd)\\s+["']?`;
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(verb + dir, 'g'))) out.add(m[1]!);
  return [...out];
}

/** The worktree folder a path under the root belongs to, or null. */
export function fileWorktree(file: string, root: string): string | null {
  const r = normPath(root).replace(/\/+$/, '') + '/';
  const f = normPath(file);
  if (!f.startsWith(r)) return null;
  const [a, b, ...rest] = f.slice(r.length).split('/');
  return a && b && rest.length > 0 ? `${r}${a}/${b}` : null;
}

/** The worktrees touched by one chunk of transcript (whole JSONL lines). */
export function chunkWorktrees(chunk: string, root: string, home = homedir()): string[] {
  const out = new Set<string>();
  for (const line of chunk.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let entry: { message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
      if (block?.type !== 'tool_use' || !block.input) continue;
      if (block.name === 'Bash' && typeof block.input.command === 'string') {
        for (const p of commandWorktrees(block.input.command, root, home)) out.add(p);
      } else if (block.name && EDIT_TOOLS.has(block.name)) {
        const f = block.input.file_path ?? block.input.notebook_path;
        const p = typeof f === 'string' ? fileWorktree(f, root) : null;
        if (p) out.add(p);
      }
    }
  }
  return [...out];
}

/** Read the transcript's new complete lines since last time. */
export async function newWorktreeMentions(sessionId: string): Promise<{ paths: string[]; offset: number } | null> {
  const file = await findTranscript(sessionId).catch(() => null);
  if (!file) return null;
  const from = getScanOffset(sessionId);
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const { size } = await fh.stat();
    if (size <= from) return { paths: [], offset: Math.min(from, size) };
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a) + 1; // whole lines only
    return { paths: chunkWorktrees(buf.subarray(0, end).toString('utf8'), config.paths.worktrees), offset: from + end };
  } finally {
    await fh.close();
  }
}

/**
 * Bind a session to the worktrees it created or pointed at since the last scan (any path under the root; whether the
 * workspace records it is checked when the binding is used, so one recorded later still counts). Returns the paths found that
 * the workspace doesn't record yet, for the caller to record if they are real worktrees.
 */
export async function bindFromTranscript(workspaceId: string, sessionId: string): Promise<{ unrecorded: string[] }> {
  const res = await newWorktreeMentions(sessionId);
  if (!res) return { unrecorded: [] };
  const recorded = new Set(getWorkspace(workspaceId)?.worktrees.map((w) => w.path) ?? []);
  for (const p of res.paths) bindSessionWorktree(sessionId, p);
  setScanOffset(sessionId, res.offset);
  return { unrecorded: res.paths.filter((p) => !recorded.has(p)) };
}
