import type { Source } from '../registry.ts';
import { listJobs, type Job } from '../jobs.ts';

/** Slow actions in flight or just finished (see server/jobs.ts), for the header tray. Held in memory (and persisted by server/store/jobs.ts), so free to poll. */
export interface JobsData {
  jobs: Job[];
}

export const jobsSource: Source<JobsData> = {
  id: 'jobs',
  title: 'Background jobs',
  intervalMs: 5_000,
  local: true,
  fetch: async () => ({ jobs: listJobs() }),
};
