import { useState, type ReactNode } from 'react';
import { ago, post, type SourceState } from '../api.ts';

/** Generic frame for a source: title, refresh button, freshness, error banner, loading state. */
export function Panel<T>({
  state,
  title,
  hideMeta,
  children,
}: {
  state: SourceState | undefined;
  title: string;
  hideMeta?: boolean;
  children: (data: T) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (!state) return;
    setBusy(true);
    await post(`/api/sources/${state.id}/refresh`).catch(() => {});
    setBusy(false);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {!hideMeta && state && (
          <div className="panel-meta">
            {state.updatedAt && <span title={new Date(state.updatedAt).toLocaleString()}>{ago(state.updatedAt)} ago</span>}
            <button className="icon" onClick={refresh} disabled={busy || state.loading} title="Refresh now" aria-label="Refresh now">
              {busy || state.loading ? '…' : '↻'}
            </button>
          </div>
        )}
      </div>
      {state?.error && <div className="error">{state.error}</div>}
      {state?.data ? children(state.data as T) : <div className="muted pad">{state?.loading || !state ? 'Loading…' : 'No data yet'}</div>}
    </section>
  );
}
