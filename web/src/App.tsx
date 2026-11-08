import { ShortcutSheet } from './components/ShortcutSheet.tsx';
import { keyLabel } from './lib/keys.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { setSources } from './sourceStore.ts';
import { get, useSources, type ClaudeData, type JobsData, type WorkspacesData } from './api.ts';
import { CORE_STATIC_PATHS, staticPage } from './lib/staticRoute.ts';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { PluginSettingsPage } from './pages/PluginSettingsPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import { WorkspacesPage } from './pages/WorkspacesPage.tsx';
import { SessionView } from './panels/SessionView.tsx';
import { Link, match, matchPattern, navigate, usePath } from './router.tsx';
import { useSlot } from './slots.ts';
import { mergeByOrder } from './lib/slotOrder.ts';
import { collectIssues, HEALTH_DOT, overallHealth, type Health } from './health.ts';
import { StatusPage } from './pages/StatusPage.tsx';
import { setLowData, useLowData } from './lowData.ts';
import { setLayoutEditing, useLayoutEditing } from './layout.ts';
import { HIDDEN, sessionRank, sessionShownStatus, showUnread, statusRank, workspaceBadge } from './status.ts';
import { useRecentIdleMs } from './recentIdle.ts';
import { ToastProvider } from './components/Toast.tsx';
import { Menu } from './components/Menu.tsx';
import { JobTray } from './components/JobTray.tsx';
import { CommandPalette, OPEN_PALETTE_EVENT, PAGE_ENTER_EVENT, type PaletteItem } from './components/CommandPalette.tsx';
import { paletteContext } from './lib/palette.ts';
import { mountedCommands } from './lib/paletteStore.ts';
import { loadPluginSettings, pluginsWithSettings, usePluginSettings } from './lib/pluginSettingsCommands.ts';
import type { PaletteCommand, PaletteCommandContext } from '../../plugin-api/web.ts';

/** A header tab: the core's (Workspaces, Status, Settings) and every `page` slot item with `nav`. */
interface NavEntry {
  key: string;
  to: string;
  label: string;
  secondary: boolean;
  title?: string;
  badge?: number;
  badgeClass: string;
  palette: boolean;
}

/** The nav entry a path belongs to: the one whose `to` it starts with (longest wins), else Workspaces. */
function activeNav(nav: NavEntry[], path: string): NavEntry | undefined {
  let best: NavEntry | undefined;
  for (const n of nav) if (n.to !== '/' && path.startsWith(n.to) && (!best || n.to.length > best.to.length)) best = n;
  return best ?? nav.find((n) => n.to === '/');
}

export function App() {
  const { sources, connected, status, newBuild } = useSources();
  // Plugins read sources through `useSource(id)` (sourceStore.ts) instead of props.
  useLayoutEffect(() => setSources(sources), [sources]);
  const path = usePath();

  const claude = (sources.claude?.data as ClaudeData | null | undefined) ?? null;
  const model = (sources.workspaces?.data as WorkspacesData | null | undefined) ?? null;
  const jobs = (sources.jobs?.data as JobsData | null | undefined)?.jobs ?? [];
  const sessions = claude?.sessions ?? [];
  const waiting = sessions.filter((s) => s.needsInput);

  // 🔴 changes requested or a connection problem, 🟠 a session is waiting on me, 🟢 all good.
  const issues = collectIssues(sources);
  const health: Health = overallHealth(issues, waiting.length);
  useAttentionSignals(waiting.map((s) => ({ id: s.sessionId, name: s.name })), health);

  // Phones: the tabs fold into a hamburger menu that closes when you pick one.
  const [menuOpen, setMenuOpen] = useState(false);
  // A jump from the palette remounts `main` (new key) with a short entrance animation; other navigation is instant.
  const [entered, setEntered] = useState(0);
  useEffect(() => {
    const on = () => setEntered((n) => n + 1);
    window.addEventListener(PAGE_ENTER_EVENT, on);
    return () => window.removeEventListener(PAGE_ENTER_EVENT, on);
  }, []);
  const lowData = useLowData();
  const warmMs = useRecentIdleMs();
  const unlocked = useLayoutEditing();
  const fires = issues.filter((i) => i.level === 'fire').length;
  const pageItems = useSlot('page');
  const paletteSlot = useSlot('palette-items');
  const commandSlot = useSlot('palette-commands');
  const settingsSections = useSlot('settings-section');
  const pluginSettings = usePluginSettings();
  const nav: NavEntry[] = mergeByOrder(
    [
      { order: 0, key: 'workspaces', to: '/', label: 'Workspaces', secondary: false, badge: waiting.length, badgeClass: 'count alert', palette: true },
      { order: 900, key: 'status', to: '/status', label: 'Status', secondary: true, title: 'Connection health', badge: fires, badgeClass: 'count bad', palette: true },
      { order: 1000, key: 'settings', to: '/settings', label: 'Settings', secondary: true, title: 'Settings', badgeClass: 'count', palette: true },
    ],
    pageItems.filter((p) => p.nav),
  ).map((x): NavEntry => {
    if (x.core) return x.core;
    const p = x.slot!;
    const to = p.nav!.to ?? (typeof p.path === 'string' ? p.path : '/');
    let badge: number | undefined;
    try {
      badge = p.nav!.badge?.(sources);
    } catch {
      badge = undefined;
    }
    return { key: `${p.plugin}:${to}`, to, label: p.nav!.label, secondary: !!p.nav!.secondary, title: p.nav!.title, badge, badgeClass: 'count', palette: p.palette !== false };
  });
  const openWorkspaceId = match('/workspaces/:id', path)?.id ?? null;
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const pages: PaletteItem[] = nav.filter((n) => n.palette).map((n) => ({ id: `page:${n.to}`, label: n.label, kind: 'page', to: n.to }));
    const workspaces: PaletteItem[] = (model?.workspaces ?? [])
      .filter((w) => w.status !== 'done')
      .map((w) => {
        const mine = w.sessions
          .map((r) => sessions.find((l) => l.sessionId === r.claudeSessionId))
          .filter((x): x is NonNullable<typeof x> => !!x && !HIDDEN.includes(x.status));
        const badge = workspaceBadge(mine, warmMs);
        const chips = mine
          .map((x) => {
            const status = sessionShownStatus(x, warmMs);
            return { x, status, unread: showUnread(status, x.unread) };
          })
          .sort((a, b) => sessionRank(a.status, a.unread) - sessionRank(b.status, b.unread))
          .map(({ x, status, unread }) => ({ id: x.sessionId, label: x.name, status, unread, to: `/workspaces/${w.id}?session=${encodeURIComponent(x.sessionId)}` }));
        const item: PaletteItem = { id: `ws:${w.id}`, label: w.title, hint: w.ticketKey ?? undefined, kind: 'workspace', to: `/workspaces/${w.id}`, status: badge ?? undefined, sessions: chips.length ? chips : undefined };
        // A workspace's tranche is its highest-priority session's (a lower one never drags it down). Parked ones never jump the queue (done ones aren't listed).
        return { item, current: w.id === openWorkspaceId, rank: w.status === 'parked' ? 4 : Math.min(3, ...chips.map((c) => statusRank(c.status, c.unread))) };
      })
      // The workspace you're in leads its own tranche.
      .sort((a, b) => a.rank - b.rank || Number(b.current) - Number(a.current))
      .map((x) => x.item);
    const fromSlot: PaletteItem[] = paletteSlot.flatMap((p) => {
      try {
        return p.items(sources);
      } catch {
        return [];
      }
    });
    return [...workspaces, ...fromSlot, ...pages];
    // `nav` is rebuilt every render; its palette part only changes with the page slot (and labels never do).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sessions, sources, paletteSlot, pageItems, warmMs, openWorkspaceId]);
  // Command mode (`>`): on-screen commands (`usePaletteCommands`), the slot's (each item asked where the user is), the core's.
  const paletteCommands = (): { ctx: PaletteCommandContext; list: PaletteCommand[] } => {
    loadPluginSettings(get); // once, the first time the commands are listed (then `usePluginSettings` re-renders)
    const where = paletteContext(path, model?.workspaces ?? []);
    const sid = where.sessionId && (sessions.find((s) => s.sessionId === where.sessionId || s.shortId === where.sessionId)?.sessionId ?? where.sessionId);
    const ctx: PaletteCommandContext = { path, ...where, sessionId: sid, sources };
    const core: PaletteCommand[] = [
      ...nav.map((n): PaletteCommand => ({ id: `core:go:${n.to}`, label: `Go to ${n.label}`, group: 'Page', run: () => navigate(n.to) })),
      { id: 'core:layout', label: unlocked ? 'Lock the layout' : 'Unlock the layout', hint: 'rearrange tabs and panels', group: 'Layout', run: () => setLayoutEditing(!unlocked) },
      ...(pluginSettings ? pluginsWithSettings(pluginSettings.plugins, pluginSettings.groups, settingsSections) : []).map(
        (p): PaletteCommand => ({ id: `core:plugin-settings:${p.id}`, label: `Settings: ${p.title}`, hint: 'plugin settings', group: 'Page', run: () => navigate(`/settings/plugins/${encodeURIComponent(p.id)}`) }),
      ),
      { id: 'core:low-data', label: lowData ? 'Turn low data off' : 'Turn low data on', hint: 'this device', group: 'Data', run: () => setLowData(!lowData) },
    ];
    const fromSlot = commandSlot.flatMap((c) => {
      try {
        return c.commands(ctx);
      } catch {
        return [];
      }
    });
    // What's on screen first (the session you're looking at, the workspace page's menu), then the slot's, then the core's.
    return { ctx, list: [...mountedCommands(), ...fromSlot, ...core] };
  };
  const conn: 'ok' | 'warn' | 'bad' = !connected || health === 'fire' ? 'bad' : health === 'waiting' ? 'warn' : 'ok';
  const connTitle = !connected
    ? 'Disconnected from the server'
    : health === 'fire'
      ? `${fires} thing${fires === 1 ? '' : 's'} need fixing (see Status)`
      : health === 'waiting'
        ? `${waiting.length} session${waiting.length === 1 ? '' : 's'} waiting on you`
        : 'Connected, all good';
  useEffect(() => setMenuOpen(false), [path]);

  const current = activeNav(nav, path);

  // Core routes first, so a plugin page can't shadow them; then the `page` slot in slot order. A plugin page with a static
  // path (e.g. `/workspaces/new`) still beats the core's param routes (lib/staticRoute.ts).
  let page;
  let params;
  let fixed;
  if (path === '/' || path === '/workspaces') page = <WorkspacesPage data={model} claude={claude} />;
  else if ((fixed = staticPage(pageItems, path, CORE_STATIC_PATHS))) page = <fixed.component key={path} path={path} params={{}} sources={sources} />;
  else if ((params = match('/workspaces/:id', path))) page = <WorkspacePage key={params.id} id={params.id} data={model} claude={claude} />;
  else if ((params = match('/sessions/:id', path))) {
    const id = params.id;
    const session = sessions.find((s) => s.sessionId === id || s.shortId === id);
    const owner = model?.workspaces.find((w) => w.sessions.some((r) => r.claudeSessionId === session?.sessionId || r.shortId === id));
    const back = owner ? { to: `/workspaces/${owner.id}`, label: owner.title } : { to: '/', label: 'Workspaces' };
    page = session ? (
      <SessionView key={session.sessionId} session={session} back={back} canTrash={!owner} />
    ) : (
      <div className="page">
        <Link to={back.to} className="back">
          ← {back.label}
        </Link>
        <p className="muted">{claude ? 'This session is no longer running.' : 'Loading…'}</p>
      </div>
    );
  } else if (path === '/settings') page = <SettingsPage />;
  else if (path.startsWith('/settings/plugins/')) page = <PluginSettingsPage key={path} id={decodeURIComponent(path.slice('/settings/plugins/'.length))} />;
  else if (path === '/status') page = <StatusPage sources={sources} issues={issues} />;
  else {
    for (const item of pageItems) {
      const p = matchPattern(item.path, path);
      if (!p) continue;
      const Page = item.component;
      page = <Page key={path} path={path} params={p} sources={sources} />;
      break;
    }
  }
  page ??= (
    <div className="page">
      <p className="muted">Nothing here.</p>
      <Link to="/">← Workspaces</Link>
    </div>
  );

  return (
    <ToastProvider>
    <div className="app">
      <header className="topbar">
        <button
          className="menu-btn"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          ☰
          {!menuOpen && (waiting.length > 0 || issues.some((i) => i.level === 'fire')) && <span className="menu-badge" />}
        </button>
        <span className="topbar-title">{current?.label}</span>
        <nav className={`tabs ${menuOpen ? 'open' : ''}`}>
          {nav.map((n) => {
            const on = n === current ? 'on' : '';
            return (
              <Link key={n.key} to={n.to} className={n.secondary ? `tab-secondary ${on}` : on} title={n.title}>
                {n.key === 'settings' ? (
                  <>
                    <span className="gear">⚙</span>
                    <span className="tab-label-mobile">Settings</span>
                  </>
                ) : (
                  n.label
                )}
                {!!n.badge && n.badge > 0 && <span className={n.badgeClass}>{n.badge}</span>}
              </Link>
            );
          })}
          <span className="tab-more">
            <Menu
              ariaLabel="More pages"
              className={`more-btn ${current?.secondary ? 'on' : ''}`}
              trigger={
                <>
                  More
                  {fires > 0 && <span className="count bad">{fires}</span>}
                </>
              }
              items={nav
                .filter((n) => n.secondary)
                .map((n) => ({ label: n.badge ? `${n.label} (${n.badge})` : n.label, onSelect: () => navigate(n.to) }))}
            />
          </span>
        </nav>
        <div className="pills">
          <JobTray jobs={jobs} />
          <button className="ghost palette-btn" aria-label="Search" title={`Jump to (${keyLabel('Mod+K')}); commands: > or ${keyLabel('Mod+Shift+K')}`} onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}>
            <span className="palette-icon">🔍</span>
            <span className="palette-hint">{keyLabel('Mod+K')}</span>
          </button>
          <ShortcutSheet />
          {newBuild && (
            <button className="pill low-data" onClick={() => location.reload()} title="A new version was deployed; reload to get it">
              New version ↻
            </button>
          )}
          {lowData && (
            <Link to="/settings" className="pill low-data" title="Low data mode is on: some views refresh only on tap">
              Low data
            </Link>
          )}
          {status && !status.active && (
            <span className="pill" title="Polling is paused while the computer is idle; ↻ still refreshes">
              paused
            </span>
          )}
          <button
            className={`ghost layout-lock${unlocked ? ' on' : ''}`}
            aria-pressed={unlocked}
            aria-label={unlocked ? 'Lock the layout' : 'Unlock the layout'}
            title={unlocked ? 'Lock the layout' : 'Unlock to rearrange the panels (applies everywhere)'}
            onClick={() => setLayoutEditing(!unlocked)}
          >
            {unlocked ? '🔓' : '🔒'}
          </button>
          <Link to="/status" className={`conn conn-${conn}`} title={connTitle} aria-label={connTitle}>
            <span className={`dot ${conn}`} />
          </Link>
        </div>
      </header>
      <CommandPalette items={paletteItems} commands={paletteCommands} />
      <AppBanners />
      <main key={entered} className={entered ? 'page-enter' : undefined}>{page}</main>
    </div>
    </ToastProvider>
  );
}

/** Banners under the header (`app-banner` slot), e.g. the auth plugin's passkey offer after a token sign-in. */
function AppBanners() {
  const items = useSlot('app-banner');
  return (
    <>
      {items.map((b) => (
        <b.component key={`${b.plugin}:${b.id}`} />
      ))}
    </>
  );
}

/** Tab title shows a health dot; a desktop notification fires when a session starts waiting on you. */
function useAttentionSignals(waiting: Array<{ id: string; name: string }>, health: Health) {
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    document.title = `${HEALTH_DOT[health]} work-hub`;
  }, [health]);

  useEffect(() => {
    const ids = new Set(waiting.map((w) => w.id));
    if (seen.current && 'Notification' in window && Notification.permission === 'granted') {
      for (const w of waiting) {
        if (seen.current.has(w.id)) continue;
        const n = new Notification('Claude is waiting on you', { body: w.name, tag: w.id });
        // Clicking it brings the tab forward and opens that session.
        n.onclick = () => {
          window.focus();
          navigate(`/sessions/${w.id}`);
          n.close();
        };
      }
    }
    seen.current = ids;
  }, [waiting.map((w) => w.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  }, []);
}
