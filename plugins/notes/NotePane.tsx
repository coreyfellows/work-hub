import { useEffect, useState } from 'react';
import { get, post, type WorkspacePanelProps } from '../../plugin-api/web.ts';
import type { NoteInfo } from './types.ts';

/**
 * The workspace's SilverBullet note, embedded (created on demand if it's missing). Loaded once when the tab is first
 * opened (the panel stays mounted after that; the note's location doesn't change while the page is open).
 */
export function NotePane({ workspace }: WorkspacePanelProps) {
  const workspaceId = workspace.id;
  const [note, setNote] = useState<NoteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    get<NoteInfo>(`/api/plugins/notes/workspaces/${workspaceId}`).then(setNote, (e) => setLoadError((e as Error).message));
  useEffect(() => {
    void load();
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!note) return <div className="tool-empty muted">{loadError ?? 'Loading…'}</div>;
  if (!note.exists) {
    return (
      <div className="tool-empty">
        <p className="muted">This workspace has no note yet ({note.page}.md).</p>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await post(`/api/workspaces/${workspaceId}/note`);
              await load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Creating…' : 'Create note'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }
  return (
    <div className="tool-pane">
      <div className="tool-bar">
        <span className="muted small-text">{note.page}</span>
        <a href={note.url} target="_blank" rel="noreferrer" className="small-text">
          Open ↗
        </a>
      </div>
      <iframe className="tool-frame" src={note.url} title="Note" />
    </div>
  );
}
