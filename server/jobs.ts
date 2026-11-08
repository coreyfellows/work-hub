import { randomUUID } from 'node:crypto';
import { hubEvents } from './lib/events.ts';

/**
 * Slow actions (a handoff, a new session, a PR session, a review) run as jobs: the route answers at once with the job,
 * the work carries on here, and the header's tray follows it (the `jobs` source rides the SSE stream). Jobs are kept in
 * memory and written through to a store (server/store/jobs.ts, SQLite) so the tray survives a restart; the work itself
 * doesn't, so a job that was still running at a restart comes back failed ("interrupted").
 */
/** The core starts no jobs itself; each plugin names its own kinds (e.g. session-tools' 'handoff' and 'new-session', github's 'pr-session', adversarial-review's 'review'). */
export type JobKind = string;

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  /** What happened, e.g. which model was picked. */
  detail: string | null;
  workspaceId: string | null;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Where to go for the result (an in-app path). */
  link: { to: string; label: string } | null;
}

const KEEP_FINISHED_MS = 3600_000;
const jobs = new Map<string, Job>();
/** Resume data of running jobs (never sent to the browser); dropped once a job finishes. */
const payloads = new Map<string, unknown>();
let listener: () => void = () => {};

type JobResult = { detail?: string | null; link?: Job['link'] } | void;
export interface JobCtx {
  /** What the job saved with `setPayload` (or was started with); null if nothing. */
  payload: unknown;
  /** Save where the job has got to, so a restart can resume it (see `registerResumer`). */
  setPayload(p: unknown): void;
}
type JobRun = (progress: (detail: string) => void, ctx: JobCtx) => Promise<JobResult>;

/** Where jobs are persisted. The default keeps nothing (tests). */
export interface JobsStore {
  load(): Array<{ job: Job; payload: unknown }>;
  save(job: Job, payload: unknown): void;
  remove(id: string): void;
}
const noStore: JobsStore = { load: () => [], save: () => {}, remove: () => {} };
let store: JobsStore = noStore;

const resumers = new Map<JobKind, JobRun>();
/**
 * Make a kind of job survive a server restart: at startup, a job of this kind that was still running and had a payload is
 * run again with that payload (it must pick up from wherever the payload says). Jobs of other kinds, or without a
 * payload, come back failed. Register before `useJobsStore`.
 */
export const registerResumer = (kind: JobKind, run: JobRun) => resumers.set(kind, run);

const persist = (job: Job) => store.save(job, job.status === 'running' ? (payloads.get(job.id) ?? null) : null);

/** Run `run` for `job` and record how it ends. */
function execute(job: Job, run: JobRun): void {
  void (async () => {
    try {
      const r = await run(
        (detail) => {
          job.detail = detail;
          persist(job);
          listener();
        },
        {
          get payload() {
            return payloads.get(job.id) ?? null;
          },
          setPayload(p) {
            payloads.set(job.id, p);
            persist(job);
          },
        },
      );
      job.status = 'done';
      job.detail = (r && r.detail) || null;
      job.link = (r && r.link) || null;
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message || 'failed';
    }
    job.finishedAt = Date.now();
    payloads.delete(job.id);
    persist(job);
    listener();
    hubEvents.emit('job-finished', { id: job.id, kind: job.kind, status: job.status });
  })();
}

/** Use `s` from now on: load what it has. Jobs that were running when the last server stopped are resumed if their kind can be, else failed. */
export function useJobsStore(s: JobsStore): void {
  store = s;
  jobs.clear();
  payloads.clear();
  for (const { job, payload } of s.load()) {
    jobs.set(job.id, job);
    if (job.status !== 'running') continue;
    const resume = resumers.get(job.kind);
    if (resume && payload !== null && payload !== undefined) {
      payloads.set(job.id, payload);
      job.detail = 'Resuming after a server restart…';
      s.save(job, payload);
      execute(job, resume);
    } else {
      job.status = 'failed';
      job.error = 'Interrupted by a server restart; start it again.';
      job.finishedAt = Date.now();
      s.save(job, null);
    }
  }
  listener();
}

export const setJobsListener = (fn: () => void) => {
  listener = fn;
};
export const resetJobs = () => {
  jobs.clear();
  payloads.clear();
  resumers.clear();
  store = noStore;
};

export function startJob(init: { kind: JobKind; title: string; workspaceId?: string | null; payload?: unknown }, run: JobRun): Job {
  const job: Job = {
    id: randomUUID(),
    kind: init.kind,
    title: init.title,
    detail: null,
    workspaceId: init.workspaceId ?? null,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    link: null,
  };
  jobs.set(job.id, job);
  if (init.payload !== undefined) payloads.set(job.id, init.payload);
  persist(job);
  listener();
  execute(job, run);
  return job;
}

/** Newest first; finished jobs older than an hour are dropped. */
export function listJobs(now = Date.now()): Job[] {
  for (const [id, j] of jobs) if (j.finishedAt !== null && now - j.finishedAt > KEEP_FINISHED_MS) {
      jobs.delete(id);
      store.remove(id);
      payloads.delete(id);
    }
  return [...jobs.values()].reverse().sort((a, b) => b.startedAt - a.startedAt); // ties: the later one first
}

export function dismissJob(id: string): void {
  const j = jobs.get(id);
  if (j && j.status !== 'running') {
    jobs.delete(id);
    store.remove(id);
  }
  listener();
}
