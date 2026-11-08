import { isMod, keyLabel } from '../lib/keys.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { get, post, type HistoryEntry, type Session } from '../api.ts';
import { TaskStrip } from '../components/TaskStrip.tsx';
import { useHostProvider, useProviderHosts } from '../hostProvider.ts';

type HistoryPage = { entries: HistoryEntry[]; start: number; total: number; host?: ResidentHost | null; noticeCount?: number };
import { Link, navigate } from '../router.tsx';
import { ConfirmPopover } from '../components/ConfirmPopover.tsx';
import { ActionMenu } from '../components/ActionMenu.tsx';
import { useSlot, useSlotOnce } from '../slots.ts';
import type { InputSink, PendingMessage, ResidentHost, SessionHistory, SessionViewItem, SessionViewProps } from '../../../plugin-api/web.ts';
import { Modal } from '../components/Modal.tsx';
import { ConversationSearch, searchSupported } from '../components/ConversationSearch.tsx';
import { useLayout, useLayoutEditing } from '../layout.ts';
import { MoveArrows, useDragReorder } from '../components/Reorder.tsx';
import { nudge } from '../lib/order.ts';
import { pollFrom } from '../lib/historyPoll.ts';
import { useToast } from '../components/Toast.tsx';
import { EditableTitle } from '../components/EditableTitle.tsx';
import { useLowData } from '../lowData.ts';
import { usePaletteCommands } from '../lib/paletteStore.ts';
import { awaitingClaude, trashHint, waitingOnText } from '../status.ts';

/** How often the history and snapshot are re-read in low-data mode (normally 3s and 1.5s). */
const LOW_DATA_POLL_MS = 10_000;
/** The history poll while the live socket is up: it says when the transcript changes, so this only catches what enrichers add from elsewhere. */
const LIVE_POLL_MS = 15_000;
/** Reconnect delays for the live socket (ms), last one repeating; plain 3s polling carries on meanwhile. */
const LIVE_RETRY_MS = [1000, 3000, 10_000, 30_000];

/**
 * The first view tab: a stored choice if it's still a view (old saved choices map onto today's ids: Terminal + Log
 * with a "Readable" checkbox became Terminal, Chat and Log), else the `default` view for a background job (not in
 * low data), else a history view.
 */
function initialView(items: SessionViewItem[], canDrive: boolean, lowData: boolean): string {
  const ids = items.map((v) => v.id);
  const historyIds = items.filter((v) => v.needsHistory).map((v) => v.id);
  const stored = localStorage.getItem('wh.sessionTab');
  const legacy = localStorage.getItem('wh.readableLog') === '0' ? 'log' : 'chat';
  const asHistory = historyIds.includes(legacy) ? legacy : (historyIds[0] ?? ids[0] ?? '');
  if (!canDrive || lowData) return stored && historyIds.includes(stored) ? stored : asHistory;
  if (stored && ids.includes(stored)) return stored === 'log' ? asHistory : stored;
  return items.find((v) => v.default)?.id ?? ids[0] ?? '';
}

/**
 * One session: header, view tabs (the `session-view` slot: Terminal, Chat, Log…), and the active view's footer (Chat's prompt box).
 * Typed text and keys go to the active view's registered input sink (else any other registered one), else to
 * `POST /send` and `/key`. Slots: `session-header`, `session-action` (the ⋯ menu).
 */
export function SessionView({
  session,
  back,
  canTrash,
  embedded,
  workspaceId,
  slideFrom,
}: {
  session: Session;
  /** The workspace it belongs to, if any (passed on to slot items). */
  workspaceId?: string;
  /** Where the back link goes (full-page use). Omitted when embedded. */
  back?: { to: string; label: string };
  canTrash: boolean;
  /** Rendered inside another page: no back link, fills its container. */
  embedded?: boolean;
  /** Slide in from this side when it mounts (switching sessions with the keyboard). */
  slideFrom?: 'left' | 'right';
}) {
  const { show: toast } = useToast();
  const { views, setViews } = useLayout((text) => toast({ kind: 'error', text: `Couldn't save the layout: ${text}` }));
  const editing = useLayoutEditing();
  const viewDrag = useDragReorder(views, setViews, 'x');
  const viewItems = useSlot('session-view');
  const viewById = new Map(viewItems.map((v) => [v.id, v]));
  const headerItems = useSlot('session-header');
  // Its item is a hook (useActivity): read once per mount, so the hook count can't change between renders.
  const activitySource = useSlotOnce('working-activity')[0];
  // Views sharing a component (Chat and Log) are one instance, keyed by the first one's id.
  const groups: Array<{ key: string; Component: ComponentType<SessionViewProps>; ids: string[] }> = [];
  for (const v of viewItems) {
    const g = groups.find((x) => x.Component === v.component);
    if (g) g.ids.push(v.id);
    else groups.push({ key: v.id, Component: v.component, ids: [v.id] });
  }
  const groupKeyOf = new Map(groups.flatMap((g) => g.ids.map((i) => [i, g.key] as const)));
  // Conversation views come first in the scroll area (as before the slots), so find-in-view meets their matches before
  // any in a hidden view's DOM. Stable: it never depends on the active tab, so nothing remounts.
  const drawOrder = [...groups].sort((a, b) => Number(!viewById.get(a.key)?.needsHistory) - Number(!viewById.get(b.key)?.needsHistory));
  const [showIntent, setShowIntent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [histStart, setHistStart] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const keepFromBottom = useRef<number | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  // Input sinks registered by views, by view group (views sharing a component share one instance and one sink).
  const sinks = useRef(new Map<string, InputSink>());
  const registrars = useRef(new Map<string, (sink: InputSink | null) => void>());
  const registerFor = (key: string) => {
    let f = registrars.current.get(key);
    if (!f) {
      f = (sink) => {
        if (sink) sinks.current.set(key, sink);
        else sinks.current.delete(key);
      };
      registrars.current.set(key, f);
    }
    return f;
  };
  // Live status reported by `liveDot` views (by view group): the tab's dot, the "connecting…" note, the `live` scroll class.
  const [liveStatus, setLiveStatus] = useState<Record<string, string | null>>({});
  const liveSetters = useRef(new Map<string, (s: string | null) => void>());
  const liveSetterFor = (key: string) => {
    let f = liveSetters.current.get(key);
    if (!f) {
      f = (st) => setLiveStatus((cur) => (cur[key] === st ? cur : { ...cur, [key]: st }));
      liveSetters.current.set(key, f);
    }
    return f;
  };
  const [viewH, setViewH] = useState(400);
  const id = session.sessionId;
  const canDrive = session.kind === 'background';
  // Low data: the page opens on the log (the live terminal view waits for "Go live" itself).
  const lowData = useLowData();
  // Three views: the live Terminal, Chat (the readable conversation: no tool calls, questions as Q&A) and Log (everything).
  // They used to be Terminal + Log with a "Readable" checkbox; the old saved choices map onto them.
  const [tab, setTab] = useState<string>(() => initialView(viewItems, canDrive, lowData));
  const active = viewById.get(tab);
  // A live view (`liveDot`, the live terminal) is showing; `activeLive`: the status it reports (null while it shows a snapshot).
  const onLive = !!active?.liveDot;
  const statusOf = (viewId: string) => liveStatus[groupKeyOf.get(viewId) ?? ''] ?? null;
  const activeLive = onLive ? statusOf(tab) : null;
  const chooseTab = (t: string) => {
    setTab(t);
    if (canDrive && !lowData) localStorage.setItem('wh.sessionTab', t);
    if (viewById.get(t)?.needsHistory) stuck.current = true; // open the conversation at the latest entry
  };
  // The palette's command mode offers this session's other views (its ⋯ menu comes through ActionMenu).
  usePaletteCommands(
    views
      .filter((v) => v !== tab && viewById.has(v))
      .map((v) => ({ id: `session-view:${v}`, label: `Show ${viewById.get(v)!.label}`, hint: session.name, group: 'Session', run: () => chooseTab(v) })),
  );
  const inHistory = !!active?.needsHistory;
  // Find-in-view for Chat and Log: searches only what that view shows.
  const [searchOpen, setSearchOpen] = useState(false);
  // ⌘F opens it (replacing the browser's find) only while this session view has focus (you last clicked or tabbed into it)
  // and Chat or Log is showing; if it's already open it refocuses the box. A modal on top answers ⌘F itself.
  const rootRef = useRef<HTMLDivElement>(null);
  const hasFocus = useRef(false);
  useEffect(() => {
    const track = (e: Event) => {
      hasFocus.current = !!rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target);
    };
    document.addEventListener('pointerdown', track, true);
    document.addEventListener('focusin', track, true);
    return () => {
      document.removeEventListener('pointerdown', track, true);
      document.removeEventListener('focusin', track, true);
    };
  }, []);
  useEffect(() => {
    if (!inHistory || !searchSupported) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.key.toLowerCase() !== 'f') return; // ⌘F on a Mac, Ctrl+F elsewhere
      if (!hasFocus.current) return; // another part of the page has focus: leave ⌘F to it (or the browser)
      e.preventDefault();
      setSearchOpen(true);
      const box = document.querySelector<HTMLInputElement>('.convo-search input');
      box?.focus();
      box?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inHistory]);
  const readable = !!active?.readable;
  // Full screen: the session view covers the whole page (works everywhere), and where the browser allows
  // it (e.g. Firefox on Android, desktop browsers) the browser's own chrome is hidden too.
  const [full, setFull] = useState(false);
  const toggleFull = async () => {
    if (!full) {
      setFull(true);
      await document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      setFull(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    }
  };
  useEffect(() => {
    // Leaving browser full screen (back gesture, Esc on desktop) also leaves our full-screen view.
    const onChange = () => !document.fullscreenElement && setFull(false);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  useEffect(() => {
    // Don't stay in browser full screen when navigating away from this session.
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  // The live terminal fills the visible height of the scroll area, so scrolled to the bottom it's all on screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(Math.max(200, el.clientHeight - 10)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The menagerie host the transcript names (greeting or swap), so questions and the working bubble are themed early.
  const [resident, setResident] = useState<ResidentHost | null>(null);
  const [noticeCount, setNoticeCount] = useState(0);
  // Conversation history: latest page first, then poll for new entries (re-asking the last few so
  // tool results that arrive after their call fill in).
  // Not in low data, a WebSocket (conversation-view's history/live) says when the transcript changes and the page fetches
  // at once (`pollNow`); the timer then only runs every 15s (`liveRef`), and goes back to 3s while the socket is down.
  // Low data: no socket, poll every 10s instead of 3s, except for a minute after you send something or the session's
  // status changes (`boostUntil`), and fetch at once on such a change (`pollNow`) so the reply or question isn't left behind.
  const lowDataRef = useRef(lowData);
  lowDataRef.current = lowData;
  const boostUntil = useRef(0);
  const pollNow = useRef<() => void>(() => {});
  const liveRef = useRef(false);
  useEffect(() => {
    let alive = true;
    let total = 0;
    let ready = false; // the first page is in, so `total` is real
    let sent = 0; // polls can overlap (pollNow + the timer): only apply a response newer than the last applied
    let applied = 0;
    const first = async () => {
      const r = await get<HistoryPage>(`/api/sessions/${id}/history?limit=${lowDataRef.current ? 40 : 150}`);
      if (!alive) return;
      ready = true;
      setHistory(r.entries);
      setResident(r.host ?? null);
      setNoticeCount(r.noticeCount ?? 0);
      setHistStart(r.start);
      total = r.total;
    };
    const poll = async () => {
      if (document.hidden) return;
      const from = pollFrom(total, historyRef.current);
      const n = ++sent;
      const r = await get<HistoryPage>(`/api/sessions/${id}/history?after=${from}`);
      if (!alive || n < applied) return;
      applied = n;
      total = r.total;
      setResident((prev) => (r.host?.name === prev?.name && r.host?.at === prev?.at ? prev : (r.host ?? null)));
      setNoticeCount(r.noticeCount ?? 0);
      setHistory((prev) => [...prev.filter((e) => e.i < r.start), ...r.entries]);
    };
    void first().catch(() => {});
    let t: ReturnType<typeof setTimeout>;
    // Fetch now and restart the timer, so a boost (3s) applies at once rather than after a pending 10s wait.
    pollNow.current = () => {
      if (!ready) return;
      void poll().catch(() => {});
      clearTimeout(t);
      tick();
    };
    const tick = () => {
      const slow = lowDataRef.current && Date.now() > boostUntil.current;
      t = setTimeout(() => {
        void poll().catch(() => {});
        tick();
      }, slow ? LOW_DATA_POLL_MS : liveRef.current && !lowDataRef.current ? LIVE_POLL_MS : 3000);
    };
    tick();
    return () => {
      alive = false;
      pollNow.current = () => {};
      clearTimeout(t);
    };
  }, [id]);

  // The live socket: open while the page is visible and Low data is off; each `changed` (and `ready`, to catch up on
  // what happened while it was down) fetches at once. Closing it returns the timer to 3s.
  useEffect(() => {
    if (lowData) return;
    let alive = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const down = () => {
      if (liveRef.current) {
        liveRef.current = false;
        pollNow.current(); // restart the timer at 3s
      }
    };
    const connect = () => {
      if (!alive || document.hidden || ws) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/api/sessions/${id}/history/live`);
      ws = sock;
      sock.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let t: unknown;
        try {
          t = (JSON.parse(ev.data) as { t?: unknown }).t;
        } catch {
          return;
        }
        if (t === 'ready') {
          failures = 0;
          liveRef.current = true;
        }
        if (t === 'ready' || t === 'changed') pollNow.current();
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        down();
        if (!alive || document.hidden) return;
        retry = setTimeout(connect, LIVE_RETRY_MS[Math.min(failures++, LIVE_RETRY_MS.length - 1)]);
      };
    };
    const disconnect = () => {
      clearTimeout(retry);
      const sock = ws;
      ws = null;
      sock?.close();
      down();
    };
    // A hidden tab doesn't poll, so it holds no socket either; coming back reconnects and catches up.
    const onVisibility = () => (document.hidden ? disconnect() : connect());
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
    };
  }, [id, lowData]);

  // You're looking at it: clear "unread" once it has stopped working, and again whenever it says more while you watch.
  useMarkSeen(session);

  const statusKey = `${session.status}|${session.promptState}|${session.needsInput}|${session.questionId}`;
  const lastStatusKey = useRef(statusKey);
  useEffect(() => {
    if (lastStatusKey.current === statusKey) return;
    lastStatusKey.current = statusKey;
    if (lowDataRef.current) boostUntil.current = Date.now() + 60_000;
    else if (!liveRef.current) return;
    pollNow.current();
  }, [statusKey]);

  const loadEarlier = async () => {
    if (loadingEarlier || histStart === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await get<{ entries: HistoryEntry[]; start: number }>(`/api/sessions/${id}/history?before=${histStart}&limit=200`);
      const el = scrollRef.current;
      if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop; // keep your place when content is added above
      setHistory((prev) => [...r.entries, ...prev]);
      setHistStart(r.start);
    } finally {
      setLoadingEarlier(false);
    }
  };

  // After prepending earlier history, restore the scroll position relative to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    }
  }, [history]);

  useEffect(() => {
    if (!pending.length) return;
    const seen = new Set(history.filter((e) => e.kind === 'user').map((e) => (e.text ?? '').trim()));
    // A queued message only reaches the transcript once Claude takes it, so it stays while Claude is working.
    const keep = pending.filter((m) => !seen.has(m.text.trim()) && (session.status === 'working' || Date.now() - m.at < 60_000));
    if (keep.length !== pending.length) setPending(keep);
  }, [history, pending, session.status]);

  // The newest question form still waiting for an answer, if any.
  const pendingAsk = [...history].reverse().find((e) => e.questions && e.result === undefined) ?? null;

  // Claude is still processing: its job says so, or you just sent something its transcript doesn't answer yet.
  // That covers the gap between your message landing in the transcript (its pending bubble goes) and the
  // sessions poll noticing the job is working, which otherwise blinked the working bubble off and on again:
  // the transcript ending in your message or a running tool counts too, for a couple of minutes at most.
  const awaitingReply = pending.some((m) => !history.some((e) => e.at && Date.parse(e.at) > m.at)) || awaitingClaude(history);
  // The menagerie host who's been chiming in, to frame questions in their style (none when that's off).
  const hostProvider = useHostProvider();
  const funHosts = useProviderHosts(hostProvider);
  const askHost = useMemo(() => hostProvider?.lastHost(history, funHosts, resident), [hostProvider, history, funHosts, resident]);
  // The active view's own footer (Chat: the prompt box); Terminal and Log have none.
  const Footer = viewById.get(tab)?.footer;
  const isWorking = !pendingAsk && (session.status === 'working' || awaitingReply);
  // While it works, the pending bubble shows a quip (Claude's spinner word, off its screen) animating at the
  // pace the terminal is changing: the screen is polled and each poll's change size feeds a smoothed level.
  // The live-terminal plugin reads it off Claude's screen (`working-activity`); none without it.
  const useActivity = activitySource?.useActivity ?? noActivity;
  // Claude's turn is over and only its background tasks run: no working bubble (or reading its screen for a spinner
  // word); the task strip above the prompt box (TaskStrip) says what it's waiting on.
  const waitingOn = waitingOnText(session);
  const activity = useActivity(id, isWorking && !waitingOn && canDrive && !onLive && !lowData);

  // Stick to the bottom like a terminal, unless you've scrolled up to read.
  const stuck = useRef(true);
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(stickToBottom, [history, pending, tab, readable, isWorking, stickToBottom]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
      return false;
    }
  };

  // Sending takes a couple of seconds (it attaches to the job), so show it: the message moves into the
  // history as "sending…", then "sent ✓" until Claude's transcript shows it. On failure it comes back.
  // The active view's sink first, then any other registered one; `false` from a sink means "not delivered".
  const deliver = (fn: (sink: InputSink) => boolean | void): boolean => {
    const first = groupKeyOf.get(tab);
    const ordered = [...sinks.current.entries()].sort(([a], [b]) => Number(b === first) - Number(a === first));
    for (const [, sink] of ordered) if (fn(sink) !== false) return true;
    return false;
  };

  /** Send `msg` to Claude (the footer's prompt box calls it); throws with the reason if it couldn't be delivered. */
  const send = async (msg: string) => {
    const key = `${Date.now()}`;
    boostUntil.current = Date.now() + 60_000;
    if (lowDataRef.current) pollNow.current();
    // Busy Claude queues it (below the working bubble, with Send now); idle Claude starts a turn with it.
    const queued = session.status === 'working' || isWorking;
    setPending((p) => [...p, { key, text: msg, state: 'sending', at: Date.now(), queued }]);
    stuck.current = true;
    try {
      let sink: InputSink | null = null;
      if (deliver((s) => {
        const ok = s.send(msg);
        if (ok !== false) sink = s;
        return ok;
      })) {
        // Live: type it, then Enter separately (as one chunk Claude can treat it as a paste).
        await new Promise((r) => setTimeout(r, 150));
        (sink as InputSink | null)?.send('\r');
      } else {
        await post(`/api/sessions/${id}/send`, { text: msg });
      }
      setPending((p) => p.map((m) => (m.key === key ? { ...m, state: 'sent' } : m)));
    } catch (e) {
      setPending((p) => p.filter((m) => m.key !== key));
      throw e;
    }
  };

  const pressKey = async (key: string) => {
    if (deliver((s) => s.key(key))) return; // instant when live
    if (keyBusy) return;
    setKeyBusy(key);
    await act(() => post(`/api/sessions/${id}/key`, { key }));
    setKeyBusy(null);
  };

  // Interrupt Claude, like Esc in the CLI. Only while it's working: an idle Esc does nothing useful
  // (and a second one opens Claude's rewind menu).
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await pressKey('Escape');
    setTimeout(() => setStopping(false), 2500);
  };

  // What views get of the conversation (SessionViewProps.history and the turn state).
  const historyProp: SessionHistory = {
    entries: history,
    hasMore: histStart > 0,
    earlier: histStart,
    loading: loadingEarlier,
    loadEarlier: () => void loadEarlier(),
    resident,
    noticeCount,
  };

  return (
    <div ref={rootRef} className={`${embedded ? 'session-embed' : 'session-page'} ${full ? 'fullscreen' : ''} ${slideFrom ? `slide-from-${slideFrom}` : ''}`}>
      {back && (
        <Link to={back.to} className="back">
          ← {back.label}
        </Link>
      )}
      <div className="drawer-head">
        <div className="grow">
          <div className="session-name-bar">
            <h2>
              <EditableTitle
                value={session.name}
                label="Rename session (empty resets it)"
                allowEmpty
                onSave={async (name) => {
                  try {
                    await post(`/api/sessions/${id}/name`, { name });
                  } catch (e) {
                    toast({ kind: 'error', text: `Couldn't rename: ${(e as Error).message}` });
                    throw e;
                  }
                }}
              />
            </h2>
          </div>
          <div className="sub">
            <span>{session.kind}</span>
            <span>{session.status}</span>
            <span>{session.shortId}</span>
          </div>
        </div>
        <ActionMenu
          slot="session-action"
          ctx={{ session, sessionId: id, workspaceId }}
          ariaLabel="Session actions"
          palette={{ group: 'Session', hint: session.name }}
          align="right"
          trigger="⋯"
          base={[
            { label: showIntent ? 'Hide intent' : 'Intent', hidden: !session.intent, onSelect: () => setShowIntent((v) => !v) },
          ]}
        />
        {canTrash && (
          <ConfirmPopover
            className="danger"
            confirmLabel="Trash"
            message={trashHint(session)}
            onConfirm={() => act(() => post(`/api/sessions/${id}/trash`)).then((ok) => {
              if (ok) navigate(back?.to ?? '/');
            })}
          >
            Trash
          </ConfirmPopover>
        )}
      </div>

      {session.intent && showIntent && (
        <Modal head="Intent" className="modal-form" onClose={() => setShowIntent(false)}>
          <div className="intent-full">{session.intent}</div>
        </Modal>
      )}
      {headerItems.map((h) => {
        const Header = h.component;
        return <Header key={`${h.plugin}:${h.id}`} session={session} sessionId={id} workspaceId={workspaceId} />;
      })}

      <div className="session-tabs-bar" role="tablist">
        {views.map((v, i) => {
          const item = viewById.get(v);
          const button = (
            <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => chooseTab(v)}>
              {item?.label ?? v}
              {item?.liveDot && statusOf(v) && <span className={`live-dot ${statusOf(v)}`} title={statusOf(v)!} />}
            </button>
          );
          return editing ? (
            <span key={v} className={`tab-edit${viewDrag.over?.id === v ? (viewDrag.over.after ? ' drop-after' : ' drop-before') : ''}`} {...viewDrag.bind(v)}>
              <span className="tab-edit-top">
                <span className="drag-grip" aria-hidden>⋮⋮</span>
                {button}
              </span>
              <MoveArrows label={item?.label ?? v} horizontal first={i === 0} last={i === views.length - 1} onBack={() => setViews(nudge(views, v, -1))} onForward={() => setViews(nudge(views, v, 1))} />
            </span>
          ) : (
            button
          );
        })}
        {activeLive && activeLive !== 'live' && <span className="muted small-text">{activeLive}…</span>}
        {inHistory && searchSupported && (
          <button className={`ghost icon search-toggle${searchOpen ? ' on' : ''}`} aria-label="Search this view" aria-pressed={searchOpen} title={`Search this view (${keyLabel('Mod+F')})`} onClick={() => setSearchOpen((o) => !o)}>
            🔍
          </button>
        )}
        <button className="fs-toggle" onClick={() => void toggleFull()} title={full ? 'Exit full screen' : 'Full screen'}>
          {full ? '✕ Exit full screen' : '⛶ Full screen'}
        </button>
      </div>

      {inHistory && searchOpen && searchSupported && (
        <ConversationSearch key={tab} rootRef={scrollRef} onClose={() => setSearchOpen(false)} onJump={() => (stuck.current = false)} />
      )}

      <div
        className={`session-scroll ${activeLive ? 'live' : ''}`}
        ref={scrollRef}
        onScroll={(e) => {
          if (!inHistory) return;
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 200) void loadEarlier();
        }}
      >
        {drawOrder.map(({ key, Component, ids }) => {
          const on = ids.includes(tab) ? viewById.get(tab) : undefined;
          return (
            <Component
              key={key}
              session={session}
              sessionId={id}
              visible={!!on}
              readable={!!on?.readable}
              registerInput={registerFor(key)}
              workspaceId={workspaceId}
              viewHeight={viewH}
              setLiveStatus={liveSetterFor(key)}
              stickToBottom={stickToBottom}
              history={historyProp}
              pending={pending}
              working={isWorking && !waitingOn ? activity : undefined}
              stopping={stopping}
              pressKey={(k) => void pressKey(k)}
              stop={() => void stop()}
            />
          );
        })}
      </div>

      <TaskStrip session={session} />
      {canDrive ? (
        Footer && (
          <Footer
            session={session}
            sessionId={id}
            history={history}
            host={askHost}
            working={isWorking}
            stopping={stopping}
            stop={() => void stop()}
            pressKey={(k) => void pressKey(k)}
            keyBusy={keyBusy}
            send={send}
          />
        )
      ) : (
        <div className="note">
          This is an interactive session: work-hub can show its status, but its screen and input are only available in the terminal it's running in.
        </div>
      )}
    </div>
  );
}



/** Without a `working-activity` provider the working bubble just keeps a still pace. */
const IDLE_ACTIVITY = { quip: '', level: 0 };
function noActivity(_sessionId: string, _enabled: boolean) {
  return IDLE_ACTIVITY;
}

/** Tells the server you've seen the session while its view is on screen (tab visible) and it isn't mid-turn. */
function useMarkSeen(session: Session) {
  const { sessionId, unread, status, waitingOnTasks } = session;
  useEffect(() => {
    // Mid-turn it isn't read yet; waiting on background tasks, its turn is over (what it said is on screen).
    if (!unread || (status === 'working' && !waitingOnTasks)) return;
    const mark = () => {
      if (document.visibilityState === 'visible') void post(`/api/sessions/${sessionId}/seen`).catch(() => {});
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [sessionId, unread, status, waitingOnTasks]);
}
