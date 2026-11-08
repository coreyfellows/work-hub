import { Fragment } from 'react';
import { ago, type Session, type Workspace } from '../api.ts';
import type { MenuItem } from '../components/Menu.tsx';
import { ActionMenu } from '../components/ActionMenu.tsx';
import { displayStatus, FINISHED, HIDDEN, sessionShownStatus, showUnread } from '../status.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { MoveArrows, useDragReorder } from '../components/Reorder.tsx';
import { nudge } from '../lib/order.ts';

const MAX_CLOSED_LISTED = 12;

type SessionRec = Workspace['sessions'][number];

/**
 * One tab strip for a workspace: its sessions, then the tabs of each `workspace-tab-kind` (terminals), then a single
 * + menu (the kinds' entries, e.g. new session and new terminal, add a running session, then `tabstrip-action` items). Every tab has a ✕;
 * closing a session needs no confirm.
 */
export function WorkspaceTabs({
  workspace,
  sessions,
  extraTabs,
  kindMenu,
  selectedSessionId,
  unassigned,
  recentIdleMs,
  onPickSession,
  onCloseSession,
  closed,
  onDismissClosed,
  onAddSession,
  after,
  itemsFor,
  onReorder,
  editing,
}: {
  workspace: Workspace;
  sessions: Array<{ rec: SessionRec; s: Session | undefined }>;
  /** Other kinds' tabs (ids `<prefix><id>`), after the sessions. */
  extraTabs: Array<{ id: string; node: React.ReactNode }>;
  /** The kinds' entries for the + menu (session-tools' "New session" first, then the terminals'). */
  kindMenu: MenuItem[];
  selectedSessionId: string | null;
  unassigned: Session[];
  recentIdleMs: number;
  onPickSession: (s: Session) => void;
  onCloseSession: (s: Session) => void;
  /** Done/stopped sessions (newest first): listed in the + menu; the one being viewed gets a temporary tab. */
  closed: Array<{ rec: SessionRec; s: Session }>;
  onDismissClosed: () => void;
  onAddSession: (sessionId: string) => void;
  after?: React.ReactNode;
  /** The saved tab order applied to these ids (`s-<sessionId>`, `t-<termId>`), and its saver. */
  itemsFor: (current: string[]) => string[];
  onReorder: (order: string[]) => void;
  /** Unlocked: tabs can be moved (dragged on desktop, ◀▶ on phones). */
  editing: boolean;
}) {
  // Top level: New session, New terminal (a submenu of worktrees), Closed sessions (a submenu), and, only when there are any, running
  // sessions to add. `kindMenu` carries the first two from their plugins.
  const items: MenuItem[] = [
    ...kindMenu,
    ...(closed.length
      ? [
          {
            label: 'Closed sessions',
            submenu: closed.slice(0, MAX_CLOSED_LISTED).map(({ rec, s }): MenuItem => ({ label: `${s.name || rec.name || rec.shortId} · ${ago(s.lastActiveAt ?? s.startedAt)} ago`, onSelect: () => onPickSession(s) })),
          } as MenuItem,
        ]
      : []),
    ...(unassigned.length ? [{ label: 'Add running session', submenu: unassigned.map((s): MenuItem => ({ label: s.name, onSelect: () => onAddSession(s.sessionId) })) } as MenuItem] : []),
  ];
  const shown = sessions.filter(({ s }) => s && !HIDDEN.includes(s.status));
  const nodes = new Map<string, React.ReactNode>();
  for (const { rec, s } of shown) {
    const status = s?.status ?? 'gone';
    const isRunning = !!s && !FINISHED.includes(s.status);
    const shownStatus = s ? sessionShownStatus({ ...s, needsInput: false }, recentIdleMs) : displayStatus(status, undefined, recentIdleMs);
    const name = s?.name ?? rec.name ?? rec.shortId;
    nodes.set(
      `s-${rec.claudeSessionId}`,
      <div className={`term-tab session-tab ${s && s.sessionId === selectedSessionId ? 'on' : ''} ${isRunning ? '' : 'ended'}`} role="tab" aria-selected={!!s && s.sessionId === selectedSessionId}>
        <button className="term-tab-label ellipsis" disabled={!isRunning} onClick={() => s && onPickSession(s)} title={isRunning ? s!.name : 'No longer running'}>
          <StatusBadge status={shownStatus} session={s} unread={showUnread(shownStatus, s?.unread) && s!.sessionId !== selectedSessionId} />{' '}
          <span className="ellipsis">{name}</span>
        </button>
        {isRunning && (
          <button className="term-tab-close" aria-label="Close session" title="Close this session (`claude attach` reopens it)" onClick={() => onCloseSession(s!)}>
            ✕
          </button>
        )}
      </div>,
    );
  }
  // The closed session being viewed: a temporary tab; ✕ puts it away again.
  const viewing = closed.find(({ s }) => s.sessionId === selectedSessionId);
  if (viewing) {
    const name = viewing.s.name || viewing.rec.name || viewing.rec.shortId;
    nodes.set(
      `s-${viewing.rec.claudeSessionId}`,
      <div className="term-tab session-tab on ended" role="tab" aria-selected>
        <button className="term-tab-label ellipsis" title={`${name} (closed)`}>
          <StatusBadge status={viewing.s.status} session={viewing.s} /> <span className="ellipsis">{name}</span>
        </button>
        <button className="term-tab-close" aria-label="Stop viewing closed session" title="Stop viewing this closed session" onClick={onDismissClosed}>
          ✕
        </button>
      </div>,
    );
  }
  for (const t of extraTabs) nodes.set(t.id, t.node);
  const order = itemsFor([...nodes.keys()]);
  const drag = useDragReorder(order, onReorder, 'x');
  return (
    <div className="session-tabs" role="tablist">
      {order.map((id, i) =>
        editing ? (
          <span key={id} className={`tab-edit${drag.over?.id === id ? (drag.over.after ? ' drop-after' : ' drop-before') : ''}`} {...drag.bind(id)}>
            <span className="tab-edit-top">
              <span className="drag-grip" aria-hidden>⋮⋮</span>
              {nodes.get(id)}
            </span>
            <MoveArrows label="tab" horizontal first={i === 0} last={i === order.length - 1} onBack={() => onReorder(nudge(order, id, -1))} onForward={() => onReorder(nudge(order, id, 1))} />
          </span>
        ) : (
          <Fragment key={id}>{nodes.get(id)}</Fragment>
        ),
      )}
      <ActionMenu
        slot="tabstrip-action"
        ctx={{ workspace }}
        base={items}
        ariaLabel="New session, terminal or add a running session"
        palette={{ group: 'Workspace', hint: workspace.title }}
        trigger="+"
        className="ghost new-session-btn"
      />
      {after}
    </div>
  );
}
