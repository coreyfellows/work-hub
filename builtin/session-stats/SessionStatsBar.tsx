import { useEffect, useState } from 'react';
import { AsOf, editStats, FilesBrowser, get, Modal, netItem, useLowData, type FileEdit, type FileNode } from '../../plugin-api/web.ts';
import type { SessionStats } from './types.ts';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Tokens and API-equivalent cost so far, plus the files the session changed (opened in a modal with their diffs). */
export function SessionStatsBar({ sessionId }: { sessionId: string }) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [open, setOpen] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const lowData = useLowData();

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      get<SessionStats | null>(`/api/sessions/${sessionId}/stats`)
        .then((s) => {
          if (!alive) return;
          setStats(s);
          setLoadedAt(Date.now());
        })
        .catch(() => {});
    };
    load();
    if (lowData) return () => void (alive = false); // low data: on opening and on tap only
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, lowData, nonce]);

  if (!stats) return null;
  const t = stats.tokens;
  const total = t.input + t.output + t.cacheWrite + t.cacheRead;
  const breakdown = `input ${fmt(t.input)} · output ${fmt(t.output)} · cache write ${fmt(t.cacheWrite)} · cache read ${fmt(t.cacheRead)} · ${stats.responses} responses`;

  return (
    <div className="stats">
      <div className="stats-line">
        <span title={breakdown}>{fmt(total)} tokens</span>
        {stats.costUsd !== null && (
          <span
            title={`What this usage would cost at Claude API list prices. A subscription isn't billed per token.${
              stats.unpricedModels.length ? ` Not priced: ${stats.unpricedModels.join(', ')}.` : ''
            }`}
          >
            ≈ ${stats.costUsd.toFixed(2)} API-equivalent
          </span>
        )}
        <button className="link" onClick={() => setOpen(true)} disabled={!stats.files.length}>
          {stats.files.length ? `Files changed (${stats.files.length})` : 'No files changed'}
        </button>
        {lowData && <AsOf at={loadedAt} onRefresh={() => setNonce((n) => n + 1)} />}
      </div>
      {open && <FilesModal sessionId={sessionId} paths={stats.files.map((f) => f.path)} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Every file the session changed with Claude's tools: a tree beside the selected file's net change (fetched on open). */
function FilesModal({ sessionId, paths, onClose }: { sessionId: string; paths: string[]; onClose: () => void }) {
  const [files, setFiles] = useState<FileNode[] | null>(null);
  const [selected, setSelected] = useState(paths[0] ?? '');
  useEffect(() => {
    let alive = true;
    Promise.all(
      paths.map(async (path): Promise<FileNode> => {
        const edits = await get<FileEdit[]>(`/api/sessions/${sessionId}/file-edits?path=${encodeURIComponent(path)}`).catch(() => [] as FileEdit[]);
        const items = edits.map((e, i) => ({ key: `${path}-${i}`, edit: { ...e, path }, state: 'done' as const }));
        const net = netItem(items);
        const st = net ? editStats(net.edit) : { added: 0, removed: 0, created: false };
        return { path, edits: items, net, ...st, failed: !net };
      }),
    ).then((f) => alive && setFiles(f));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, paths.join('\n')]);
  const added = files?.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = files?.reduce((n, f) => n + f.removed, 0) ?? 0;
  return (
    <Modal
      className="fg-modal"
      onClose={onClose}
      head={
        <>
          <span className="edit-verb">Files changed ({paths.length})</span>
          <span className="edit-stat">
            {added > 0 && <span className="add">+{added}</span>}
            {removed > 0 && <span className="del">−{removed}</span>}
          </span>
          <span className="muted small-text">Through Claude's Edit and Write tools; edits done with shell commands aren't listed.</span>
        </>
      }
    >
      {files ? <FilesBrowser files={files} selected={selected} onSelect={setSelected} /> : <div className="modal-empty muted">Loading…</div>}
    </Modal>
  );
}
