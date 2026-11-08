import { useEffect, useState, useSyncExternalStore } from 'react';
import { get, Markdown, Modal, post, useSource, useToast } from '../../plugin-api/web.ts';
import { applyBody } from './bannerState.ts';
import { API, SOURCE_ID, type Analysis, type MonitorData, type WhatsNew } from './types.ts';

// One modal for the whole app, opened from the banner, the palette or the settings page.
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function openWhatsNew(): void {
  open = true;
  emit();
}
const closeWhatsNew = () => {
  open = false;
  emit();
};
export const useWhatsNewOpen = (): boolean =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => open,
    () => open,
  );

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Mounted once (by the banner): the modal while it's open. */
export function WhatsNewHost() {
  return useWhatsNewOpen() ? <WhatsNewModal /> : null;
}

function WhatsNewModal() {
  const data = useSource<MonitorData>(SOURCE_ID)?.data ?? null;
  const [notes, setNotes] = useState<WhatsNew | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<WhatsNew>(`${API}/whats-new`).then(setNotes, (e) => setError(errText(e)));
  }, []);

  const close = () => {
    // Closing counts as seen: the What's new banner goes away until the next version.
    if (data?.installed) void post(`${API}/seen`, { version: data.installed }).catch(() => {});
    closeWhatsNew();
  };

  const range = notes?.from && notes.to ? `${notes.from} → ${notes.to}` : notes?.to ?? '';
  return (
    <Modal head={<>What's new in Claude Code {range && <span className="muted">{range}</span>}</>} onClose={close} className="cm-modal">
      {error && <p className="error">{error}</p>}
      {!notes && !error && <p className="muted">Loading the changelog…</p>}
      {notes && (
        <>
          <p className="muted cm-versions">
            Installed {notes.installed ?? 'unknown'}
            {notes.latest && notes.installed !== notes.latest ? ` · newest ${notes.latest}` : ''}
            {notes.changelog === 'local' ? " · from Claude Code's cached changelog" : ''}
          </p>
          {notes.error && <p className="error">{notes.error}</p>}
          {!notes.entries.length && !notes.error && <p className="muted">No release notes for this range.</p>}
          {notes.entries.map((e) => (
            <section key={e.version} className="cm-entry">
              <h3>
                {e.version}
                {notes.installed && e.version === notes.installed ? <span className="cm-tag">installed</span> : null}
              </h3>
              <Markdown>{e.items.map((i) => `- ${i}`).join('\n')}</Markdown>
            </section>
          ))}
        </>
      )}
      <PluginSuggestions data={data} onStarted={closeWhatsNew} />
    </Modal>
  );
}

/** "Suggest plugin updates": the on-demand analysis, then a checklist of plugins to update (the rest skipped). */
function PluginSuggestions({ data, onStarted }: { data: MonitorData | null; onStarted: () => void }) {
  const toast = useToast();
  const [analysis, setAnalysis] = useState<Analysis | null | undefined>(undefined);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const status = data?.analysis.status ?? 'none';
  const doneVersion = data?.analysis.version ?? null;

  // Loaded when the modal opens and again when an analysis finishes (the source says so).
  useEffect(() => {
    if (status === 'running') return;
    get<{ analysis: Analysis | null }>(`${API}/suggestions`).then(
      (r) => setAnalysis(r.analysis),
      () => setAnalysis(null),
    );
  }, [status, doneVersion]);

  const installed = data?.installed ?? null;
  const current = analysis && installed && analysis.version === installed ? analysis : null;

  const analyze = async () => {
    setBusy(true);
    try {
      await post(`${API}/analyze`, {});
    } catch (e) {
      toast.show({ text: `Couldn't start: ${errText(e)}`, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const apply = async (skipRest: boolean, onlySkip = false) => {
    if (!current) return;
    const ids = current.suggestions.map((s) => s.plugin);
    const body = applyBody(current.version, ids, onlySkip ? new Set() : ticked, skipRest);
    setBusy(true);
    try {
      const r = await post<{ jobId?: string; skipped?: number }>(`${API}/apply`, body);
      const parts = [
        body.update.length ? `Starting ${body.update.length} update session${body.update.length === 1 ? '' : 's'} (see the job tray)` : '',
        r.skipped ? `skipped ${r.skipped} for ${current.version}` : '',
      ].filter(Boolean);
      toast.show({ text: parts.join('; ') || 'Done' });
      setAnalysis({ ...current, suggestions: current.suggestions.filter((s) => !body.update.includes(s.plugin) && !body.skip.includes(s.plugin)) });
      setTicked(new Set());
      if (body.update.length) onStarted();
    } catch (e) {
      toast.show({ text: errText(e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cm-plugins">
      <h3>Your plugins</h3>
      {!installed && <p className="muted">Can't tell which Claude Code version is installed.</p>}
      {installed && status === 'running' && <p className="muted">Reading the release notes against your plugins…</p>}
      {installed && status === 'failed' && <p className="error">The last look failed: {data?.analysis.error}</p>}
      {installed && status !== 'running' && !current && (
        <div className="cm-row">
          <span className="grow muted">
            See which of these changes your plugins could use, for every version since each plugin was last updated or skipped. Runs one headless Claude call.
            {data?.updateAvailable ? ` Covers what's installed (${installed}); update first to include ${data.latest}.` : ''}
          </span>
          <button className="primary" disabled={busy} onClick={analyze}>
            Suggest plugin updates
          </button>
        </div>
      )}
      {current && status !== 'running' && (
        <>
          {!current.suggestions.length && (
            <p className="muted">
              Nothing for your plugins up to {current.version}.{' '}
              <button className="ghost" disabled={busy} onClick={analyze}>
                Look again
              </button>
            </p>
          )}
          {current.dropped > 0 && <p className="muted">{current.dropped} older versions were left out to keep the request small.</p>}
          {current.suggestions.map((s) => (
            <label key={s.plugin} className="cm-suggestion">
              <input
                type="checkbox"
                checked={ticked.has(s.plugin)}
                onChange={(e) => {
                  const next = new Set(ticked);
                  if (e.target.checked) next.add(s.plugin);
                  else next.delete(s.plugin);
                  setTicked(next);
                }}
              />
              <div className="cm-suggestion-body">
                <div>
                  <strong>{s.title}</strong> <span className="muted">
                    {s.plugin} · {s.kind} · since {s.since ?? '—'}
                  </span>
                </div>
                <ul>
                  {s.items.map((i, n) => (
                    <li key={n}>
                      <span className="cm-tag">{i.version}</span> {i.idea}
                      <div className="muted cm-change">{i.change}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </label>
          ))}
          {current.suggestions.length > 0 && (
            <div className="cm-actions">
              <span className="grow muted">Each ticked plugin gets its own workspace and session. Unticked ones are skipped for {current.version}.</span>
              <button className="ghost" disabled={busy} onClick={() => apply(true, true)}>
                Skip all
              </button>
              <button className="primary" disabled={busy || !ticked.size} onClick={() => apply(true)}>
                Update {ticked.size || ''} and skip the rest
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
