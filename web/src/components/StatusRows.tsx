import { useState } from 'react';
import { ago, post, type SourceState } from '../api.ts';

/** A Status block for one source: title, when it was checked, a ↻, its error, then `children`. */
export function SourceBlock({ title, state, note, children }: { title: string; state: SourceState | undefined; note?: string; children: React.ReactNode }) {
  return (
    <section className="block">
      <div className="block-head">
        <h3>{title}</h3>
        <span className="muted small-text">
          {state?.updatedAt ? `checked ${ago(state.updatedAt)} ago` : state?.loading ? 'checking…' : 'not checked yet'}
          {note ? ` · ${note}` : ''}
        </span>
        {state && <RefreshButton id={state.id} loading={state.loading} />}
      </div>
      {state?.error && <div className="error">{state.error}</div>}
      {children}
    </section>
  );
}

/** One ✓/✗ line on the Status page. */
export function Row({ ok, label, detail, dim, action }: { ok: boolean; label: string; detail: string; dim?: boolean; action?: React.ReactNode }) {
  return (
    <div className={`status-row ${dim ? 'dim' : ''}`}>
      <span className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '✗'}</span>
      <span className="label">{label}</span>
      <span className="muted small-text grow">{detail}</span>
      {action}
    </div>
  );
}

/** Re-fetch one source now (`POST /api/sources/:id/refresh`). */
export function RefreshButton({ id, loading }: { id: string; loading: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="icon"
      disabled={busy || loading}
      title="Check now"
      aria-label="Check now"
      onClick={async () => {
        setBusy(true);
        await post(`/api/sources/${id}/refresh`).catch(() => {});
        setBusy(false);
      }}
    >
      {busy || loading ? '…' : '↻'}
    </button>
  );
}
