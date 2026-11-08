import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A repo's own guidance for reviewing its code, if it has any. Dedicated files win; otherwise a
 * "Code review" style section inside CLAUDE.md or AGENTS.md. The adversarial review follows it instead of
 * the exhaustive multi-model default.
 */

export interface ReviewGuidance {
  /** Path relative to the worktree. */
  path: string;
  /** The heading when the guidance is a section of a larger file; null when the whole file is guidance. */
  section: string | null;
}

const FILES = ['REVIEW.md', 'REVIEWING.md', '.claude/review.md', 'docs/REVIEW.md', '.github/REVIEW.md'];
const SECTIONED = ['CLAUDE.md', 'AGENTS.md'];
const HEADING = /^(#{1,4})\s+(.*\b(?:code[ -]review|review (?:guidelines|guidance|checklist|criteria|process)|reviewing)\b.*)$/im;

/** The first review-ish heading in a Markdown file, or null. Headings inside fenced code are ignored. */
export function findReviewSection(markdown: string): string | null {
  const stripped = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  const m = HEADING.exec(stripped);
  return m ? m[2].trim() : null;
}

const read = (p: string) => readFile(p, 'utf8').then((s) => s, () => null);

export async function findReviewGuidance(worktree: string): Promise<ReviewGuidance | null> {
  for (const f of FILES) {
    const text = await read(join(worktree, f));
    if (text?.trim()) return { path: f, section: null };
  }
  for (const f of SECTIONED) {
    const text = await read(join(worktree, f));
    const section = text ? findReviewSection(text) : null;
    if (section) return { path: f, section };
  }
  return null;
}
