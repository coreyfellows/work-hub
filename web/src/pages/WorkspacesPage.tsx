import { useState, type MouseEvent } from 'react';
import { ago, post, type ClaudeData, type Session, type Workspace, type WorkspacesData, type WorkspaceStatus } from '../api.ts';
import { useToast } from '../components/Toast.tsx';
import { useAllSources } from '../sourceStore.ts';
import { cardCounts, type CardCounts } from '../workspaceCard.ts';
import { ConfirmPopover } from '../components/ConfirmPopover.tsx';
import { Link, navigate } from '../router.tsx';
import { displayStatus, FINISHED, HIDDEN, showUnread, trashHint, waitingOnText } from '../status.ts';
import { UnreadDot } from '../components/UnreadDot.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { useRecentIdleMs } from '../recentIdle.ts';
import { useSlot } from '../slots.ts';

/** Front page: one compact card per workspace. The whole card links to the workspace's page. */
export function WorkspacesPage({ data, claude }: { data: WorkspacesData | null; claude: ClaudeData | null }) {
  const live = claude?.sessions ?? [];
  const assigned = new Set((data?.workspaces ?? []).flatMap((w) => w.sessions.map((s) => s.claudeSessionId)));
  const unassigned = live.filter((s) => !assigned.has(s.sessionId) && !FINISHED.includes(s.status));
  const open = (data?.workspaces ?? []).filter((w) => w.status !== 'done');
  const done = (data?.workspaces ?? []).filter((w) => w.status === 'done');
  const [showDone, setShowDone] = useState(false);
  const [groupBy, setGroupBy] = useGroupBy();
  const recentIdleMs = useRecentIdleMs();
  const listActions = useSlot('workspace-list-action');
  const groups = groupWorkspaces(open, live, groupBy, recentIdleMs);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Workspaces</h2>
        <div className="seg small-seg" title="Group by">
          {(['state', 'epic', 'none'] as const).map((g) => (
            <button key={g} className={groupBy === g ? 'on' : ''} onClick={() => setGroupBy(g)}>
              {g === 'state' ? 'State' : g === 'epic' ? 'Epic' : 'None'}
            </button>
          ))}
        </div>
        {listActions.map((a) => (
          <a.component key={`${a.plugin}:${a.id}`} />
        ))}
      </div>
      {!data && <div className="muted pad">Loading…</div>}
      {data && open.length === 0 && <div className="muted pad">No open workspaces.</div>}
      {groups.map((g) => (
        <section key={g.key} className="ws-group">
          {g.title && (
            <h3 className="group-title">
              {g.title}
              {g.subtitle && <span className="muted"> · {g.subtitle}</span>}
              <span className="count">{g.items.length}</span>
            </h3>
          )}
          <div className="ws-list">
            {g.items.map((w) => (
              <WorkspaceCard key={w.id} ws={w} live={live} />
            ))}
          </div>
        </section>
      ))}

      {unassigned.length > 0 && (
        <>
          <h3 className="section-title">Unassigned sessions</h3>
          <div className="ws-list">
            {unassigned.map((s) => (
              <UnassignedSession key={s.sessionId} s={s} />
            ))}
          </div>
        </>
      )}

      {done.length > 0 && (
        <>
          <button className="link done-toggle" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide' : 'Show'} {done.length} done
          </button>
          {showDone && (
            <div className="ws-list">
              {done.map((w) => (
                <WorkspaceCard key={w.id} ws={w} live={live} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function WorkspaceCard({ ws, live }: { ws: Workspace; live: Session[] }) {
  // Like the workspace page's tabs: ended (no longer listed), done and stopped sessions are hidden.
  const sessions = ws.sessions
    .map((rec) => ({ rec, s: live.find((l) => l.sessionId === rec.claudeSessionId) }))
    .filter(({ s }) => s && !HIDDEN.includes(s.status));
  const counts = cardCounts(sessions.map(({ s }) => s!));
  const waiting = counts.waiting > 0;
  const unread = sessions.some(({ s }) => s?.unread && s.status === 'idle');
  const to = `/workspaces/${ws.id}`;
  // The card opens the workspace; links and buttons inside it (title, session lines, chips, actions) handle themselves.
  const open = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.target as HTMLElement).closest('a, button, input, [role="dialog"]')) return;
    if (e.metaKey || e.ctrlKey) window.open(to, '_blank');
    else navigate(to);
  };
  return (
    <div className={`ws-item ${waiting ? 'ws-waiting' : ''} ws-${ws.status}`} onClick={open}>
      <div className="ws-item-head">
        {unread && <UnreadDot />}
        <Link to={to} className={`ws-item-title ${unread ? 'unread' : ''}`}>
          {ws.title}
        </Link>
        {ws.ticketKey && !ws.title.includes(ws.ticketKey) && <span className="tag">{ws.ticketKey}</span>}
        <span className={`tag ws-status-${ws.status}`}>{ws.status}</span>
        <CardActions ws={ws} />
      </div>
      <CardIndicators ws={ws} counts={counts} />
      {sessions.length === 0 && <div className="muted small-text">No running sessions</div>}
      {sessions.map(({ rec, s }) => (
        <SessionLine
          key={rec.id}
          status={s?.status ?? 'gone'}
          name={s?.name ?? rec.name ?? rec.shortId}
          since={s?.status === 'idle' ? s.lastActiveAt : null}
          session={s}
          // A session line opens the workspace with that session showing.
          onOpen={s ? (e) => {
            const target = `${to}?session=${encodeURIComponent(s.sessionId)}`;
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) window.open(target, '_blank');
            else navigate(target);
          } : undefined}
        />
      ))}
    </div>
  );
}

/** Park / Resume and Done (Reopen once done), right on the card. All reversible: they act at once with an Undo toast. */
function CardActions({ ws }: { ws: Workspace }) {
  const { show: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const setStatus = async (status: WorkspaceStatus, doneText?: string) => {
    const prev = ws.status;
    setBusy(true);
    try {
      await post(`/api/workspaces/${ws.id}/status`, { status });
      if (doneText) toast({ text: `${ws.title}: ${doneText}`, action: { label: 'Undo', run: () => void setStatus(prev) } });
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ws-item-actions">
      {ws.status === 'done' ? (
        <button className="ghost" disabled={busy} onClick={() => void setStatus('active')} title="Reopen this workspace">
          Reopen
        </button>
      ) : (
        <>
          {ws.status === 'parked' ? (
            <button className="ghost" disabled={busy} onClick={() => void setStatus('active')} title="Resume this workspace">
              Resume
            </button>
          ) : (
            <button className="ghost" disabled={busy} onClick={() => void setStatus('parked', 'parked.')} title="Park this workspace">
              Park
            </button>
          )}
          <button className="ghost" disabled={busy} onClick={() => void setStatus('done', 'marked done.')} title="Mark this workspace done">
            Done
          </button>
        </>
      )}
    </span>
  );
}

/** The row under the title: when the workspace was last active, then plugins' indicators (`workspace-card`, e.g. PR chips). */
function CardIndicators({ ws, counts }: { ws: Workspace; counts: CardCounts }) {
  const items = useSlot('workspace-card');
  const sources = useAllSources();
  const { lastActiveAt } = counts;
  return (
    <div className="ws-item-meta">
      {lastActiveAt > 0 && counts.working === 0 && (
        <span className="ws-item-ago-meta" title={new Date(lastActiveAt).toLocaleString()}>
          active {ago(lastActiveAt)} ago
        </span>
      )}
      {items.map((it) => (
        <it.component key={`${it.plugin}:${it.id}`} workspace={ws} sources={sources} />
      ))}
    </div>
  );
}

function SessionLine({
  status,
  name,
  since,
  session,
  onOpen,
}: {
  status: string;
  name: string;
  since?: number | null;
  session?: Session;
  onOpen?: (e: MouseEvent) => void;
}) {
  const recentIdleMs = useRecentIdleMs();
  status = session?.status === 'working' && session.waitingOnTasks ? 'waiting' : displayStatus(status, since, recentIdleMs);
  const unread = showUnread(status, session?.unread);
  return (
    <div
      className={`ws-item-session ${unread ? 'unread' : ''} ${onOpen ? 'openable' : ''}`}
      onClick={onOpen}
      title={onOpen ? `Open ${name}` : undefined}
    >
      <StatusBadge status={status} session={session} unread={unread} />
      <span className="ellipsis grow">
        {name}
        {waitingOnText(session) && <span className="muted ws-item-task"> · {waitingOnText(session)}</span>}
      </span>
      {since != null && (
        <span className="ws-item-ago" title={new Date(since).toLocaleString()}>
          {ago(since)}
        </span>
      )}
    </div>
  );
}

function UnassignedSession({ s }: { s: Session }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="ws-item-row">
      <Link to={`/sessions/${s.sessionId}`} className="ws-item grow">
        <div className="ws-item-head">
          <span className="ws-item-title">{s.name}</span>
        </div>
        <SessionLine
          status={s.status}
          name={s.cwd.replace(/^\/Users\/[^/]+/, '~')}
          since={s.status === 'idle' ? s.lastActiveAt : null}
          session={s}
        />
        {error && <div className="bad small-text">{error}</div>}
      </Link>
      <ConfirmPopover
        className="danger trash"
        disabled={busy}
        title="Trash this session"
        ariaLabel="Trash this session"
        confirmLabel="Trash"
        message={trashHint(s)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await post(`/api/sessions/${s.sessionId}/trash`);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : '🗑'}
      </ConfirmPopover>
    </div>
  );
}

// --- Grouping ------------------------------------------------------------------------------

type GroupBy = 'state' | 'epic' | 'none';

function useGroupBy(): [GroupBy, (g: GroupBy) => void] {
  const [g, setG] = useState<GroupBy>(() => (localStorage.getItem('wh.groupBy') as GroupBy) || 'state');
  return [
    g,
    (next) => {
      localStorage.setItem('wh.groupBy', next);
      setG(next);
    },
  ];
}

interface Group {
  key: string;
  title: string | null;
  subtitle?: string | null;
  items: Workspace[];
}

function liveSessions(w: Workspace, live: Session[]): Session[] {
  return w.sessions.map((r) => live.find((l) => l.sessionId === r.claudeSessionId)).filter((s): s is Session => !!s);
}

/** The latest activity of the workspace's running sessions (ms), or 0 if there's none. */
function lastActive(w: Workspace, live: Session[]): number {
  return Math.max(0, ...liveSessions(w, live).filter((s) => !FINISHED.includes(s.status)).map((s) => s.lastActiveAt ?? 0));
}

/** A workspace's working state is its most urgent live session's. Parked workspaces group separately. */
function workingState(w: Workspace, live: Session[], now: number, recentIdleMs: number): string {
  if (w.status === 'parked') return 'parked';
  if (w.status === 'setting-up') return 'setting-up';
  const ss = liveSessions(w, live);
  if (ss.some((s) => s.needsInput)) return 'waiting';
  if (ss.some((s) => s.status === 'working')) return 'working';
  if (ss.some((s) => !FINISHED.includes(s.status))) return now - lastActive(w, live) < recentIdleMs ? 'finished' : 'idle';
  return 'no-sessions';
}

const STATE_GROUPS: Array<[key: string, title: string]> = [
  ['waiting', 'Waiting on you'],
  ['setting-up', 'Setting up'],
  ['working', 'Working'],
  ['finished', 'Warm'],
  ['idle', 'Idle for a while'],
  ['no-sessions', 'No running sessions'],
  ['parked', 'Parked'],
];

/** recentIdleMs: idle workspaces active within this long are "Warm"; older ones sink below. */
function groupWorkspaces(list: Workspace[], live: Session[], by: GroupBy, recentIdleMs: number): Group[] {
  if (by === 'none') return [{ key: 'all', title: null, items: list }];

  if (by === 'state') {
    const now = Date.now();
    const byState = new Map<string, Workspace[]>();
    for (const w of list) {
      const k = workingState(w, live, now, recentIdleMs);
      byState.set(k, [...(byState.get(k) ?? []), w]);
    }
    // Idle groups: most recently finished first.
    for (const k of ['finished', 'idle']) byState.get(k)?.sort((a, b) => lastActive(b, live) - lastActive(a, live));
    return STATE_GROUPS.filter(([k]) => byState.has(k)).map(([key, title]) => ({ key, title, items: byState.get(key)! }));
  }

  // Epic: one group per epic (by key), then "No epic", then tickets not looked up yet.
  const epics = new Map<string, Group>();
  const none: Workspace[] = [];
  const pending: Workspace[] = [];
  for (const w of list) {
    if (w.epicKey) {
      const g = epics.get(w.epicKey) ?? { key: w.epicKey, title: w.epicKey, subtitle: w.epicTitle, items: [] };
      g.items.push(w);
      epics.set(w.epicKey, g);
    } else if (w.ticketKey && !w.epicCheckedAt) pending.push(w);
    else none.push(w);
  }
  const groups = [...epics.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  if (none.length) groups.push({ key: 'none', title: 'No epic', items: none });
  if (pending.length) groups.push({ key: 'pending', title: 'Looking up epic…', items: pending });
  return groups;
}
