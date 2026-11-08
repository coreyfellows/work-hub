import { useEffect, useState } from 'react';
import { get, type WorkspacePanelProps } from '../../plugin-api/web.ts';
import type { CodeLink } from './types.ts';

/**
 * VS Code (serve-web) for one of the workspace's worktrees, embedded. The links are loaded once when the tab is first
 * opened (the panel stays mounted after that).
 */
export function CodePane({ workspace }: WorkspacePanelProps) {
  const [links, setLinks] = useState<CodeLink[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  useEffect(() => {
    get<CodeLink[]>(`/api/plugins/code/workspaces/${workspace.id}`).then(setLinks, (e) => setLoadError((e as Error).message));
  }, [workspace.id]);
  if (!links) return <div className="tool-empty muted">{loadError ?? 'Loading…'}</div>;
  if (!links.length) return <div className="tool-empty muted">No worktrees recorded for this workspace yet.</div>;
  const link = links[Math.min(pick, links.length - 1)];
  return (
    <div className="tool-pane">
      <div className="tool-bar">
        {links.length > 1 ? (
          <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {links.map((c, i) => (
              <option key={c.path} value={i}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small-text">{link.label}</span>
        )}
        <a href={link.url} target="_blank" rel="noreferrer" className="small-text">
          Open ↗
        </a>
      </div>
      <iframe key={link.path} className="tool-frame" src={link.url} title="VS Code" allow="clipboard-read; clipboard-write" />
    </div>
  );
}
