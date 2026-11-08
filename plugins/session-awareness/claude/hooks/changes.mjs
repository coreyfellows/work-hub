// What changed between two readings of a workspace digest, as short lines for a session's context. Plain JS with no
// imports: the hook (awareness.mjs) runs it in every session, and the plugin's tests import it directly.

const CHECKS = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' };

/** Sibling blocks whose version the reader hasn't seen, and seen siblings that are no longer in the digest. */
export function seenDiff(seenVersions, blocks, selfSessionId) {
  const seen = seenVersions ?? {};
  const changed = blocks.filter((b) => b.sessionId !== selfSessionId && seen[b.sessionId] !== b.version);
  const gone = Object.keys(seen).filter((id) => id !== selfSessionId && !blocks.some((b) => b.sessionId === id));
  return { changed, gone };
}

const who = (b) => `session ${b.shortId}${b.name ? ` "${b.name}"` : ''}`;
const branch = (b) => b.worktree?.branch ?? null;

/** The one most important change for a sibling, with its priority (lower first); null when nothing worth a line. */
function change(prev, next, selfShortId, stale) {
  if (!prev) {
    const what = next.claim ? `responsible for ${next.claim}` : next.intent ? next.intent : 'no stated intent yet';
    return { p: 0, line: `${who(next)} (${next.role}) started: ${what}${branch(next) ? `; branch ${branch(next)}` : ''}.` };
  }
  if (!stale) {
    if (next.status === 'failed' && prev.status !== 'failed') return { p: 1, line: `${who(next)} failed.` };
    if (next.status === 'needs-input' && prev.status !== 'needs-input') return { p: 2, line: `${who(next)} is waiting on the user.` };
  }
  const prevPrs = new Map(prev.prs.map((p) => [p.number, p]));
  const opened = next.prs.find((p) => !prevPrs.has(p.number));
  if (opened) {
    const checks = opened.checks && CHECKS[opened.checks] ? `; checks ${CHECKS[opened.checks]}` : '';
    return { p: 3, line: `${who(next)} opened ${opened.state === 'draft' ? 'draft ' : ''}PR #${opened.number} "${opened.title}"${branch(next) ? ` on ${branch(next)}` : ''}${checks}.` };
  }
  if (!stale) {
    const flipped = next.prs.find((p) => prevPrs.has(p.number) && prevPrs.get(p.number).checks !== p.checks && p.checks && CHECKS[p.checks]);
    if (flipped) return { p: 4, line: `${who(next)} PR #${flipped.number} checks now ${CHECKS[flipped.checks]}.` };
  }
  if (next.claim && next.claim !== prev.claim) return { p: 5, line: `${who(next)} is now responsible for: ${next.claim}.` };
  const finished = next.done.filter((d) => !prev.done.includes(d));
  if (finished.length) return { p: 6, line: `${who(next)} finished: ${finished.join('; ')}.` };
  const overlaps = next.files.filter((f) => f.alsoBy.includes(selfShortId) && !prev.files.some((g) => g.path === f.path && g.alsoBy.includes(selfShortId)));
  if (overlaps.length) return { p: 7, line: `${who(next)} edited ${overlaps.map((f) => f.path).join(', ')}, which you also edited.` };
  return null;
}

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Lines for a session about its siblings: one per sibling that changed (most important kind first), siblings that
 * left, at most `max` plus a trailer; with stale live facts, status-based lines are left out and a stamp is added.
 */
export function changeLines(prevBlocks, nextBlocks, self, opts) {
  const { stale = false, liveAt = null, now = Date.now(), max = 5 } = opts ?? {};
  const prev = new Map((prevBlocks ?? []).filter((b) => b.sessionId !== self.sessionId).map((b) => [b.sessionId, b]));
  const found = [];
  for (const b of nextBlocks) {
    if (b.sessionId === self.sessionId) continue;
    const c = change(prev.get(b.sessionId) ?? null, b, self.shortId, stale);
    if (c) found.push(c);
  }
  found.sort((a, b) => a.p - b.p);
  const nextIds = new Set(nextBlocks.map((b) => b.sessionId));
  const gone = [...prev.keys()].filter((id) => !nextIds.has(id)).map((id) => ({ p: 8, line: `session ${prev.get(id).shortId} is gone (done or stopped).` }));
  const all = [...found, ...gone].map((c) => `work-hub: ${c.line}`);
  const lines = all.slice(0, max);
  if (all.length > max) lines.push(`work-hub: …and ${all.length - max} more changes; run the team command from your rules for the full picture.`);
  if (stale && lines.length) lines.push(liveAt == null ? 'work-hub: (status never refreshed: work-hub was idle, so session states may have moved on.)' : `work-hub: (status as of ${ago(liveAt, now)} ago: work-hub was idle, so session states may have moved on.)`);
  return lines;
}
