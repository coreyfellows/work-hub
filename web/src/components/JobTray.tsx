import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post, type Job } from '../api.ts';
import { Link } from '../router.tsx';
import { useToast } from './Toast.tsx';
import { useAnchored } from './useAnchored.ts';
import { useSlot } from '../slots.ts';


function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Slow actions (handoffs, new sessions, PR sessions) run on the server as jobs, so the page never waits for them; this is
 * their tray in the header: a button with what's running, and a panel with each job's state and a link to its result.
 * Finishing (or failing) pops a toast too, for jobs you saw running.
 */
export function JobTray({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const style = useAnchored(open, btn, box, true);
  const { show } = useToast();
  const kinds = useSlot('job-kind');
  // The first `job-kind` item for a kind wins.
  const icons = new Map<string, string>();
  for (const k of kinds) if (k.icon && !icons.has(k.kind)) icons.set(k.kind, k.icon);
  const running = jobs.filter((j) => j.status === 'running');
  const failed = jobs.filter((j) => j.status === 'failed');

  // A toast when a job you watched running finishes (not for ones already finished when the page loaded).
  const seen = useRef<Map<string, Job['status']>>(new Map());
  useEffect(() => {
    for (const j of jobs) {
      const was = seen.current.get(j.id);
      if (was === 'running' && j.status !== 'running') {
        show(
          j.status === 'done'
            ? { text: `${j.title}: done${j.detail ? ` (${j.detail})` : ''}` }
            : { kind: 'error', text: `${j.title}: failed${j.error ? `: ${j.error}` : ''}` },
        );
      }
      seen.current.set(j.id, j.status);
    }
  }, [jobs, show]);

  // Elapsed times tick only while the panel is open.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !btn.current?.contains(n)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!jobs.length) setOpen(false);
  }, [jobs.length]);

  if (!jobs.length) return null;
  const label = running.length ? `${running.length} running` : failed.length ? `${failed.length} failed` : 'Done';
  return (
    <>
      <button
        ref={btn}
        className={`ghost job-tray-btn${running.length ? ' busy' : failed.length ? ' bad' : ''}`}
        aria-expanded={open}
        aria-label={`Background jobs: ${label}`}
        title={`Background jobs: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        {running.length ? <span className="job-spin" aria-hidden /> : <span aria-hidden>{failed.length ? '✗' : '✓'}</span>}
        <span className="job-count">{running.length || jobs.length}</span>
      </button>
      {open &&
        createPortal(
          <div ref={box} className="job-panel" role="dialog" aria-label="Background jobs" style={style}>
            {jobs.map((j) => (
              <div key={j.id} className={`job ${j.status}`}>
                <span className="job-icon" aria-hidden>
                  {j.status === 'running' ? <span className="job-spin" /> : j.status === 'failed' ? '✗' : '✓'}
                </span>
                <div className="job-main">
                  <div className="job-title">
                    <span aria-hidden>{icons.get(j.kind) ?? ''} </span>
                    {j.title}
                  </div>
                  <div className="muted small-text">
                    {j.status === 'running' ? `Running ${took(Date.now() - j.startedAt)}…` : `${j.status === 'failed' ? 'Failed' : 'Done'} in ${took((j.finishedAt ?? Date.now()) - j.startedAt)}`}
                    {j.detail && ` · ${j.detail}`}
                  </div>
                  {j.error && <div className="job-error small-text">{j.error}</div>}
                  {j.link && (
                    <Link to={j.link.to} className="small-text" onClick={() => setOpen(false)}>
                      {j.link.label} →
                    </Link>
                  )}
                </div>
                {j.status !== 'running' && (
                  <button className="ghost icon" aria-label="Dismiss" title="Remove from the tray" onClick={() => void post(`/api/jobs/${j.id}/dismiss`)}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
