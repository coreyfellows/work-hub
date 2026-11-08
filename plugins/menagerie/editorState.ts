// What the cast editor shows for generations in flight or failed: the jobs source says how a job is doing, the
// plugin's pending list (remembered on this page as `known`) says which character it's for. Pure, for tests.
import type { Job } from '../../plugin-api/web.ts';
import type { Part, Pending } from './generate.ts';

export const GEN_JOB_KIND = 'menagerie-generate';

export interface Placeholder {
  jobId: string;
  named: string;
  kind: 'play' | 'inspired';
  part: Part;
  /** The character being regenerated; absent for a new one. */
  id?: string;
  status: 'running' | 'failed';
  detail: string | null;
  error: string | null;
  /** The model wouldn't do this character as asked (the card offers "Invent someone like them"). */
  declined: boolean;
}

export function placeholders(input: { jobs: Job[]; known: Pending[]; dismissed: Set<string> }): Placeholder[] {
  const byJob = new Map(input.known.map((p) => [p.jobId, p]));
  const out: Placeholder[] = [];
  for (const j of input.jobs) {
    const p = byJob.get(j.id);
    if (j.kind !== GEN_JOB_KIND || !p || j.status === 'done' || input.dismissed.has(j.id)) continue;
    out.push({
      ...p,
      status: j.status,
      detail: j.detail,
      error: j.error,
      declined: j.status === 'failed' && !!j.error?.startsWith('declined:'),
    });
  }
  return out;
}
