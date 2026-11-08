// Following the cast's generation jobs on this page: which character each one is for (`known`, filled when this page
// starts a job and from GET …/pending for jobs started elsewhere), and reloading the cast when one finishes. Rides
// the `jobs` source already on the SSE stream; no polling of its own.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { get, post, useSource, useToast, type JobsData, type Job } from '../../plugin-api/web.ts';
import { GEN_JOB_KIND } from './editorState.ts';
import type { Part, Pending } from './generate.ts';
import { reloadHosts } from './menagerie.ts';

export const API = '/api/plugins/menagerie';

let known: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));

export function remember(p: Pending): void {
  known = [...known.filter((k) => k.jobId !== p.jobId), p];
  emit();
}

async function fetchPending(): Promise<void> {
  const list = await get<Pending[]>(`${API}/pending`).catch(() => [] as Pending[]);
  const ids = new Set(known.map((k) => k.jobId));
  if (list.some((p) => !ids.has(p.jobId))) {
    known = [...known, ...list.filter((p) => !ids.has(p.jobId))];
    emit();
  }
}

export const useKnown = (): Pending[] => useSyncExternalStore(subscribe, () => known, () => known);

export function useGenJobs(): Job[] {
  const jobs = useSource<JobsData>('jobs')?.data?.jobs;
  return (jobs ?? []).filter((j) => j.kind === GEN_JOB_KIND);
}

/** Jobs this page started a regenerate for, so finishing one offers Undo here (and not in every other tab). */
const mine = new Set<string>();

/** Starts a generation and remembers what it's for. */
export async function startGen(body: { named: string; kind: 'play' | 'inspired'; feedback?: string } | { id: string; part: Part; feedback?: string; named: string; kind: 'play' | 'inspired' }): Promise<string> {
  if ('id' in body) {
    const r = await post<{ jobId: string }>(`${API}/characters/${encodeURIComponent(body.id)}/regenerate`, { part: body.part, feedback: body.feedback });
    mine.add(r.jobId);
    remember({ jobId: r.jobId, named: body.named, kind: body.kind, part: body.part, id: body.id });
    return r.jobId;
  }
  const r = await post<{ jobId: string }>(`${API}/characters`, body);
  remember({ jobId: r.jobId, named: body.named, kind: body.kind, part: 'all' });
  return r.jobId;
}

const PART_DONE: Record<Part, string> = { all: 'recreated', portrait: 'has a new look', lines: 'has new lines', motion: 'has new moves' };

/**
 * Mounted once per page (with the setup banner): reloads the cast when a generation finishes, learns about jobs
 * started elsewhere, and offers Undo after a regenerate this page started.
 */
export function useCastJobWatcher(): void {
  const jobs = useGenJobs();
  const seen = useRef(new Map<string, Job['status']>());
  const toast = useToast();
  useEffect(() => {
    let finished = false;
    let unknown = false;
    for (const j of jobs) {
      const before = seen.current.get(j.id);
      if (before === 'running' && j.status !== 'running') {
        finished = true;
        const p = known.find((k) => k.jobId === j.id);
        if (j.status === 'done' && p?.id && mine.has(j.id)) {
          mine.delete(j.id);
          const id = p.id;
          toast.show({
            text: `${(j.detail ?? '').split(' · ')[0] || 'The host'} ${PART_DONE[p.part]}.`,
            action: { label: 'Undo', run: () => post(`${API}/characters/${encodeURIComponent(id)}/undo`).then(() => reloadHosts()) },
          });
        }
      }
      if (j.status === 'running' && !known.some((k) => k.jobId === j.id)) unknown = true;
      seen.current.set(j.id, j.status);
    }
    if (finished) void reloadHosts();
    if (unknown) void fetchPending();
  }, [jobs, toast]);
}
