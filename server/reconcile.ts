import { stat } from 'node:fs/promises';
import { config } from './config.ts';
import { normPath } from './lib/platform.ts';
import { run } from './lib/exec.ts';
import { findTranscript } from './lib/transcript.ts';
import { bindFromTranscript } from './lib/sessionWorktrees.ts';
import type { Session } from './sources/claude.ts';
import * as workspacesStore from './store/workspaces.ts';
import { addSession, addWorktree, allWorktrees, logEvent, sessionOwners, setWorktreeBranch } from './store/workspaces.ts';

/**
 * Keeps the workspace model in step with what sessions actually do, without relying on them to run `wh`:
 *
 * - A session nobody recorded joins a workspace when a workspace session started it (its transcript has the
 *   `claude attach <id>  open in this terminal` line `claude --bg` prints), or when it runs inside one of a
 *   workspace's recorded worktrees.
 * - A workspace session working in a worktree under the worktrees root gets that worktree recorded, and recorded
 *   worktrees follow branch renames.
 *
 * Deterministic and local (files, sqlite, git), so it runs on every sessions poll. Plugins add passes of their own
 * through `ctx.reconcile.addPass` (the github plugin's links PRs), run after these in registration order, one at a time.
 */

/** Runs after the core's reconcile steps, with what they saw; true = the workspaces changed. */
export type ReconcilePass = (ctx: { sessions: Session[]; store: typeof workspacesStore }) => Promise<boolean>;

const passes: Array<{ fn: ReconcilePass; owner: string }> = [];

/** `owner`: the plugin adding it, for `removeReconcilePasses`. */
export function addReconcilePass(fn: ReconcilePass, owner = 'core'): void {
  passes.push({ fn, owner });
}

/** Drop every pass `owner` added. */
export function removeReconcilePasses(owner: string): void {
  for (let i = passes.length - 1; i >= 0; i--) if (passes[i].owner === owner) passes.splice(i, 1);
}

/** Branches too generic to tie a session to a workspace by name alone. */
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);
const SPAWN_CHECK_EVERY_MS = 60_000;
const SPAWN_CHECK_TRIES = 5;

export interface WorktreeRec {
  workspaceId: string;
  repo: string;
  path: string;
  branch: string | null;
}

/** The workspace owning the deepest recorded worktree containing `cwd`, else a unique repo + branch match. */
export function ownerByCwd(cwd: string, repo: string | null, branch: string | null, worktrees: WorktreeRec[]): string | null {
  const c = normPath(cwd);
  const inside = worktrees.filter((w) => c === normPath(w.path) || c.startsWith(`${normPath(w.path)}/`)).sort((a, b) => b.path.length - a.path.length);
  if (inside.length) return inside[0].workspaceId;
  if (!repo || !branch || SHARED_BRANCHES.has(branch)) return null;
  const byBranch = new Set(worktrees.filter((w) => w.branch === branch && w.repo.toLowerCase() === repo.toLowerCase()).map((w) => w.workspaceId));
  return byBranch.size === 1 ? [...byBranch][0] : null;
}

/**
 * Short ids of sessions started by `claude --bg` in this output: it prints `  claude attach <id>    open in this
 * terminal` on a line of its own. Requiring the whole line skips transcripts that merely quote another one.
 */
export function spawnedIds(output: string): string[] {
  return [...output.matchAll(/^[ \t]*claude attach ([0-9a-f]{8})[ \t]+open in this terminal[ \t]*$/gm)].map((m) => m[1]);
}

/** The Bash outputs carried by one transcript line (the structured result and the message's tool_result text). */
export function toolOutputs(line: string): string[] {
  let entry: { toolUseResult?: { stdout?: unknown }; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (typeof entry.toolUseResult?.stdout === 'string') out.push(entry.toolUseResult.stdout);
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; content?: unknown }>) {
      if (c?.type !== 'tool_result') continue;
      if (typeof c.content === 'string') out.push(c.content);
      else if (Array.isArray(c.content)) for (const p of c.content as Array<{ text?: unknown }>) if (typeof p?.text === 'string') out.push(p.text);
    }
  }
  return out;
}

// --- I/O -----------------------------------------------------------------------------------

const spawnChecks = new Map<string, { at: number; tries: number }>();
const toplevels = new Map<string, string | null>();

async function toplevel(cwd: string): Promise<string | null> {
  if (toplevels.has(cwd)) return toplevels.get(cwd)!;
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).then((s) => s.trim() || null, () => null);
  toplevels.set(cwd, top);
  return top;
}

/**
 * Which workspace session started each orphan: one grep over the transcripts of workspace sessions active since
 * the earliest orphan started, then each hit verified as a whole `claude --bg` output line.
 */
async function findParents(orphans: Session[], owners: Map<string, string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!orphans.length) return found;
  const since = Math.min(...orphans.map((o) => o.startedAt)) - 5 * 60_000;
  const files = new Map<string, string>(); // transcript → workspace
  await Promise.all(
    [...owners].map(async ([sessionId, ws]) => {
      const path = await findTranscript(sessionId).catch(() => null);
      if (!path) return;
      const mtime = await stat(path).then((s) => s.mtimeMs, () => 0);
      if (mtime >= since) files.set(path, ws);
    }),
  );
  if (!files.size) return found;
  const args = ['-F', '-H', ...orphans.flatMap((o) => ['-e', `claude attach ${o.shortId}`]), ...files.keys()];
  const out = await run('grep', args, { timeoutMs: 20_000 }).catch(() => ''); // exit 1 = no match
  const wanted = new Set(orphans.map((o) => o.shortId));
  const hits = new Map<string, Set<string>>(); // shortId → workspaces
  for (const raw of out.split('\n')) {
    const cut = raw.indexOf('.jsonl:');
    if (cut < 0) continue;
    const ws = files.get(raw.slice(0, cut + 6));
    if (!ws) continue;
    for (const text of toolOutputs(raw.slice(cut + 7))) {
      for (const id of spawnedIds(text)) if (wanted.has(id)) (hits.get(id) ?? hits.set(id, new Set()).get(id)!).add(ws);
    }
  }
  for (const o of orphans) {
    const ws = hits.get(o.shortId);
    if (ws?.size === 1) found.set(o.sessionId, [...ws][0]);
  }
  return found;
}

/** One pass. Returns true if anything was recorded (the caller refreshes the workspaces source). */
export async function reconcile(sessions: Session[]): Promise<boolean> {
  let changed = false;
  const owners = sessionOwners();
  let worktrees = allWorktrees();
  const now = Date.now();

  // 1. Orphans: by worktree first (free), then by who started them (a grep, throttled per orphan).
  const orphans = sessions.filter((s) => !owners.has(s.sessionId));
  const toTrace: Session[] = [];
  for (const s of orphans) {
    const ws = ownerByCwd(s.cwd, s.repo, s.branch, worktrees);
    if (ws) {
      addSession(ws, { claudeSessionId: s.sessionId, role: 'main', name: s.name, cwd: s.cwd });
      logEvent(ws, 'session-adopted', `${s.shortId} ${s.name}: runs in this workspace's worktree`);
      owners.set(s.sessionId, ws);
      changed = true;
      continue;
    }
    const c = spawnChecks.get(s.sessionId);
    if (!c || (c.tries < SPAWN_CHECK_TRIES && now - c.at >= SPAWN_CHECK_EVERY_MS)) {
      spawnChecks.set(s.sessionId, { at: now, tries: (c?.tries ?? 0) + 1 });
      toTrace.push(s);
    }
  }
  const parents = await findParents(toTrace, owners).catch(() => new Map<string, string>());
  for (const s of toTrace) {
    const ws = parents.get(s.sessionId);
    if (!ws || owners.has(s.sessionId)) continue;
    addSession(ws, { claudeSessionId: s.sessionId, role: 'main', name: s.name, cwd: s.cwd });
    logEvent(ws, 'session-adopted', `${s.shortId} ${s.name}: started by a session in this workspace`);
    owners.set(s.sessionId, ws);
    spawnChecks.delete(s.sessionId);
    changed = true;
  }

  // 2. Worktrees workspace sessions work in: record new ones under the worktrees root, follow branch renames.
  const root = normPath(config.paths.worktrees).replace(/\/+$/, '');
  for (const s of sessions) {
    const ws = owners.get(s.sessionId);
    if (!ws || !s.repo || !normPath(s.cwd).startsWith(`${root}/`)) continue;
    const top = await toplevel(s.cwd);
    if (!top || !normPath(top).startsWith(`${root}/`)) continue;
    const rec = worktrees.find((w) => normPath(w.path) === normPath(top));
    if (!rec) {
      addWorktree(ws, { repo: s.repo, path: top, branch: s.branch });
      changed = true;
      worktrees = allWorktrees();
    } else if (s.branch && rec.branch !== s.branch) {
      setWorktreeBranch(top, s.branch);
      rec.branch = s.branch;
      changed = true;
    }
  }

  // 2b. Worktrees a session made or moved into (found in its transcript) are bound to it, wherever it started; ones nothing
  // records yet become the workspace's (the repo is the session's own: a different repo's worktree is left for `wh`).
  for (const s of sessions) {
    const ws = owners.get(s.sessionId);
    if (!ws) continue;
    const { unrecorded } = await bindFromTranscript(ws, s.sessionId).catch(() => ({ unrecorded: [] as string[] }));
    for (const p of unrecorded) {
      if (!s.repo || worktrees.some((w) => w.path === p)) continue;
      // Not `toplevel()`: it caches, and the folder may not have existed yet when the command was first seen.
      const top = await run('git', ['-C', p, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).then((o) => o.trim(), () => '');
      if (top !== p) continue;
      const branch = await run('git', ['-C', p, 'branch', '--show-current'], { timeoutMs: 10_000 }).then((o) => o.trim() || null, () => null);
      addWorktree(ws, { repo: s.repo, path: p, branch });
      changed = true;
      worktrees = allWorktrees();
    }
  }

  // 3+. Plugins' reconcile passes (e.g. PR linking), in registration order. A failing pass is logged; the others still run.
  for (const { fn, owner } of passes) {
    try {
      if (await fn({ sessions, store: workspacesStore })) changed = true;
    } catch (e) {
      console.error(`reconcile pass (${owner}):`, e);
    }
  }
  return changed;
}
