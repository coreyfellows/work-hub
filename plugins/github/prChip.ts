import type { PullRequest } from './types.ts';

/** How a PR shows as a chip on a workspace card: a glyph, a colour class, a short word and a full tooltip. */
export interface PrChip {
  glyph: string;
  cls: 'ok' | 'bad' | 'warn' | 'pending' | 'muted' | 'merged';
  word: string;
  title: string;
}

/**
 * The one thing worth knowing about a PR at a glance, most pressing first: merged, then conflicts, failing checks,
 * changes requested, unresolved threads, running checks, draft, approved, waiting on review.
 */
export function prChip(p: PullRequest): PrChip {
  const name = `${p.repo.split('/')[1]}#${p.number}: ${p.title}`;
  const facts: string[] = [];
  if (p.isDraft) facts.push('draft');
  if (p.checks) facts.push(`checks ${p.checks.toLowerCase()}`);
  if (p.reviewDecision) facts.push(p.reviewDecision.toLowerCase().replace('_', ' '));
  if (p.mergeable === 'CONFLICTING') facts.push('conflicts');
  if (p.unresolvedThreads) facts.push(`${p.unresolvedThreads} unresolved thread${p.unresolvedThreads === 1 ? '' : 's'}`);
  const title = `${name}${facts.length ? ` (${facts.join(', ')})` : ''}`;
  const chip = (glyph: string, cls: PrChip['cls'], word: string): PrChip => ({ glyph, cls, word, title });

  if (p.mergedAt) return { glyph: '⇣', cls: 'merged', word: 'merged', title: `${name} (merged)` };
  if (p.mergeable === 'CONFLICTING') return chip('✗', 'bad', 'conflicts');
  if (p.checks === 'FAILURE' || p.checks === 'ERROR') return chip('✗', 'bad', 'checks failing');
  if (p.reviewDecision === 'CHANGES_REQUESTED') return chip('✗', 'bad', 'changes requested');
  if (p.unresolvedThreads > 0) return chip('●', 'warn', `${p.unresolvedThreads} unresolved`);
  if (p.checks === 'PENDING' || p.checks === 'EXPECTED') return chip('●', 'pending', 'checks running');
  if (p.isDraft) return chip('○', 'muted', 'draft');
  if (p.reviewDecision === 'APPROVED') return chip('✓', 'ok', 'approved');
  if (p.reviewDecision === 'REVIEW_REQUIRED') return chip('✓', 'muted', 'needs review');
  return chip('✓', p.checks === 'SUCCESS' ? 'ok' : 'muted', 'open');
}
