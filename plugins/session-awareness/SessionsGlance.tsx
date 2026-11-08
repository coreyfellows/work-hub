import { useCallback, useEffect, useRef, useState } from 'react';
import { AsOf, Link, get, useLowData, useSource, type Workspace } from '../../plugin-api/web.ts';
import type { Block, Digest } from './digest.ts';
import { checksMark, dotClass, glanceOrder, shortPath, staleLine } from './glance.ts';

const STATUS: Record<string, string> = { 'needs-input': 'waiting on you', working: 'working', idle: 'idle', failed: 'failed' };

/**
 * Details → "Sessions at a glance": the digest the sessions themselves get, one card per open session. Loads when
 * shown; with Low data off it follows the sessions and workspaces sources (debounced), with Low data on it loads once
 * and shows "as of … ↻".
 */
export function SessionsGlance({ workspace }: { workspace: Workspace }) {
  const lowData = useLowData();
  const claude = useSource('claude');
  const workspaces = useSource('workspaces');
  const [digest, setDigest] = useState<Digest | null | undefined>(undefined);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setDigest(await get<Digest>(`/api/plugins/session-awareness/workspaces/${encodeURIComponent(workspace.id)}/digest`));
    } catch {
      setDigest(null);
    } finally {
      setBusy(false);
      setLoadedAt(Date.now());
    }
  }, [workspace.id]);

  useEffect(() => void load(), [load]);
  // Live refresh (not in low data): a source change means the digest may have been rebuilt; wait for the server's debounce.
  const tick = `${claude?.updatedAt ?? ''}:${workspaces?.updatedAt ?? ''}`;
  useEffect(() => {
    if (lowData || loadedAt === null) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 2500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, lowData]);

  if (digest === undefined) return <div className="muted pad">Loading…</div>;
  if (digest === null || !digest.blocks.length) return <div className="muted pad">No digest yet: it appears once sessions are running here.</div>;
  const stale = staleLine(digest.liveAt, Date.now());
  return (
    <div className="sa-glance">
      {lowData && <AsOf at={loadedAt} onRefresh={() => void load()} busy={busy} />}
      {stale && <div className="sa-stale muted">{stale}</div>}
      {glanceOrder(digest.blocks).map((b) => (
        <Card key={b.sessionId} b={b} />
      ))}
    </div>
  );
}

function Card({ b }: { b: Block }) {
  return (
    <div className="sa-card">
      <div className="sa-head">
        <span className={dotClass(b.status)} aria-hidden />
        <Link to={`/sessions/${b.shortId}`} className="sa-name">
          {b.name ?? b.shortId}
        </Link>
        <span className="muted sa-meta">
          {b.role} · {STATUS[b.status] ?? b.status}
          {b.active ? ` · active ${b.active === 'just now' ? 'just now' : b.active === 'today' ? 'today' : b.active === 'older' ? 'earlier' : `~${b.active} ago`}` : ''}
        </span>
      </div>
      {b.claim && <div className="sa-claim">{b.claim}</div>}
      {!b.claim && b.intent && <div className="sa-intent muted">{b.intent}</div>}
      {b.worktree && (
        <div className="sa-line muted" title={b.worktree.path}>
          <span className="sa-path">{shortPath(b.worktree.path)}</span>
          {b.worktree.branch && (
            <span>
              {' '}
              ({b.worktree.branch}
              {b.worktree.base ? ` → ${b.worktree.base}` : ''})
            </span>
          )}
        </div>
      )}
      {b.prs.length > 0 && (
        <div className="sa-line sa-prs">
          {b.prs.map((p) => {
            const mark = checksMark(p.checks);
            return (
              <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="sa-pr" title={mark ? mark[2] : undefined}>
                {mark && <span className={`checks ${mark[1]}`}>{mark[0]}</span>} #{p.number} <span className="sa-pr-title">{p.title}</span>
                {p.state === 'draft' && <span className="muted"> draft</span>}
              </a>
            );
          })}
        </div>
      )}
      {b.done.length > 0 && (
        <ul className="sa-done">
          {b.done.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {b.files.length > 0 && (
        <div className="sa-line sa-files">
          {b.files.map((f) => (
            <span key={f.path} className={`sa-file${f.alsoBy.length ? ' overlap' : ''}`} title={f.alsoBy.length ? `also edited by ${f.alsoBy.join(', ')}` : f.path}>
              {f.path}
              {f.alsoBy.length > 0 && <span className="sa-also"> also {f.alsoBy.join(', ')}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
