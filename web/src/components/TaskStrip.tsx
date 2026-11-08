import { useCallback, useEffect, useState } from 'react';
import { ago, get, type Session } from '../api.ts';
import { useLowData } from '../lowData.ts';
import { waitingOnText } from '../status.ts';
import { AsOf } from './AsOf.tsx';

interface TaskProgress {
  lastOutputAt?: number;
  bytes?: number;
  lines?: string[];
  steps?: number;
  more?: boolean;
  last?: string;
}
type TaskRow = Session['tasks'][number] & { progress: TaskProgress | null };

const KIND_LABEL: Record<string, string> = { shell: 'Shell', agent: 'Agent', monitor: 'Monitor' };

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What a task has done so far, in one line (the shell's last lines go under it). */
function progressLine(p: TaskProgress | null, kind: string): string {
  if (!p) return 'no output file';
  const out = p.lastOutputAt ? `last output ${ago(p.lastOutputAt)} ago` : 'no output yet';
  if (kind === 'agent') return [`${p.steps ?? 0}${p.more ? '+' : ''} step${p.steps === 1 && !p.more ? '' : 's'}`, out].join(' · ');
  return [p.bytes ? size(p.bytes) : '', out].filter(Boolean).join(' · ');
}

/**
 * Pinned above the prompt box (every view) while the session has background tasks running: one line saying so, and a
 * tap opens the list with each task's progress (its output's last lines, an agent's steps and latest action). The list
 * polls only while open (every 3s; 10s in low data, with "as of" ↻).
 */
export function TaskStrip({ session }: { session: Session }) {
  const tasks = session.tasks ?? [];
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lowData = useLowData();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await get<{ tasks: TaskRow[] }>(`/api/sessions/${session.sessionId}/tasks`);
      setRows(r.tasks);
      setAt(Date.now());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session.sessionId]);
  const ids = tasks.map((t) => t.id).join(',');
  useEffect(() => {
    if (!open || !ids) return;
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, lowData ? 10_000 : 3_000);
    return () => clearInterval(t);
  }, [open, ids, lowData, load]);
  if (!tasks.length) return null;

  const waiting = !!waitingOnText(session);
  const since = Math.min(...tasks.map((t) => t.startedAt ?? Infinity));
  const what = tasks.length === 1 ? tasks[0]!.label : `${tasks.length} background tasks`;
  const head = `${waiting ? 'Waiting on' : 'Running in background:'} ${what}`;
  return (
    <div className={`task-strip ${open ? 'open' : ''}`}>
      {open && (
        <div className="task-list">
          <div className="task-list-bar">
            <span>Background tasks</span>
            {lowData && <AsOf at={at} onRefresh={() => void load()} busy={busy} />}
          </div>
          {error && <div className="error">{error}</div>}
          {(rows ?? tasks.map((t) => ({ ...t, progress: undefined as TaskProgress | null | undefined }))).map((t) => (
            <div key={t.id || t.label} className="task-row">
              <div className="task-row-head">
                <span className="task-kind">{KIND_LABEL[t.kind] ?? t.kind}</span>
                <span className="task-label">{t.label}</span>
                {t.startedAt && <span className="task-age">{ago(t.startedAt)}</span>}
              </div>
              {t.progress === undefined ? (
                <div className="task-progress">loading…</div>
              ) : (
                <>
                  <div className="task-progress">
                    {progressLine(t.progress, t.kind)}
                    {t.kind === 'agent' && t.progress?.last && <> · {t.progress.last}</>}
                  </div>
                  {t.kind !== 'agent' && t.progress?.lines?.length ? <pre className="task-tail">{t.progress.lines.join('\n')}</pre> : null}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <button type="button" className="task-bar" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? 'Hide background tasks' : 'Show background tasks and their progress'}>
        <span className="task-dot" aria-hidden />
        <span className="task-head">{head}</span>
        {Number.isFinite(since) && <span className="task-age">{ago(since)}</span>}
        <span className="task-caret" aria-hidden>{open ? '▾' : '▴'}</span>
      </button>
    </div>
  );
}
