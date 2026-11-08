import { useEffect, useRef, useState } from 'react';
import { post, useSource, useToast, type JobsData } from '../../plugin-api/web.ts';
import { bannerFor } from './bannerState.ts';
import { API, SOURCE_ID, type MonitorData } from './types.ts';
import { openWhatsNew, WhatsNewHost } from './WhatsNew.tsx';

const DISMISS_KEY = 'wh.claudeMonitor.dismissedUpdate';
const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};

/** The update job this tab started: when it finishes well, What's new opens here (and only here). */
let myUpdateJob: string | null = null;

/** Mounted on every page (`app-banner`): the update / What's new banner and the modal. */
export function ClaudeBanner() {
  const data = useSource<MonitorData>(SOURCE_ID)?.data ?? null;
  const jobs = useSource<JobsData>('jobs')?.data?.jobs;
  const toast = useToast();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [busy, setBusy] = useState(false);
  const banner = bannerFor(data, dismissed);
  const seenJob = useRef<string | null>(null);

  useEffect(() => {
    const j = myUpdateJob ? jobs?.find((x) => x.id === myUpdateJob) : undefined;
    if (!j || j.status === 'running' || seenJob.current === j.id) return;
    seenJob.current = j.id;
    myUpdateJob = null;
    if (j.status === 'done') openWhatsNew();
    else toast.show({ text: `Claude Code update failed: ${j.error ?? 'unknown error'}`, kind: 'error' });
  }, [jobs, toast]);

  const update = async () => {
    setBusy(true);
    try {
      const r = await post<{ jobId: string }>(`${API}/update`, {});
      myUpdateJob = r.jobId;
    } catch (e) {
      toast.show({ text: `Couldn't update: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (banner.kind === 'update') {
      try {
        localStorage.setItem(DISMISS_KEY, banner.latest);
      } catch {
        /* private mode: hidden for this page only */
      }
      setDismissed(banner.latest);
    } else if (banner.kind === 'whats-new') {
      void post(`${API}/seen`, { version: banner.installed }).catch(() => {});
    }
  };

  return (
    <>
      <WhatsNewHost />
      {banner.kind !== 'none' && (
        <div className="cm-banner">
          {banner.kind === 'updating' && <span className="grow">Updating Claude Code{banner.installed ? ` from ${banner.installed}` : ''}…</span>}
          {banner.kind === 'update' && (
            <>
              <span className="grow">
                Claude Code {banner.latest} is out (you have {banner.installed}).
              </span>
              <button className="ghost" onClick={openWhatsNew}>
                What's new
              </button>
              <button className="primary" disabled={busy} onClick={update}>
                Update
              </button>
            </>
          )}
          {banner.kind === 'whats-new' && (
            <>
              <span className="grow">Claude Code is now {banner.installed}.</span>
              <button className="primary" onClick={openWhatsNew}>
                What's new
              </button>
            </>
          )}
          {banner.kind !== 'updating' && (
            <button className="icon ghost" aria-label="Dismiss" onClick={dismiss}>
              ✕
            </button>
          )}
        </div>
      )}
    </>
  );
}
