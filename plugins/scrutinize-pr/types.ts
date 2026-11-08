/** Types shared by the server and the web tab (type-only across the halves). */
import type { Since } from './since.ts';

export type { Since } from './since.ts';

export interface Message {
  role: 'you' | 'claude';
  text: string;
  at: string;
  /** Claude's messages: how it answered (an addendum or rewrite also changed the section). */
  kind?: 'reply' | 'addendum' | 'rewrite';
}

export interface Thread {
  id: string;
  /** The section it was asked in (`doc.ts` ids) and its title, to find it again after a regeneration. */
  sectionId: string;
  sectionTitle: string;
  /** The passage selected when asking ('' when asked about the whole section). */
  quote: string;
  messages: Message[];
  createdAt: string;
  /** The latest question has no answer yet (a job is on it). */
  pending: boolean;
  /** Why the latest question failed, if it did. */
  error: string | null;
}

/** GET /api/plugins/scrutinize-pr/prs/:owner/:repo/:number */
export interface SummaryView {
  exists: boolean;
  markdown: string | null;
  /** Where summary.md is on disk. */
  path: string;
  generatedAt: string | null;
  /** When an Update last brought it up to date with new commits (null: never). */
  updatedAt: string | null;
  /** The PR head the summary was written at (or last updated to). */
  headOid: string | null;
  model: string | null;
  /** `git`: written with the code at hand; `inline`: from the diff alone (no local clone). */
  mode: 'git' | 'inline' | null;
  /** The PR's size when it was written. */
  stats: { files: number; additions: number; deletions: number } | null;
  /** How much the PR's diff changed since (null: the asked-for head is the same, or none was given). */
  since: Since | null;
  sinceError: string | null;
  threads: Thread[];
  generating: boolean;
  /** An Update is running (new commits being folded in). */
  updating: boolean;
  /** The last generation's failure (until the next one starts). */
  error: string | null;
}
