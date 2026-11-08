import { useCallback, useEffect, useState } from 'react';
import type { SessionViewProps, TranscriptNotice } from '../../plugin-api/web.ts';
import { AsOf, get, logTime } from '../../plugin-api/web.ts';

const LEVEL_LABEL: Record<TranscriptNotice['level'], string> = { info: '', error: 'error', blocked: 'sent Claude back' };

/** One notice: a hook's feedback or a finished task, newest first; long output folds away. */
function NoticeRow({ n }: { n: TranscriptNotice }) {
  const head = (
    <>
      <span className="act-kind">{n.kind === 'hook' ? 'Hook' : 'Task'}</span>
      <span className="act-title">{n.title}</span>
      {LEVEL_LABEL[n.level] && <span className="act-level">{LEVEL_LABEL[n.level]}</span>}
      {n.at && <span className="h-time">{logTime(n.at)}</span>}
    </>
  );
  const text = n.text?.trim();
  const short = text && text.length <= 200 && !text.includes('\n');
  return (
    <li className={`act-row ${n.level}`}>
      {!text || short ? (
        <div className="act-head">
          {head}
          {short && <div className="act-text">{text}</div>}
        </div>
      ) : (
        <details>
          <summary className="act-head">{head}</summary>
          <pre className="act-text">{text}</pre>
        </details>
      )}
    </li>
  );
}

/**
 * The Activity view: what Claude Code showed beside the conversation (hook feedback, task notifications), which Chat
 * and Log leave out. It loads when opened and again whenever the history poll's `noticeCount` changes; no poll of its own.
 */
export function ActivityView({ sessionId, visible, history }: SessionViewProps) {
  const [notices, setNotices] = useState<TranscriptNotice[] | null>(null);
  const [error, setError] = useState('');
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const count = history?.noticeCount ?? 0;
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await get<{ notices: TranscriptNotice[] }>(`/api/sessions/${sessionId}/activity`);
      setNotices(r.notices);
      setError('');
      setAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);
  useEffect(() => {
    if (visible) void load();
  }, [visible, count, load]);
  if (!visible) return null;
  return (
    <div className="activity">
      <div className="act-bar">
        <span className="muted">Hook feedback and finished tasks, newest first.</span>
        <AsOf at={at} onRefresh={() => void load()} busy={busy} />
      </div>
      {error && <div className="error">{error}</div>}
      {notices === null ? (
        !error && <div className="muted">Loading…</div>
      ) : notices.length === 0 ? (
        <div className="muted">Nothing yet: no hook feedback or task notifications in this session.</div>
      ) : (
        <ul className="act-list">
          {[...notices].reverse().map((n) => (
            <NoticeRow key={n.i} n={n} />
          ))}
        </ul>
      )}
    </div>
  );
}
