import { createHash } from 'node:crypto';
import { cleanPath, within } from './paths.ts';

/**
 * The workspace digest: one block per open session, built from facts (no model, no transcripts) and rendered as
 * Markdown for prompts and nudges. Pure: everything comes in through `DigestInput`, so it is unit tested with fixtures.
 */

export interface DigestInput {
  workspaceId: string;
  /** ms */
  now: number;
  /** When status and PR facts were last refreshed (the `claude` source changed); null = never. */
  liveAt: number | null;
  sessions: Array<{
    sessionId: string;
    shortId: string;
    name: string | null;
    role: string;
    /** Normalised: working | idle | needs-input | failed | … */
    status: string;
    intent: string | null;
    startedAt: number;
    lastActiveAt: number | null;
    branch: string | null;
    repo: string | null;
  }>;
  /** sessionId → worktrees (the one it started in first, then the ones it is bound to). */
  worktrees: Record<string, Array<{ path: string; repo: string | null; branch: string | null; baseBranch: string | null }>>;
  /** claim / done events (any order; sorted here). */
  events: Array<{ at: string; type: string; detail: string | null; sessionId: string | null }>;
  prs: Array<{ number: number; title: string; url: string; repo: string; branch: string; isDraft: boolean; checks: string | null }>;
  /** worktree path → up to 3 commits on the branch, newest first. */
  commits: Record<string, Array<{ sha: string; subject: string }>>;
  /** sessionId → files it edited (absolute paths). */
  edits: Record<string, Array<{ path: string; at: number | null }>>;
  maxBlockChars: number;
  maxDigestChars: number;
  /** Two sessions' edits of one file count as an overlap only when both are this recent. */
  overlapWindowMs: number;
}

export interface Block {
  sessionId: string;
  shortId: string;
  name: string | null;
  role: string;
  status: string;
  /** Time buckets (not part of `version`). */
  started: string;
  active: string | null;
  intent: string | null;
  claim: string | null;
  done: string[];
  worktree: { path: string; branch: string | null; base: string | null } | null;
  prs: Array<{ number: number; title: string; url: string; state: 'draft' | 'open'; checks: string | null }>;
  commits: Array<{ sha: string; subject: string }>;
  files: Array<{ path: string; alsoBy: string[] }>;
  /** A hash of the block's facts: readers compare it to know whether anything changed. */
  version: string;
}

export interface Digest {
  workspaceId: string;
  builtAt: number;
  liveAt: number | null;
  blocks: Block[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Coarse "how long ago" buckets, so a block's text (and version) doesn't change every minute. */
export function bucket(ms: number, now: number): string {
  const d = now - ms;
  if (d < MIN) return 'just now';
  if (d < 5 * MIN) return '5m';
  if (d < 30 * MIN) return '30m';
  if (d < 2 * HOUR) return '2h';
  if (d < 24 * HOUR) return 'today';
  return 'older';
}

/** Exact-ish "2h", "35m", "3d" for the stale stamp. */
export function agoLabel(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const when = (b: string) => (b === 'just now' ? 'just now' : b === 'today' ? 'today' : b === 'older' ? 'more than a day ago' : `~${b} ago`);

const CHECKS: Record<string, string> = { SUCCESS: 'checks passing', FAILURE: 'checks failing', ERROR: 'checks failing', PENDING: 'checks pending', EXPECTED: 'checks pending' };

const STATUS_RANK: Record<string, number> = { working: 0, 'needs-input': 1, idle: 2, failed: 4 };

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** One line, at most `n` characters (an ellipsis when cut); null for nothing. */
function clip(s: string | null | undefined, n: number): string | null {
  const line = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length <= n ? line : `${line.slice(0, n - 1).trimEnd()}…`;
}

/**
 * A session's intent as one short line. An app-started session's intent is its whole start prompt (the workspace
 * context, then "Your task:" and the task): keep the task's first paragraph; otherwise the first non-empty line.
 */
function intentLine(intent: string | null): string | null {
  if (!intent) return null;
  const m = intent.match(/\n\s*Your task:\s*\n+([^\n]+)/);
  const first = (m ? m[1] : intent).split('\n').find((l) => l.trim()) ?? '';
  return clip(first, 160);
}

/** `/w/hub/x/server/a.ts` under `/w/hub/x` → `server/a.ts`; elsewhere → the last two segments. */
function relPath(abs: string, worktree: string | null): string {
  const p = cleanPath(abs);
  if (worktree && within(p, worktree)) return p.slice(cleanPath(worktree).length).replace(/^\/+/, '') || '.';
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

export function buildDigest(input: DigestInput): Digest {
  const { now } = input;
  const events = [...input.events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // Per session: distinct edited files (newest first) with an overlap key (repo + relative path inside a worktree, else the absolute path).
  const edited = new Map<string, Array<{ abs: string; rel: string; key: string; at: number | null }>>();
  for (const s of input.sessions) {
    const wt = input.worktrees[s.sessionId]?.[0] ?? null;
    const seen = new Set<string>();
    const list = [...(input.edits[s.sessionId] ?? [])]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .map((e) => ({ ...e, path: cleanPath(e.path) }))
      .filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)))
      .map((e) => {
        const inside = !!wt && within(e.path, wt.path);
        const rel = relPath(e.path, wt?.path ?? null);
        return { abs: e.path, rel, key: inside ? `${lower(wt!.repo)}:${rel}` : e.path, at: e.at };
      });
    edited.set(s.sessionId, list);
  }
  const recent = (at: number | null) => at == null || now - at <= input.overlapWindowMs;

  const blocks: Block[] = input.sessions.map((s) => {
    const wts = input.worktrees[s.sessionId] ?? [];
    const wt = wts[0] ?? null;
    const repo = wt?.repo ?? s.repo;
    const branch = wt?.branch ?? s.branch;
    const mine = events.filter((e) => e.sessionId === s.sessionId);
    const claim = clip(mine.find((e) => e.type === 'claim' && e.detail)?.detail, 160);
    const done = mine.filter((e) => e.type === 'done' && e.detail).slice(0, 3).map((e) => clip(e.detail, 160)!);
    const prs = branch
      ? input.prs
          .filter((p) => p.branch === branch && (!repo || lower(p.repo) === lower(repo)))
          .map((p) => ({ number: p.number, title: clip(p.title, 80) ?? '', url: p.url, state: p.isDraft ? ('draft' as const) : ('open' as const), checks: p.checks }))
      : [];
    const commits = wt ? (input.commits[wt.path] ?? []).slice(0, 3).map((c) => ({ sha: c.sha, subject: clip(c.subject, 80) ?? '' })) : [];
    const files = (edited.get(s.sessionId) ?? []).slice(0, 8).map((f) => ({
      path: f.rel,
      alsoBy: recent(f.at)
        ? input.sessions
            .filter((o) => o.sessionId !== s.sessionId && (edited.get(o.sessionId) ?? []).some((g) => g.key === f.key && recent(g.at)))
            .map((o) => o.shortId)
        : [],
    }));
    const block: Block = {
      sessionId: s.sessionId,
      shortId: s.shortId,
      name: clip(s.name, 80),
      role: s.role,
      status: s.status,
      started: bucket(s.startedAt, now),
      active: s.lastActiveAt == null ? null : bucket(s.lastActiveAt, now),
      intent: intentLine(s.intent),
      claim,
      done,
      worktree: wt ? { path: wt.path, branch: wt.branch, base: wt.baseBranch } : null,
      prs,
      commits,
      files,
      version: '',
    };
    fitBlock(block, input.maxBlockChars, now);
    return block;
  });

  // The whole digest: drop the cheapest details from every block until it fits.
  const total = () => blocks.reduce((n, b) => n + renderBlock(b, { stale: false, liveAt: null, now }).length, 0);
  for (const strip of [(b: Block) => (b.files = []), (b: Block) => (b.commits = []), (b: Block) => (b.done = [])]) {
    if (total() <= input.maxDigestChars) break;
    blocks.forEach(strip);
  }
  for (const b of blocks) b.version = versionOf(b);
  return { workspaceId: input.workspaceId, builtAt: now, liveAt: input.liveAt, blocks };
}

/**
 * Trim one block to the cap: oldest dones, then commits, then the intent (the name and claim already say what the
 * session is for), then files (the overlap signal, kept longest). The identity line always stays.
 */
function fitBlock(b: Block, max: number, now: number): void {
  const len = () => renderBlock(b, { stale: false, liveAt: null, now }).length;
  while (len() > max) {
    if (b.done.length) b.done.pop();
    else if (b.commits.length) b.commits.pop();
    else if (b.intent) b.intent = null;
    else if (b.files.length) b.files.pop();
    else break;
  }
}

function versionOf(b: Block): string {
  const { version: _v, started: _s, active: _a, ...facts } = b;
  return createHash('sha1').update(JSON.stringify(facts)).digest('hex').slice(0, 10);
}

export function renderBlock(b: Block, opts: { stale: boolean; liveAt: number | null; now: number }): string {
  const head = `- **${b.shortId}**${b.name ? ` "${b.name}"` : ''} (${b.role}): ${b.status}, started ${when(b.started)}${b.active ? `, last active ${when(b.active)}` : ''}`;
  const lines = [head];
  const sub = (s: string) => lines.push(`  - ${s}`);
  if (b.intent) sub(`intent: ${b.intent}`);
  if (b.claim) sub(`responsible for: ${b.claim}`);
  if (b.done.length) sub(`done: ${b.done.join('; ')}`);
  if (b.worktree) sub(`worktree: ${b.worktree.path}${b.worktree.branch ? ` (${b.worktree.branch}${b.worktree.base ? ` → ${b.worktree.base}` : ''})` : ''}`);
  if (b.prs.length) sub(`PRs: ${b.prs.map((p) => `#${p.number} "${p.title}" (${p.state}${p.checks && CHECKS[p.checks] ? `, ${CHECKS[p.checks]}` : ''})`).join(', ')}`);
  if (b.commits.length) sub(`commits: ${b.commits.map((c) => `${c.sha} ${c.subject}`).join('; ')}`);
  if (b.files.length) sub(`files: ${b.files.map((f) => `${f.path}${f.alsoBy.length ? ` (also edited by ${f.alsoBy.join(', ')})` : ''}`).join(', ')}`);
  if (opts.stale) sub(opts.liveAt == null ? '(status never refreshed: work-hub was idle)' : `(status as of ${agoLabel(opts.liveAt, opts.now)} ago: work-hub was idle)`);
  return lines.join('\n');
}

/** The Markdown a session sees: every block but its own, working first, failed last; '' when nothing is left. */
export function renderDigest(d: Digest, opts: { excludeSessionId?: string; staleAfterMs: number; now: number }): string {
  const stale = d.liveAt == null || opts.now - d.liveAt > opts.staleAfterMs;
  const rank = (b: Block) => STATUS_RANK[b.status] ?? 3;
  const blocks = d.blocks
    .filter((b) => b.sessionId !== opts.excludeSessionId)
    .sort((a, b) => rank(a) - rank(b) || (a.shortId < b.shortId ? -1 : a.shortId > b.shortId ? 1 : 0));
  return blocks.map((b) => renderBlock(b, { stale, liveAt: d.liveAt, now: opts.now })).join('\n');
}
