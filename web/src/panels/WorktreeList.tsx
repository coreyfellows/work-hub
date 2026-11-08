import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { get, post, type Workspace } from '../api.ts';
import type { Sources, Worktree } from '../../../plugin-api/web.ts';
import type { RemoveResult, WorktreeInfo } from '../../../server/worktreeRoutes.ts';
import { AsOf } from '../components/AsOf.tsx';
import { ConfirmPopover } from '../components/ConfirmPopover.tsx';
import { useToast } from '../components/Toast.tsx';
import { HIDDEN, statusLabel } from '../status.ts';
import { useAllSources } from '../sourceStore.ts';
import type { ClaudeData } from '../api.ts';

type Action = { id: string; component: ComponentType<{ workspace: Workspace; worktree: Worktree; sources: Sources; data: unknown }> };

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

/**
 * A workspace's worktrees, grouped by the open session working in each; the ones with no open session are "Orphaned",
 * with a button that removes those that lose nothing (no uncommitted changes, every commit already elsewhere) and a
 * per-row Remove (confirmed, and the only way to discard changes). Loaded when the section opens, again when a session
 * opens or closes, and on ↻ (git state isn't polled).
 */
export function WorktreeList({ ws, sources, actions, data }: { ws: Workspace; sources: Sources; actions: Action[]; data: unknown[] }) {
  const { show } = useToast();
  const [infos, setInfos] = useState<WorktreeInfo[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Reload when worktrees come or go, or a session of this workspace opens or closes (not on every working↔idle flip).
  const live = (useAllSources().claude?.data as ClaudeData | null | undefined)?.sessions ?? [];
  const sig = [
    ws.worktrees.map((w) => w.path).join(','),
    ws.sessions.map((s) => `${s.claudeSessionId}:${HIDDEN.includes(live.find((l) => l.sessionId === s.claudeSessionId)?.status ?? 'stopped') ? 'c' : 'o'}`).join(','),
  ].join('|');
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setInfos((await get<{ worktrees: WorktreeInfo[] }>(`/api/workspaces/${ws.id}/worktrees`)).worktrees);
      setAt(Date.now());
    } catch {
      /* keep what is shown */
    } finally {
      setBusy(false);
    }
  }, [ws.id]);
  useEffect(() => void load(), [load, sig]);

  const remove = async (body: { paths?: string[]; orphaned?: boolean; force?: boolean }) => {
    try {
      const { results } = await post<{ results: RemoveResult[] }>(`/api/workspaces/${ws.id}/worktrees/remove`, body);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      show({ text: [ok ? `Removed ${ok} worktree${ok === 1 ? '' : 's'}.` : '', ...failed.map((f) => `${short(f.path)}: ${f.reason}`)].filter(Boolean).join(' ') || 'Nothing to remove.', kind: failed.length ? 'error' : 'info' });
    } catch (e) {
      show({ text: (e as Error).message, kind: 'error' });
    }
    await load();
  };

  const row = (t: WorktreeInfo, extra?: ReactNode) => {
    const w = ws.worktrees.find((x) => x.path === t.path);
    return (
      <li key={t.path}>
        <b>{t.repo.split('/')[1]}</b> <span className="muted">@{t.branch ?? '?'}</span>
        {t.baseBranch && <span className="muted"> → {t.baseBranch}</span>}
        {w &&
          actions.map((a, i) => {
            const Action = a.component;
            return <Action key={a.id} workspace={ws} worktree={w} sources={sources} data={data[i]} />;
          })}
        {extra}
        <div className="muted small-text">
          {short(t.path)}
          {t.sessions.length > 1 && ` · shared by ${t.sessions.length} sessions`}
          {!t.exists && ' · folder is gone'}
          {t.dirty && ' · uncommitted changes'}
          {t.unpushed > 0 && ` · ${t.unpushed} unpushed commit${t.unpushed === 1 ? '' : 's'}`}
        </div>
      </li>
    );
  };

  const header = (
    <div className="wt-head">
      <h3>Worktrees</h3>
      <AsOf at={at} onRefresh={() => void load()} busy={busy} />
    </div>
  );

  if (!infos) {
    // Not loaded yet (or the endpoint failed): the plain list.
    return (
      <>
        {header}
        <ul className="plain">
          {ws.worktrees.map((t) => (
            <li key={t.id}>
              <b>{t.repo.split('/')[1]}</b> <span className="muted">@{t.branch ?? '?'}</span>
              <div className="muted small-text">{short(t.path)}</div>
            </li>
          ))}
        </ul>
      </>
    );
  }

  // One group per open session (by its first open session), in the order the workspace lists them; the rest are orphaned.
  const order = ws.sessions.map((s) => s.claudeSessionId);
  const bySession = new Map<string, { name: string; status: string; items: WorktreeInfo[] }>();
  const orphaned: WorktreeInfo[] = [];
  for (const t of infos) {
    const first = [...t.sessions].sort((a, b) => (order.indexOf(a.sessionId) + 1 || 1e9) - (order.indexOf(b.sessionId) + 1 || 1e9))[0];
    if (!first) {
      orphaned.push(t);
      continue;
    }
    const g = bySession.get(first.sessionId) ?? { name: first.name, status: first.status, items: [] };
    g.items.push(t);
    bySession.set(first.sessionId, g);
  }
  const safe = orphaned.filter((t) => !t.block);
  const canRemove = ws.status !== 'setting-up';

  return (
    <>
      {header}
      {[...bySession.entries()].map(([sid, g]) => (
        <div key={sid} className="wt-group">
          <div className="wt-group-head">
            <span className="ellipsis">{g.name || sid.slice(0, 8)}</span> <span className={`badge st-${g.status}`}>{statusLabel(g.status)}</span>
          </div>
          <ul className="plain">{g.items.map((t) => row(t))}</ul>
        </div>
      ))}
      {orphaned.length > 0 && (
        <div className="wt-group orphaned">
          <div className="wt-group-head">
            <span className="grow">Orphaned · no open session</span>
            {canRemove && safe.length > 0 && (
              <ConfirmPopover
                className="danger small"
                confirmLabel={`Remove ${safe.length}`}
                message={
                  <>
                    Delete {safe.length} worktree folder{safe.length === 1 ? '' : 's'}? Nothing in {safe.length === 1 ? 'it' : 'them'} is lost (no uncommitted changes, every commit is on another branch or remote), and the branches stay.
                    {orphaned.length > safe.length && ` ${orphaned.length - safe.length} with unsaved work stay.`}
                  </>
                }
                onConfirm={() => remove({ orphaned: true })}
              >
                Remove orphaned ({safe.length})
              </ConfirmPopover>
            )}
          </div>
          <ul className="plain">
            {orphaned.map((t) =>
              row(
                t,
                canRemove && (
                  <ConfirmPopover
                    className="ghost small wt-remove"
                    confirmLabel={t.block ? 'Discard and remove' : 'Remove'}
                    message={
                      t.block ? (
                        <>
                          Delete {short(t.path)} <b>including its {t.block}</b>? This can't be undone. The branch stays.
                        </>
                      ) : (
                        <>Delete the folder {short(t.path)}? Nothing in it is lost, and the branch stays.</>
                      )
                    }
                    onConfirm={() => remove({ paths: [t.path], force: !!t.block })}
                  >
                    Remove…
                  </ConfirmPopover>
                ),
              ),
            )}
          </ul>
        </div>
      )}
    </>
  );
}
