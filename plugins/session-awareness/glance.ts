import type { Block } from './digest.ts';

/** Pure helpers for the "Sessions at a glance" Details section (tested without React). */

const RANK: Record<string, number> = { working: 0, 'needs-input': 1, idle: 2, failed: 4 };

/** Working first, then waiting on the user, idle, anything else, failed last; ties by short id. */
export function glanceOrder(blocks: Block[]): Block[] {
  const rank = (b: Block) => RANK[b.status] ?? 3;
  return [...blocks].sort((a, b) => rank(a) - rank(b) || (a.shortId < b.shortId ? -1 : a.shortId > b.shortId ? 1 : 0));
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** A sentence when the digest's live facts are older than `staleAfterMs` (or were never refreshed), else null. */
export function staleLine(liveAt: number | null, now: number, staleAfterMs = 600_000): string | null {
  if (liveAt == null) return 'Status and PR facts not refreshed yet: work-hub has been idle.';
  if (now - liveAt <= staleAfterMs) return null;
  return `Status and PR facts as of ${ago(liveAt, now)} ago: work-hub was idle.`;
}

export function dotClass(status: string): string {
  const kind = status === 'working' ? 'working' : status === 'needs-input' ? 'waiting' : status === 'failed' ? 'failed' : 'idle';
  return `sa-dot ${kind}`;
}

const CHECKS: Record<string, [glyph: string, cls: string, label: string]> = {
  SUCCESS: ['✓', 'ok', 'checks passing'],
  FAILURE: ['✗', 'bad', 'checks failing'],
  ERROR: ['✗', 'bad', 'checks errored'],
  PENDING: ['●', 'pending', 'checks running'],
  EXPECTED: ['●', 'pending', 'checks expected'],
};

/** The same glyphs the github plugin's PR lists use (copied, not imported: plugins don't import each other). */
export function checksMark(checks: string | null): [glyph: string, cls: string, label: string] | null {
  return checks ? (CHECKS[checks] ?? null) : null;
}

const HIDDEN_STATUS = new Set(['done', 'stopped']);

/** True when at least two of a workspace's recorded sessions are live and not done/stopped (else there are no siblings to show). */
export function hasSiblings(recorded: Array<{ claudeSessionId: string }>, live: Array<{ sessionId: string; status: string }>): boolean {
  const open = new Set(live.filter((s) => !HIDDEN_STATUS.has(s.status)).map((s) => s.sessionId));
  return recorded.filter((r) => open.has(r.claudeSessionId)).length >= 2;
}

/** A folder as "…/" plus its last two segments (the full path goes in a title); a path of two segments or fewer stays whole. */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? p.replace(/(.)[\\/]+$/, '$1') : `…/${parts.slice(-2).join('/')}`;
}
