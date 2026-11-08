import { useCallback, useEffect, useMemo, useState } from 'react';
import { AsOf, copyLabel, DiffTable, get, parsePatch, useLowData } from '../../plugin-api/web.ts';

type Mode = 'base' | 'commit' | 'staged';

interface DiffFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}

interface WorktreeDiffData {
  mode: Mode;
  label: string;
  files: DiffFile[];
  untracked: string[];
  note: string | null;
}

const MODES: Array<[Mode, string, string]> = [
  ['base', 'vs base', "Everything this worktree changed compared with where it branched from its base branch (committed or not)"],
  ['commit', 'last commit', 'What the most recent commit changed'],
  ['staged', 'staged', 'Staged changes compared with HEAD'],
];

/** Diff of one of the workspace's worktrees: vs its base branch, the last commit, or what's staged. */
export function WorktreeDiff({
  workspaceId,
  worktrees,
  active,
}: {
  workspaceId: string;
  worktrees: Array<{ path: string; vcs: string; repo: string | null; branch: string | null }>;
  /** Only poll while the pane is showing. */
  active: boolean;
}) {
  const [pick, setPick] = useState(0);
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('wh.diffMode') as Mode | null) ?? 'base');
  const [data, setData] = useState<WorktreeDiffData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const lowData = useLowData();
  const wt = worktrees[Math.min(pick, worktrees.length - 1)];

  const load = useCallback(async () => {
    if (!wt) return;
    setLoading(true);
    try {
      const r = await get<WorktreeDiffData>(`/api/workspaces/${workspaceId}/diff?mode=${mode}&path=${encodeURIComponent(wt.path)}`);
      setData(r);
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, wt?.path, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setData(null);
  }, [wt?.path, mode]);
  useEffect(() => {
    if (!active) return;
    void load();
    if (lowData) return; // low data: on opening the tab and on tap only
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [active, load, lowData]);

  if (!worktrees.length) return <div className="tool-empty muted">No worktrees recorded for this workspace yet.</div>;

  const total = data?.files.reduce((n, f) => n + f.additions + f.deletions, 0) ?? 0;
  return (
    <div className="wt-diff">
      <div className="wt-diff-bar">
        {worktrees.length > 1 && (
          <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {worktrees.map((t, i) => (
              <option key={t.path} value={i}>
                {`${copyLabel(t).name}${t.branch ? `@${t.branch}` : ''}`}
              </option>
            ))}
          </select>
        )}
        <div className="seg">
          {MODES.map(([m, label, title]) => (
            <button
              key={m}
              title={title}
              className={mode === m ? 'on' : ''}
              onClick={() => {
                setMode(m);
                localStorage.setItem('wh.diffMode', m);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {lowData ? (
          <AsOf at={loadedAt} onRefresh={() => void load()} busy={loading} />
        ) : (
          <button className="ghost" onClick={() => void load()} disabled={loading} title="Refresh" aria-label="Refresh">
            ↻
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="muted pad">Loading diff…</p>}
      {data && (
        <>
          <div className="muted small-text wt-diff-label">
            {data.label} · {data.files.length} {data.files.length === 1 ? 'file' : 'files'}{' '}
            <span className="diffstat">
              <span className="ok">+{data.files.reduce((n, f) => n + f.additions, 0)}</span>{' '}
              <span className="bad">−{data.files.reduce((n, f) => n + f.deletions, 0)}</span>
            </span>
          </div>
          {data.untracked.length > 0 && (
            <div className="muted small-text wt-diff-label" title={data.untracked.join('\n')}>
              {data.untracked.length} untracked {data.untracked.length === 1 ? 'file' : 'files'} not shown (git add to include)
            </div>
          )}
          {data.note && <p className="muted pad">{data.note}</p>}
          <div className="pr-files">
            {data.files.map((f) => (
              <FileDiff key={`${mode}:${f.path}`} f={f} startOpen={total <= 1500 || data.files.length <= 3} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FileDiff({ f, startOpen }: { f: DiffFile; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const lines = useMemo(() => (open && f.patch ? parsePatch(f.patch) : []), [open, f.patch]);
  return (
    <div className="panel pr-file">
      <div className="pr-file-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <code className="grow">
          {f.previousPath && f.previousPath !== f.path ? `${f.previousPath} → ` : ''}
          {f.path}
        </code>
        {f.status !== 'modified' && <span className="tag">{f.status}</span>}
        <span className="diffstat">
          <span className="ok">+{f.additions}</span> <span className="bad">−{f.deletions}</span>
        </span>
      </div>
      {open &&
        (f.patch ? <DiffTable lines={lines} /> : <p className="muted pad small-text">Binary file, no content change, or too large to show.</p>)}
    </div>
  );
}
