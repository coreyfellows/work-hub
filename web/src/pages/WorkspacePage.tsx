import { isMod } from '../lib/keys.ts';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ago, post, type ClaudeData, type Session, type Workspace, type WorkspacesData, type WorkspaceStatus } from '../api.ts';
import type { Sources, WorkspaceTabKindState } from '../../../plugin-api/web.ts';
import { SessionView } from '../panels/SessionView.tsx';
import { Link, NAVIGATE_EVENT } from '../router.tsx';
import { FINISHED, HIDDEN } from '../status.ts';
import { useToast } from '../components/Toast.tsx';
import { EditableTitle } from '../components/EditableTitle.tsx';
import { ActionMenu } from '../components/ActionMenu.tsx';
import { useRecentIdleMs } from '../recentIdle.ts';
import { WorkspaceTabs } from '../panels/WorkspaceTabs.tsx';
import { WorktreeList } from '../panels/WorktreeList.tsx';
import { CollapsibleBlock } from '../components/CollapsibleBlock.tsx';
import { usePersistedPick } from '../persist.ts';
import { useLayout, useLayoutEditing } from '../layout.ts';
import { MoveArrows, useDragReorder } from '../components/Reorder.tsx';
import { nudge } from '../lib/order.ts';
import { useSlot, useSlotOnce } from '../slots.ts';
import { useAllSources } from '../sourceStore.ts';

/**
 * One workspace: its sessions open inline (tabs across the top, the selected session's live terminal
 * below); everything else (links, worktrees and PRs, plan, activity) sits in a column on the right.
 *
 * Slots: `workspace-panel` (right-hand tabs after Details), `workspace-section` (Details sections among the core's),
 * `workspace-tab-kind` (tab strip entries besides sessions, e.g. terminals), `workspace-action` (header ⋯ menu),
 * `tabstrip-action` (the strip's + menu), `worktree-action` (worktree rows) and `link-kind` (link tags).
 */
export function WorkspacePage({
  id,
  data,
  claude,
}: {
  id: string;
  data: WorkspacesData | null;
  claude: ClaudeData | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const recentIdleMs = useRecentIdleMs();
  const sources = useAllSources();
  // Which session tab you were on is remembered per workspace (localStorage), so a reload or coming back reopens it.
  const [picked, setPicked] = usePersistedPick(`wh.ws.${id}.session`);
  const { show: toast } = useToast();
  // The right panel's tab and section order is one global layout (server-side); unlocking lets you rearrange it.
  const layout = useLayout((text) => toast({ kind: 'error', text: `Couldn't save the layout: ${text}` }));
  const editing = useLayoutEditing();
  const tabDrag = useDragReorder(layout.tabs, layout.setTabs, 'x');
  const viewRef = useRef<HTMLDivElement>(null);
  const panels = useSlot('workspace-panel');
  // Right column: Details or one of the `workspace-panel` tabs (they stay mounted once opened, and the column widens
  // for them). The left column is only the sessions.
  const [side, setSide] = useState<string>('details');
  // Phones: one tab bar picks which panel fills the page (the terminal takes touch drags, so scrolling
  // past it to the side panel isn't practical). Desktop shows both columns and ignores this.
  const [mobilePane, setMobilePane] = useState<'sessions' | 'side'>('sessions');
  const [opened, setOpened] = useState<Set<string>>(() => new Set(['details']));
  // Laptop widths: Diff/Note/Code slide over the terminal column. Whichever side you last used (click or
  // focus) is "in front"; the terminal never resizes. CSS decides whether this applies (see styles.css).
  const [front, setFront] = useState<'side' | 'main'>('side');
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // Clicking into an iframe (Note/Code/…) fires no events on our page, only a window blur.
    const onBlur = () =>
      setTimeout(() => {
        const a = document.activeElement;
        if (a?.tagName === 'IFRAME' && asideRef.current?.contains(a)) setFront('side');
      }, 0);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);
  const show = (v: string) => {
    setSide(v);
    setFront('side');
    setOpened((o) => new Set(o).add(v));
  };

  const ws = data?.workspaces.find((w) => w.id === id) ?? null;
  const live = claude?.sessions ?? [];
  const sessions = (ws?.sessions ?? []).map((rec) => ({ rec, s: live.find((l) => l.sessionId === rec.claudeSessionId) }));
  const running = sessions.filter((x): x is { rec: (typeof x)['rec']; s: Session } => !!x.s && !FINISHED.includes(x.s.status));
  // Your pick sticks while it's running; otherwise the default (see pickDefault).
  // Closed (done/stopped) sessions are off the tabs; one you open from the + menu's "Closed" entries shows until you pick another.
  const closed = sessions
    .filter((x): x is { rec: (typeof x)['rec']; s: Session } => !!x.s && HIDDEN.includes(x.s.status))
    .sort((a, b) => (b.s.lastActiveAt ?? b.s.startedAt) - (a.s.lastActiveAt ?? a.s.startedAt));
  const selectedSession =
    running.find((x) => x.s.sessionId === picked)?.s ?? closed.find((x) => x.s.sessionId === picked)?.s ?? pickDefault(running.map((x) => x.s)) ?? null;

  // Tab kinds besides sessions (terminals): each one's hook runs on every render; the slot is read once on mount.
  const kinds = useSlotOnce('workspace-tab-kind');
  const kindRef = useRef<WorkspaceTabKindState[]>([]);
  const kindStates = kinds.map((k, i) =>
    k.useTabs({
      workspaceId: id,
      workspace: ws,
      paneRef: viewRef,
      selectedSession,
      took: () => kindRef.current.forEach((st, j) => j !== i && st.clear()),
    }),
  );
  kindRef.current = kindStates;
  const clearKinds = () => kindRef.current.forEach((st) => st.clear());

  // ⌘, and ⌘. (Ctrl+, and Ctrl+. off a Mac) swap (previous, next) between the running sessions, in the order of the tabs (a terminal tab steps to the first or last one).
  const [slideFrom, setSlideFrom] = useState<'left' | 'right' | undefined>();
  const stepRef = useRef<(dir: 1 | -1) => void>(() => {});
  stepRef.current = (dir) => {
    const byTab = new Map(running.map((x) => [`s-${x.rec.claudeSessionId}`, x.s]));
    const order = layout.itemsFor(id, [...byTab.keys()]).map((k) => byTab.get(k)!).filter(Boolean);
    if (order.length < 2 && !activeKind) return;
    const at = activeKind ? -1 : order.findIndex((s) => s.sessionId === selectedSession?.sessionId);
    const next = at < 0 ? order[dir === 1 ? 0 : order.length - 1] : order[(at + dir + order.length) % order.length];
    if (!next || next.sessionId === selectedSession?.sessionId) return;
    setSlideFrom(dir === 1 ? 'right' : 'left');
    setPicked(next.sessionId);
    clearKinds();
    // Land in the new session's current input (the question form or message box), as after a palette jump: it asks now and for a short window, for a footer that mounts after.
    (window as unknown as { whFocusInputUntil?: number }).whFocusInputUntil = Date.now() + 4000;
    setTimeout(() => window.dispatchEvent(new Event('wh:focus-input')), 50);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || (e.key !== ',' && e.key !== '.')) return; // ⌘ on a Mac, Ctrl elsewhere
      if (document.querySelector('.palette, .modal, [role="dialog"]')) return; // a dialog has the keys
      e.preventDefault();
      stepRef.current(e.key === '.' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // `?session=<id>` (a session line on the front page, the ⌘K palette) opens that session's tab; the param is dropped once
  // applied. Checked on mount, when the workspace changes (the page can be reused for another one) and after every
  // navigation, so picking another session of the workspace you're already on switches to it too.
  const applySessionParam = useRef<() => void>(() => {});
  applySessionParam.current = () => {
    const q = new URLSearchParams(location.search);
    const sid = q.get('session');
    if (!sid) return;
    // Navigating to another workspace fires this before the page has switched to it: the [id] effect applies it then.
    if (!location.pathname.startsWith(`/workspaces/${encodeURIComponent(id)}`) && !location.pathname.startsWith(`/workspaces/${id}`)) return;
    setPicked(sid);
    clearKinds();
    q.delete('session');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  };
  useEffect(() => {
    applySessionParam.current();
  }, [id]);
  useEffect(() => {
    const on = () => applySessionParam.current();
    addEventListener(NAVIGATE_EVENT, on);
    return () => removeEventListener(NAVIGATE_EVENT, on);
  }, []);

  if (!data) return <div className="page muted">Loading…</div>;
  if (!ws) {
    return (
      <div className="page">
        <Link to="/">← Workspaces</Link>
        <p className="muted">No workspace "{id}".</p>
      </div>
    );
  }

  const activeKind = kindStates.find((k) => k.active);
  const pendingKind = kindStates.some((k) => k.pending);
  const selectedId = activeKind ? null : (selectedSession?.sessionId ?? null);
  const wrapSession = (node: ReactNode) => kindStates.reduceRight<ReactNode>((n, k) => (k.wrapSession ? k.wrapSession(n) : n), node);
  const tabLabel: Record<string, string> = { details: 'Details', ...Object.fromEntries(panels.map((p) => [p.id, p.label])) };

  // The ✕ on a session tab: same as the session header's Close. The pick falls back to the default session.
  const closeSessionTab = (s: Session) =>
    act('close', async () => {
      await post(`/api/workspaces/${ws.id}/sessions/${s.sessionId}/close`);
      if (s.sessionId === picked) setPicked(null);
      toast({ text: `Closed ${s.name}. \`claude attach\` reopens it.` });
    });

  const assigned = new Set(data.workspaces.flatMap((w) => w.sessions.map((s) => s.claudeSessionId)));
  const unassigned = live.filter((s) => !assigned.has(s.sessionId) && !FINISHED.includes(s.status));

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const setStatus = (status: WorkspaceStatus, doneText?: string) => {
    const prev = ws.status;
    return act(status, async () => {
      await post(`/api/workspaces/${ws.id}/status`, { status });
      if (doneText) toast({ text: doneText, action: { label: 'Undo', run: () => void setStatus(prev) } });
    });
  };

  return (
    <div className="ws-page">
      <div className="ws-head">
        <Link to="/" className="back">
          ←
        </Link>
        <div className="grow">
          <h2>
            <EditableTitle
              value={ws.title}
              label="Rename workspace"
              onSave={async (title) => {
                try {
                  await post(`/api/workspaces/${ws.id}/title`, { title });
                } catch (e) {
                  toast({ kind: 'error', text: `Couldn't rename: ${(e as Error).message}` });
                  throw e;
                }
              }}
            />
          </h2>
          <div className="sub">
            <span className={`tag ws-status-${ws.status}`}>{ws.status}</span>
            {ws.ticketKey && <span className="tag">{ws.ticketKey}</span>}
            {ws.epicKey && <span className="tag" title={ws.epicTitle ?? undefined}>epic {ws.epicKey}</span>}
            <span title={ws.createdAt}>created {ago(ws.createdAt)} ago</span>
          </div>
        </div>
        <div className="actions-row">
          {ws.status === 'done' ? (
            <button onClick={() => setStatus('active')} disabled={!!busy}>
              Reopen
            </button>
          ) : ws.status === 'parked' ? (
            <button className="ghost" onClick={() => setStatus('active')} disabled={!!busy}>
              Resume
            </button>
          ) : (
            <button className="ghost" onClick={() => setStatus('parked', 'Parked.')} disabled={!!busy}>
              Park
            </button>
          )}
          <ActionMenu
            slot="workspace-action"
            ctx={{ workspace: ws }}
            ariaLabel="More workspace actions"
            palette={{ group: 'Workspace', hint: ws.title }}
            align="right"
            trigger="⋯"
            base={ws.status !== 'done' ? [{ label: 'Mark done', disabled: !!busy, onSelect: () => void setStatus('done', 'Marked done.') }] : []}
          />
        </div>
      </div>
      {kindStates.map((k, i) => k.banner && <Fragment key={kinds[i]!.id}>{k.banner}</Fragment>)}

      <div className="mobile-tabs" role="tablist">
        {(['sessions', ...layout.tabs] as string[]).map((v) => {
          const on = v === 'sessions' ? mobilePane === 'sessions' : mobilePane === 'side' && side === v;
          return (
            <button
              key={v}
              role="tab"
              aria-selected={on}
              className={on ? 'on' : ''}
              onClick={() => {
                if (v === 'sessions') return setMobilePane('sessions');
                setMobilePane('side');
                show(v);
              }}
            >
              {v === 'sessions' ? 'Sessions' : tabLabel[v]}
            </button>
          );
        })}
      </div>

      <div className={`ws-body ${side !== 'details' ? 'wide-side' : ''}`} data-pane={mobilePane} data-front={front}>
        <main className="ws-main" onFocusCapture={() => setFront('main')} onPointerDownCapture={() => setFront('main')}>
          <div className="view" ref={viewRef}>
          <WorkspaceTabs
            workspace={ws}
            sessions={sessions}
            extraTabs={kindStates.flatMap((k) => k.tabs)}
            kindMenu={kindStates.flatMap((k) => k.menu ?? [])}
            selectedSessionId={selectedId}
            unassigned={unassigned}
            recentIdleMs={recentIdleMs}
            onPickSession={(s) => {
              setSlideFrom(undefined);
              setPicked(s.sessionId);
              clearKinds();
            }}
            onCloseSession={(s) => void closeSessionTab(s)}
            closed={closed}
            onDismissClosed={() => setPicked(null)}
            onAddSession={(sessionId) => void act('assign', () => post(`/api/workspaces/${ws.id}/sessions`, { sessionId }))}
            after={kindStates.some((k) => k.after) ? kindStates.map((k, i) => k.after && <Fragment key={kinds[i]!.id}>{k.after}</Fragment>) : undefined}
            editing={editing}
            itemsFor={(current) => layout.itemsFor(id, current)}
            onReorder={(order) => layout.setItems(id, order)}
          />

          {pendingKind ? null /* a remembered tab of another kind: wait for its list so the session view doesn't flash */ : activeKind ? (
            activeKind.pane
          ) : selectedSession ? (
            wrapSession(
            <SessionView
              key={selectedSession.sessionId}
              session={selectedSession}
              canTrash={false}
              embedded
              slideFrom={slideFrom}
              workspaceId={ws.id}
            />,
            )
          ) : (
            <div className="session-empty muted">
              {sessions.length === 0
                ? 'No sessions in this workspace yet.'
                : ws.status === 'setting-up'
                  ? 'The setup session has ended.'
                  : 'No sessions are running. Past sessions are listed above.'}
            </div>
          )}
          </div>
        </main>

        <aside
          ref={asideRef}
          className={`ws-side ${side !== 'details' ? 'tool' : ''}`}
          // On click (not pointer-down or focus): the panel moves, and moving it from under the pointer
          // mid-click would swallow the click on the tab being pressed.
          onClickCapture={() => setFront('side')}
          onKeyDownCapture={() => setFront('side')}
        >
          <div className="view-tabs" role="tablist">
            {layout.tabs.map((v, i) =>
              editing ? (
                <span
                  key={v}
                  className={`tab-edit${tabDrag.over?.id === v ? (tabDrag.over.after ? ' drop-after' : ' drop-before') : ''}`}
                  {...tabDrag.bind(v)}
                >
                  <span className="tab-edit-top">
                    <span className="drag-grip" aria-hidden>⋮⋮</span>
                    <button role="tab" aria-selected={side === v} className={side === v ? 'on' : ''} onClick={() => show(v)}>
                      {tabLabel[v]}
                    </button>
                  </span>
                  <MoveArrows label={tabLabel[v]!} horizontal first={i === 0} last={i === layout.tabs.length - 1} onBack={() => layout.setTabs(nudge(layout.tabs, v, -1))} onForward={() => layout.setTabs(nudge(layout.tabs, v, 1))} />
                </span>
              ) : (
                <button key={v} role="tab" aria-selected={side === v} className={side === v ? 'on' : ''} onClick={() => show(v)}>
                  {tabLabel[v]}
                </button>
              ),
            )}
          </div>
          <div className="side-view" hidden={side !== 'details'}>
            <SidePanels ws={ws} sources={sources} order={layout.sections} editing={editing} onReorder={layout.setSections} />
          </div>
          {panels.map((p) => {
            if (!opened.has(p.id)) return null;
            const Panel = p.component;
            return (
              <div key={p.id} className="side-view tool" hidden={side !== p.id}>
                <button className="tool-close" onClick={() => setSide('details')}>
                  ✕ Close
                </button>
                <Panel workspace={ws} visible={side === p.id} sources={sources} />
              </div>
            );
          })}
        </aside>
      </div>
    </div>
  );
}

/** Which session opens by default: one waiting on you, else the only one, else one working, else the newest. */
function pickDefault(running: Session[]): Session | undefined {
  return (
    running.find((s) => s.needsInput) ??
    (running.length === 1 ? running[0] : undefined) ??
    running.find((s) => s.status === 'working') ??
    [...running].sort((a, b) => b.startedAt - a.startedAt)[0]
  );
}

function SidePanels({
  ws,
  sources,
  order,
  editing,
  onReorder,
}: {
  ws: Workspace;
  sources: Sources;
  /** Section ids in the saved order (one layout for every workspace). */
  order: string[];
  /** Unlocked: sections show a grip and arrows, and empty ones appear as dimmed placeholders so they can be moved too. */
  editing: boolean;
  onReorder: (order: string[]) => void;
}) {
  const sections = useSlot('workspace-section');
  const linkKinds = useSlot('link-kind');
  // Worktree row actions: each one's `useData` runs once per render here (the slot is read once on mount).
  const wtActions = useSlotOnce('worktree-action');
  const wtData = wtActions.map((a) => a.useData?.(ws, sources));
  // URLs another section already shows (the Pull requests section's PRs) aren't repeated under Links.
  const shown = new Set(sections.flatMap((s) => s.shownUrls?.(ws, sources) ?? []));
  const links = ws.links.filter((l) => !shown.has(l.url));
  const drag = useDragReorder(order, onReorder);

  const parts: Record<string, { title: string; empty: boolean; node: ReactNode }> = {
    links: {
      title: 'Links',
      empty: links.length === 0,
      node: (
        <section className="block">
          <h3>Links</h3>
          <ul className="plain">
            {links.map((l) => {
              const kind = linkKind(linkKinds, l.kind, l.url);
              return (
                <li key={l.id} className="link-row">
                  <span className={`tag link-kind kind-${kind.id}`}>{kind.label}</span>
                  <a href={l.url} target="_blank" rel="noreferrer" className="ellipsis">
                    {l.label ?? l.url.replace(/^https?:\/\//, '')}
                  </a>
                  {prPreviewPath(l.url) && (
                    <Link to={prPreviewPath(l.url)!} className="small-text">
                      preview
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ),
    },
    worktrees: {
      title: 'Worktrees',
      empty: false,
      node: (
        <section className="block">
          {ws.worktrees.length === 0 ? (
            <>
              <h3>Worktrees</h3>
              <div className="muted">None yet{ws.status === 'setting-up' ? ' (the setup agent is working on it)' : ''}.</div>
            </>
          ) : (
            // Draws its own header: the refresh indicator sits on the same line as the title.
            <WorktreeList ws={ws} sources={sources} actions={wtActions} data={wtData} />
          )}
        </section>
      ),
    },
    notes: {
      title: 'Plan & notes',
      empty: !(ws.notes || ws.prompt),
      node: (
        <CollapsibleBlock title="Plan & notes">
          {ws.prompt && <p className="muted small-text">{ws.prompt}</p>}
          {ws.notes && <pre className="notes">{ws.notes}</pre>}
        </CollapsibleBlock>
      ),
    },
    activity: {
      title: 'Activity',
      empty: false,
      node: (
        <CollapsibleBlock title="Activity">
          <ul className="plain small-text">
            {ws.events.map((e, i) => (
              <li key={i}>
                <span className="muted">{ago(e.at)} ago</span> {e.type}
                {e.detail ? <span className="muted"> · {e.detail}</span> : null}
              </li>
            ))}
          </ul>
        </CollapsibleBlock>
      ),
    },
  };
  for (const s of sections) {
    if (parts[s.id]) continue; // the core's ids win
    const Section = s.component;
    let empty = false;
    try {
      empty = !!s.isEmpty?.(ws, sources);
    } catch {
      empty = false;
    }
    parts[s.id] = { title: s.title, empty, node: <Section workspace={ws} sources={sources} /> };
  }

  return (
    <>
      {order.map((id, i) => {
        const part = parts[id];
        if (!part) return null;
        if (!editing) return part.empty ? null : <Fragment key={id}>{part.node}</Fragment>;
        const over = drag.over?.id === id ? (drag.over.after ? ' drop-after' : ' drop-before') : '';
        return (
          <div key={id} className={`section-edit${part.empty ? ' is-empty' : ''}${over}`} {...drag.bind(id)}>
            <div className="section-edit-bar">
              <span className="drag-grip" aria-hidden>⋮⋮</span>
              <span className="grow">{part.title}</span>
              {part.empty && <span className="muted small-text">empty: hidden when locked</span>}
              <MoveArrows label={part.title} first={i === 0} last={i === order.length - 1} onBack={() => onReorder(nudge(order, id, -1))} onForward={() => onReorder(nudge(order, id, 1))} />
            </div>
            {part.empty ? (
              <section className="block placeholder">
                <h3>{part.title}</h3>
                <div className="muted small-text">Nothing here for this workspace right now.</div>
              </section>
            ) : (
              part.node
            )}
          </div>
        );
      })}
    </>
  );
}

/** The core's link kinds, after any `link-kind` slot items (a recorded kind or the URL decides). */
const CORE_LINK_KINDS: Array<{ kind: string; label: string; match(url: string, recorded: string): boolean }> = [
  { kind: 'pr', label: 'PR', match: (url, k) => k === 'pr' || /\/pull\/\d+/.test(url) },
  { kind: 'jira', label: 'Jira', match: (url, k) => k === 'jira' || /atlassian\.net\/browse\//.test(url) },
  { kind: 'confluence', label: 'Confluence', match: (url) => /atlassian\.net\/wiki\//.test(url) },
  { kind: 'slack', label: 'Slack', match: (url) => /slack\.com\//.test(url) },
  { kind: 'gdoc', label: 'Google Doc', match: (url) => /docs\.google\.com\/(document|spreadsheets|presentation)/.test(url) },
  { kind: 'grafana', label: 'Grafana', match: (url) => /grafana/.test(url) },
  { kind: 'github', label: 'GitHub', match: (url) => /github/.test(url) },
];

/** What a link points at, from its recorded kind or its URL. */
function linkKind(items: Array<{ kind: string; label?: string; match?(url: string, recorded: string): boolean }>, kind: string, url: string): { id: string; label: string } {
  for (const k of [...items, ...CORE_LINK_KINDS]) {
    if (k.match ? k.match(url, kind) : kind === k.kind) return { id: k.kind, label: k.label ?? k.kind };
  }
  return { id: 'url', label: 'Link' };
}

/** In-app preview path for a GitHub PR URL on our host, e.g. /prs/owner/repo/123. */
function prPreviewPath(url: string): string | null {
  const m = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `/prs/${m[1]}/${m[2]}/${m[3]}` : null;
}
