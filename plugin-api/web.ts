/**
 * The only core module a plugin's web code may import (plus npm packages and its own files). Official plugins import it
 * by relative path, local ones as `work-hub/plugin-api/web` (a Vite alias and a tsconfig path point here).
 *
 * Two ways in, same objects: the `WebPluginContext` a plugin's `register(ctx)` gets (its `contribute` tags items with the
 * plugin's id and `usePersisted` namespaces keys under it), and the plain re-exports below for the plugin's other files
 * (components, hooks, helpers), so a page component doesn't need `ctx` threaded through.
 *
 * Slots: every known slot name and its item type is in `SlotItems`. A plugin may use a slot name of its own (any other
 * string; items are then `SlotBase` plus whatever fields it likes) or add a typed one by augmenting `SlotItems`:
 *   declare module 'work-hub/plugin-api/web' { interface SlotItems { 'my-plugin:widgets': SlotBase & { label: string } } }
 */
import type { ComponentType, Context, CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createContext } from 'react';
import type { PluginManifest } from './manifest.ts';
import type {
  ClaudeData,
  FileEdit,
  HistoryEntry,
  HubStatus,
  Job,
  JobsData,
  Session,
  SourceState,
  Workspace,
  WorkspacesData,
} from '../web/src/api.ts';
import type { Link as WorkspaceLink, Worktree } from '../server/store/workspaces.ts';
import type { HistoryHost, TranscriptNotice } from '../server/lib/transcript.ts';
import type { Working } from '../web/src/components/WorkingPulse.tsx';
import type { Issue } from '../web/src/health.ts';
import type { MenuItem } from '../web/src/components/Menu.tsx';
import type { ToastInput } from '../web/src/components/Toast.tsx';
import type * as api from '../web/src/api.ts';
import type * as router from '../web/src/router.tsx';
import type * as components from '../web/src/components/kit.ts';

export { API_VERSION } from './manifest.ts';
/** The models a session can be started on, strongest first (`SessionModel` is one of them). */
export { SESSION_MODELS, type SessionModel } from './models.ts';
export * from '../web/src/components/kit.ts';
/** The file-change pieces behind FilesBrowser (a change's one-line summary and body, the tree, path split, card state). */
export { buildTree, EditBody, EditSummary, splitPath, type State as EditState } from '../web/src/components/FilesBrowser.tsx';
export { ago, get, post } from '../web/src/api.ts';
export { Link, match, navigate, usePath } from '../web/src/router.tsx';
export { useLowData, lowDataOn } from '../web/src/lowData.ts';
/** "as of 3m ago ↻" for views that stopped refreshing by themselves (Low data); renders nothing until `at` is set. */
export { AsOf } from '../web/src/components/AsOf.tsx';
export { useToast } from '../web/src/components/Toast.tsx';
export { SessionIdContext } from '../web/src/components/SessionIdContext.ts';
export { useSlot, slotItems } from '../web/src/slots.ts';
/** Keyboard shortcuts on every platform: `isMod(e)` (⌘ on a Mac, Ctrl elsewhere), `keyLabel('Mod+K')` (⌘K / Ctrl+K), `IS_MAC`. */
export { IS_MAC, isMod, keyLabel } from '../web/src/lib/keys.ts';
/** Fuzzy filter + rank: `fuzzyRank(items, query, text, limit?)` (the command palette's and the `/` picker's). */
export { rank as fuzzyRank } from '../web/src/lib/fuzzy.ts';
/** Open the ⌘K palette, optionally prefilled: `openPalette('>')` opens it on the commands. */
export { openPalette } from '../web/src/lib/palette.ts';
/**
 * `usePaletteCommands(list | null)`: offer commands in the palette's command mode while the calling component is mounted
 * (for what's on screen, e.g. a panel's actions); the latest list is read whenever the palette renders.
 */
export { usePaletteCommands } from '../web/src/lib/paletteStore.ts';
export { useSource, useAllSources } from '../web/src/sourceStore.ts';
export { Markdown, hastText } from '../web/src/components/Markdown.tsx';
/** Which conversation view is drawing (Chat: `readable`, or the raw Log); null outside one. Markdown overrides read it. */
export { LogViewContext, type LogView } from '../web/src/components/LogViewContext.ts';
/** A log timestamp as the conversation shows it: the time today, else date and time. */
export { logTime } from '../web/src/lib/logTime.ts';
/** The `host-provider` item (read once per component, so its hooks are safe behind `hp ?`) and its hosts (null when off). */
export { useHostProvider, useProviderHosts } from '../web/src/hostProvider.ts';
/** The working bubble's pulse (dots + spinner word at the terminal's pace); `decor` dresses it up. */
export { WorkingPulse, type PulseDecor, type Working } from '../web/src/components/WorkingPulse.tsx';
export { STATUS_LABEL, FINISHED, HIDDEN, displayStatus, showUnread, statusLabel, statusTitle, trashHint } from '../web/src/status.ts';
/** `useState` for a nullable string kept in localStorage under an exact key (for keys that predate `ctx.usePersisted`). */
export { usePersistedPick, usePersistedString } from '../web/src/persist.ts';
/**
 * highlight.js helpers (`highlightLines`, `highlightOutput`…), loaded on demand so highlight.js stays out of the main
 * bundle: the same chunk as `ctx.highlightCode()`, importable from any module of a plugin (no context needed).
 */
export const loadHighlightCode = (): Promise<typeof import('../web/src/highlightCode.ts')> => import('../web/src/highlightCode.ts');
/**
 * The "▶ Terminal" handler a `!` command card calls: opens a new workspace terminal running `command` and shows it. The
 * command-runs plugin's cards read it; the terminals plugin provides it on a workspace page (absent elsewhere, e.g. a
 * session that isn't in a workspace, so the card has no Terminal button there). Core-owned, so neither depends on the other.
 */
export const TerminalRunContext = createContext<((command: string, sessionId: string) => Promise<void>) | null>(null);

export type {
  PluginManifest,
  ClaudeData,
  FileEdit,
  HistoryEntry,
  HubStatus,
  TranscriptNotice,
  Issue,
  Job,
  JobsData,
  MenuItem,
  Session,
  SourceState,
  ToastInput,
  Workspace,
  WorkspaceLink,
  WorkspacesData,
  Worktree,
};

/** Every slot item carries the contributing plugin's id (filled in by `ctx.contribute`) and an optional sort key. */
export interface SlotBase {
  plugin: string;
  /** Lower first; default 100. Ties keep registration order. */
  order?: number;
}

export type Sources = Record<string, SourceState>;

/** A path pattern: "/prs/:owner/:repo" style string, a RegExp (named groups become params) or a matcher. */
export type PathPattern = string | RegExp | ((path: string) => Record<string, string> | null);

export interface PageProps {
  path: string;
  params: Record<string, string>;
  sources: Sources;
}

/**
 * A page. Core routes (workspaces, sessions, Settings, Status) are matched first, so a page can't shadow them, except that a
 * static string path (no `:param`) beats the core's param routes (`/workspaces/new` over `/workspaces/:id`). With
 * `nav`, it gets a header tab (`secondary`: under "More" on desktop) that is "on" for every path starting with `to`
 * (default: `path` when it's a string); nav entries sort among the core ones (Workspaces 0, Status 900, Settings 1000)
 * by `order`. Nav pages are listed in the ⌘K palette unless `palette` is false.
 */
export interface PageItem extends SlotBase {
  path: PathPattern;
  component: ComponentType<PageProps>;
  nav?: { label: string; to?: string; secondary?: boolean; title?: string; badge?: (sources: Sources) => number | undefined };
  palette?: boolean;
}

/**
 * Where typed text and keys go while this view is the active one (null = the core's POST /send and /key). Returning
 * `false` means "not delivered right now" (e.g. a live connection that dropped): the core then falls back to the POST.
 */
export interface InputSink {
  send(text: string): boolean | void;
  key(k: string): boolean | void;
}

/** A message you sent that hasn't shown up in the transcript yet. */
export interface PendingMessage {
  key: string;
  text: string;
  state: 'sending' | 'sent';
  at: number;
  /** Sent while Claude was busy, so it waits its turn ("queued", with Send now) below the working bubble. */
  queued?: boolean;
}

/**
 * The session's conversation as the core loads it (`GET /api/sessions/:id/history`): the latest page first, then polled
 * for new entries (3s; 10s in low data, 3s for a minute after you send or the status changes).
 */
export interface SessionHistory {
  /** Loaded entries, oldest first. */
  entries: HistoryEntry[];
  /** Older entries exist that aren't loaded yet. */
  hasMore: boolean;
  /** How many older entries aren't loaded. */
  earlier: number;
  /** "Load earlier" is fetching. */
  loading: boolean;
  /** Prepend the previous page (keeps the scroll position relative to the bottom). */
  loadEarlier(): void;
  /** The resident host the transcript names (the history route's `host`). */
  resident: ResidentHost | null;
  /** How many notices (hook feedback, task notifications) the session has: the history route's `noticeCount`. */
  noticeCount: number;
}

export interface SessionViewProps {
  session: Session;
  sessionId: string;
  visible: boolean;
  registerInput(sink: InputSink | null): void;
  workspaceId?: string;
  /** The active item's `readable` flag (items sharing one component, like Chat and Log, share one instance). */
  readable?: boolean;
  /** The visible height of the session's scroll area in px (a view that fills it, like the live terminal, sizes to this). */
  viewHeight: number;
  /**
   * For `liveDot` items: the connection status to show as the tab's dot (its CSS class: connecting, live, reconnecting,
   * failed, ended), or null for no dot. While the item is active and this isn't null, the scroll area stops scrolling
   * (the view fills it) and "<status>…" shows beside the tabs until it is 'live'.
   */
  setLiveStatus(status: string | null): void;
  /** Call after the view's content changed: the core keeps the scroll area at the bottom unless you scrolled up. */
  stickToBottom(): void;
  /** The conversation the core has loaded. */
  history?: SessionHistory;
  /** Messages you sent that the transcript doesn't show yet. */
  pending?: PendingMessage[];
  /** Set while Claude is processing (its spinner word and how fast its terminal changes); undefined when it isn't. */
  working?: Working;
  /** An interrupt (Esc) was just sent. */
  stopping?: boolean;
  /** Send a key (see the core's allow-list: 'Enter', 'Escape', 'C-X-C-S'…) through the active input sink, else POST /key. */
  pressKey?(key: string): void;
  /** Interrupt Claude (Esc), only meaningful while `working`. */
  stop?(): void;
}

/** What the core hands a view's `footer` (the Chat view's prompt box): the session and the ways to talk to it. */
export interface SessionFooterProps {
  session: Session;
  sessionId: string;
  /** The session's loaded conversation (a question still waiting for an answer shows as an entry with `questions` and no `result`). */
  history: HistoryEntry[];
  /** The resident menagerie host framing this session's questions (undefined when there is none or the host-provider is off). */
  host?: HostRef;
  /** Claude is processing (its job says so, or you just sent something its transcript doesn't answer yet). */
  working: boolean;
  /** An interrupt (Esc) was just sent. */
  stopping: boolean;
  /** Interrupt Claude (Esc), only meaningful while `working`. */
  stop(): void;
  /** Send a key (see the core's allow-list) through the active input sink, else POST /key. */
  pressKey(key: string): void;
  /** The key a `pressKey` is waiting on (only when no live terminal took it), else null. */
  keyBusy: string | null;
  /**
   * Send `text` as a message: it shows in the conversation as "sending…" then "sent ✓" until the transcript has it (queued
   * if Claude is busy). Resolves once delivered; rejects with the reason if it couldn't be.
   */
  send(text: string): Promise<void>;
}

export interface SessionViewItem extends SlotBase {
  id: string;
  label: string;
  component: ComponentType<SessionViewProps>;
  /**
   * Drawn by the core under the scroll area while this item is the active one (a view with no footer has nothing there:
   * no prompt box). Only for sessions the app can drive; an interactive session gets the core's "work in your terminal" note.
   */
  footer?: ComponentType<SessionFooterProps>;
  default?: boolean;
  /** The view reads the transcript, so the core loads history while it shows (and offers 🔍 find over it). */
  needsHistory?: boolean;
  /** Passed to the component as `readable` while this item is the active one. */
  readable?: boolean;
  /** A live-connection dot on the tab, from what the view reports with `setLiveStatus`. */
  liveDot?: boolean;
}

/**
 * How busy Claude's screen is while it works, for the Chat view's working bubble (the live-terminal plugin reads it off
 * `/api/sessions/:id/screen`). A hook: called on every render of the session page; poll only while `enabled`.
 *
 * Hook-in-slot rule: a slot whose items carry hooks (`useActivity` here, `useItem`, `useTabs`, `useHosts`…) must be read
 * with `useSlotOnce`, never `useSlot`: an item contributed or removed after mount would change the hook count between
 * renders. Plugins contribute at module init, before the first render, so nothing is missed.
 */
export interface WorkingActivityItem extends SlotBase {
  useActivity(sessionId: string, enabled: boolean): Working;
}

export interface WorkspacePanelProps {
  workspace: Workspace;
  visible: boolean;
  sources: Sources;
}

/** A tab of the workspace page's right-hand switcher (Details is core; Diff, Note, Code…). */
export interface WorkspacePanelItem extends SlotBase {
  id: string;
  label: string;
  component: ComponentType<WorkspacePanelProps>;
  /** Wide tools (Note, Code) slide over the terminal column at laptop widths. */
  wide?: boolean;
}

/**
 * A section of the Details tab (Pull requests…); `isEmpty` hides it (a dimmed placeholder while the layout is unlocked).
 * Sorted among the core sections (Links 10, Worktrees 30, Plan & notes 40, Activity 50) by `order`.
 */
export interface WorkspaceSectionItem extends SlotBase {
  id: string;
  title: string;
  component: ComponentType<{ workspace: Workspace; sources: Sources }>;
  isEmpty?(workspace: Workspace, sources: Sources): boolean;
  /** URLs this section already shows: the core's Links section leaves them out. */
  shownUrls?(workspace: Workspace, sources: Sources): string[];
}

/** What a workspace tab kind's hook gets from the workspace page. */
export interface WorkspaceTabKindContext {
  workspaceId: string;
  /** Null while the workspaces source is loading. */
  workspace: Workspace | null;
  /** The main pane (e.g. to size a new terminal to it). */
  paneRef: RefObject<HTMLElement | null>;
  /** The session the main pane would show (the picked one, else the default). */
  selectedSession: Session | null;
  /** Call after picking one of this kind's tabs: the page closes the new-session form and un-picks other kinds. */
  took(): void;
}

/** What a workspace tab kind's hook returns on every render. */
export interface WorkspaceTabKindState {
  /** Tab nodes for the strip; ids are `<prefix><id>` (the saved tab order uses them). */
  tabs: Array<{ id: string; node: ReactNode }>;
  /** This kind's picked tab id (with prefix) while it holds the main pane, else null. */
  active: string | null;
  /** Picked, but the list isn't loaded yet: the main pane stays empty rather than flashing a session. */
  pending?: boolean;
  /** The main pane while `active` is set. */
  pane: ReactNode;
  /** Un-pick (a session was picked instead). */
  clear(): void;
  /** Entries for the tab strip's + menu (after "New session"). */
  menu?: MenuItem[];
  /** Drawn after the + button (e.g. an "as of" in low data). */
  after?: ReactNode;
  /** Drawn under the workspace header (e.g. a load error). */
  banner?: ReactNode;
  /** Wraps the session view (e.g. a context provider for its cards). */
  wrapSession?(children: ReactNode): ReactNode;
}

/**
 * Things in the workspace tab strip besides sessions (terminals). `useTabs` is a hook, called once per render of the
 * workspace page (the page reads this slot once when it mounts, so the hook count never changes).
 */
export interface WorkspaceTabKindItem extends SlotBase {
  id: string;
  prefix: string;
  useTabs(ctx: WorkspaceTabKindContext): WorkspaceTabKindState;
}

/** What a `log-card` renderer gets. */
export interface LogCardContext {
  sessionId: string;
  /** Chat (true) or the raw Log (false). */
  readable: boolean;
  /** The entry's position in the loaded list (a run's: its first entry's). */
  index: number;
}

/**
 * Cards for conversation entries in Chat and Log (drawn by the conversation-view plugin). Every item whose `match` says
 * yes contributes, in slot order (one Bash call can show its file changes, then its git card); entries nobody matches
 * get the default rendering (text, your messages, questions as Q&A, other tool calls folded into "⋯ N steps" in Chat or
 * a collapsible tool row in Log).
 *
 * - Chat: a tool entry's cards sit on Claude's side; any other entry's on its own side, in place of its default part.
 *   With `run`, consecutive contributions of this item whose `run.key` is equal (and not null) collapse into one
 *   `run.render`. Tool steps folded in between don't break a run; anything else drawn does (text, messages, questions,
 *   another card), and steps taken during the run are drawn after its card. A null key draws that entry alone (`render`).
 * - Log: no runs. A tool entry keeps its row (name, summary, result) with the cards inside it, above the result; any
 *   other entry's row is replaced by the cards (so `render` draws the whole row there).
 */
export interface LogCardItem extends SlotBase {
  id: string;
  match(entry: HistoryEntry): boolean;
  render(entry: HistoryEntry, ctx: LogCardContext): ReactNode;
  run?: { key(entry: HistoryEntry): string | null; render(entries: HistoryEntry[], ctx: LogCardContext): ReactNode };
  /** Chat: the label when one of these cards opens a group on your side (default "You"; " · <time>" is added). */
  label?: string;
  /** Wraps the whole conversation, Chat and Log (mounted while the view is, shown or not): e.g. a context its cards read. */
  Wrap?: ComponentType<{ sessionId: string; entries: HistoryEntry[]; children: ReactNode }>;
  /**
   * Drawn in the Chat (inside every Wrap) for something you started that the transcript doesn't show yet, e.g. a `!`
   * command. `started`: it began a turn, so it sits above Claude's working bubble; `waiting`: it's still waiting for its
   * turn (after the working bubble). Draws its own `msg-group user` markup, or nothing.
   */
  Pending?: ComponentType<{ sessionId: string; stage: 'started' | 'waiting' }>;
}

export type MarkdownTag = 'pre' | 'code' | 'p' | 'li' | 'td' | 'a';

/**
 * Replaces how a Markdown element renders in every `Markdown` (later contributions win). An override that should only
 * apply in one conversation view reads `LogViewContext`.
 */
export interface MarkdownOverrideItem extends SlotBase {
  tag: MarkdownTag;
  // react-markdown hands each element its own props (`node`, `children`, attributes…).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
}

/** Plain-text decoration in `Linkify` (between URLs): the first item that returns non-null renders the text. */
export interface InlineTextItem extends SlotBase {
  render(text: string, key: string): ReactNode | null;
}

/** A key handler an addon registers while it wants keys: return true when it used the key (the box then skips its own handling). */
export type ComposerKeyHandler = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;

export interface ComposerAddonProps {
  session: Session;
  sessionId: string;
  draft: string;
  setDraft(text: string): void;
  /** Send the draft, or `text` when given. */
  send(text?: string): void;
  /** The prompt box's textarea (to focus it after filling the draft). */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Register (or, with null, remove) this addon's keydown handler. The addon's state lives in its component, so it
   * registers a handler while it is open; the box asks registered handlers first, the first returning true wins.
   */
  registerKeyHandler(fn: ComposerKeyHandler | null): void;
  /** The session's loaded conversation (so an addon can react to e.g. a question still waiting for an answer). */
  history: HistoryEntry[];
  /** The resident menagerie host framing this session's questions (undefined when there is none or the host-provider is off). */
  host?: HostRef;
}

/** Something drawn with the prompt box (above it, or a picker over it). */
export interface ComposerAddonItem extends SlotBase {
  id: string;
  component: ComponentType<ComposerAddonProps>;
}

export interface SessionHeaderItem extends SlotBase {
  id: string;
  component: ComponentType<{ session: Session; sessionId: string; workspaceId?: string }>;
}

/**
 * A menu item contributed to one of the core's menus; `useItem` may use hooks and returns null to hide it (the menu
 * reads the slot once when it mounts, so the hook count never changes). With `dialog`, selecting the item opens it
 * (after the item's own `onSelect`, if any); it's rendered until it calls `onClose`.
 */
export interface MenuActionItem<C> extends SlotBase {
  id: string;
  useItem(ctx: C): MenuItem | null;
  dialog?: ComponentType<C & { onClose(): void }>;
}

export type WorkspaceActionItem = MenuActionItem<{ workspace: Workspace }>;
export type SessionActionItem = MenuActionItem<{ session: Session; sessionId: string; workspaceId?: string }>;
export type TabstripActionItem = MenuActionItem<{ workspace: Workspace }>;

/**
 * A button or link on a worktree row in Details. `useData` (a hook, once per workspace render rather than per row) loads
 * what every row needs; its result reaches the component as `data`.
 */
export interface WorktreeActionItem extends SlotBase {
  id: string;
  useData?(workspace: Workspace, sources: Sources): unknown;
  component: ComponentType<{ workspace: Workspace; worktree: Worktree; sources: Sources; data: unknown }>;
}

/**
 * An indicator on a workspace's card on the Workspaces page, in the row under its title beside the core's session counts
 * (e.g. the github plugin's PR chips). Render compact chips that wrap; render null when there's nothing to show. The
 * card is clickable, so a link or button inside it is fine (it doesn't also open the workspace).
 */
export interface WorkspaceCardItem extends SlotBase {
  id: string;
  component: ComponentType<{ workspace: Workspace; sources: Sources }>;
}

/** A button or link in the Workspaces page header (beside the group-by switch), e.g. "+ New workspace". */
export interface WorkspaceListActionItem extends SlotBase {
  id: string;
  component: ComponentType;
}

/**
 * A button or link in a row at the top of Settings → Plugins, above the plugin list (e.g. plugin-author's "Create
 * plugin"). The row wraps; it isn't drawn when the slot is empty.
 */
export interface PluginsActionItem extends SlotBase {
  id: string;
  component: ComponentType;
}

/** A button on the PR page. */
export interface PrActionItem extends SlotBase {
  id: string;
  component: ComponentType<{ owner: string; repo: string; number: number; pr?: unknown }>;
}

/**
 * A tab of its own on the PR page (/prs/:owner/:repo/:number), after Conversation, Files and Checks (the github plugin
 * draws it; absent while that plugin is off). `id` is also the tab's URL hash (`#<id>`), so a link can open it. The
 * component is mounted only while its tab is picked; `pr` is the page's loaded `PrDetail` (the github plugin's type),
 * refreshed when the page polls.
 */
export interface PrTabItem extends SlotBase {
  id: string;
  label: string;
  component: ComponentType<{ owner: string; repo: string; number: number; pr: unknown }>;
}

/**
 * A `<section className="block">` on Settings, under an `<h3>` with `title` (none when empty). Sorted among the core
 * sections (Workspaces 20, Data 30, Plugins 60) by `order`; by default it sits on its plugin's own settings page instead.
 */
export interface SettingsSectionItem extends SlotBase {
  id: string;
  title: string;
  component: ComponentType;
  /**
   * By default a section belongs to its plugin's own settings page (Settings → Plugins → <plugin> → Settings). `'app'`
   * keeps it on the main Settings page, for what is about the whole app and not the plugin (e.g. sign out).
   */
  scope?: 'app';
}

/**
 * A block on the Status page; it draws its own `<section>` (see `SourceBlock`). Sorted among the core blocks (Needs
 * attention 10, Plugins 15, Data sources 40) by `order`.
 */
export interface StatusBlockItem extends SlotBase {
  id: string;
  title?: string;
  component: ComponentType<{ sources: Sources; issues: Issue[] }>;
}

/** A banner under the app header on every page (it renders nothing when it has nothing to say). */
export interface AppBannerItem extends SlotBase {
  id: string;
  component: ComponentType;
}

/** Feeds the health dot and the Status page. */
export interface HealthIssuesItem extends SlotBase {
  collect(sources: Sources): Issue[];
}

export interface PaletteEntry {
  id: string;
  label: string;
  hint?: string;
  kind: string;
  /** What the row's kind column says (default: `kind` itself). */
  kindLabel?: string;
  /** Shown as a status badge (and unread dot) at the row's end. */
  status?: { status: string; unread?: boolean };
  /**
   * A workspace's live sessions, most urgent first. The row shows three at a time (← → select one and slide the rest
   * in); Enter opens the workspace with the selected one.
   */
  sessions?: Array<{ id: string; label: string; status: string; unread?: boolean; to: string }>;
  to: string;
}

export interface PaletteItemsItem extends SlotBase {
  items(sources: Sources): PaletteEntry[];
}

/** Where the user is when the palette opens, for `palette-commands` items to decide which commands apply. */
export interface PaletteCommandContext {
  path: string;
  /** The workspace being viewed: its page, or the page of a session it owns (null elsewhere). */
  workspaceId: string | null;
  /** The session whose own page is open (`/sessions/:id`), else null. */
  sessionId: string | null;
  sources: Sources;
}

/** One command in the palette's command mode (a query starting with `>`). */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Extra words to match on and shown dimmed after the label. */
  hint?: string;
  /** The row's kind column (default "Command"), e.g. "Workspace", "Go to". */
  group?: string;
  /** Runs after the palette closes; a rejected promise or a throw shows its message as an error toast. */
  run(ctx: PaletteCommandContext): void | Promise<unknown>;
}

/**
 * Commands for the palette's command mode (typing `>` in it, or pressing `>` outside an input). `commands` is called when
 * the palette opens and as the context changes: return only the commands that apply (e.g. none outside a workspace).
 */
export interface PaletteCommandsItem extends SlotBase {
  commands(ctx: PaletteCommandContext): PaletteCommand[];
}

/**
 * A keyboard shortcut listed in the header's ⌨ cheat sheet (and nowhere else: the plugin still handles the key itself).
 * `keys` are combos in `Mod+Shift+K` form (`Mod` = ⌘ on a Mac, Ctrl elsewhere; see `keyLabel`/`isMod`), alternatives
 * shown side by side. `group` is a heading such as "Anywhere", "Session" or "Prompt box"; `where` says when it works.
 */
export interface ShortcutItem extends SlotBase {
  keys: string[];
  label: string;
  group: string;
  where?: string;
}

/** How a background job kind shows in the header tray. */
export interface JobKindItem extends SlotBase {
  kind: string;
  icon?: string;
  label?: string;
}

/**
 * What a workspace link is, for its tag in Details → Links (`kind` is the tag's id, also its `kind-<id>` CSS class).
 * The first item whose `match` says yes wins; the core's defaults (PR, Jira, Confluence, Slack…) come after the slot.
 */
export interface LinkKindItem extends SlotBase {
  kind: string;
  icon?: string;
  label?: string;
  /** `recordedKind` is the kind the link was recorded with (`wh link --kind`). Without `match`: `recordedKind === kind`. */
  match?(url: string, recordedKind: string): boolean;
  render?(link: WorkspaceLink): ReactNode;
}

/** Where the transcript last says a resident host moved in or took over (`host` on GET /api/sessions/:id/history). */
export type ResidentHost = HistoryHost;

/** A host as the core sees it: the provider's own host type has more, and the core only ever hands hosts back to it. */
export interface HostRef {
  id: string;
  name: string;
}

/** A host's closing aside, peeled off an assistant message by `splitAside`. */
export interface HostAside {
  host: HostRef;
  text: string;
}

/** What a host styles: a Chat bubble group, a question in the log, the question form, the form's "sent" line. */
export type HostPart = 'group' | 'ask' | 'qform' | 'qform-sent';

/**
 * A resident host (the menagerie plugin): the Chat/Log view, the question form and the session page read the first
 * item, fixed for the page's life (`useSlotOnce`, since `useHosts`/`useQuipPhase` are hooks). Without one they render
 * plainly: asides stay Markdown, no portraits, no tint. Methods (not function-typed fields) so a provider can type its
 * parameters with its own host type.
 */
export interface HostProviderItem extends SlotBase {
  /** The hosts to style with, or null when that's switched off on this device (a hook). */
  useHosts(): HostRef[] | null;
  /** Whether host styling is on on this device (a hook). */
  useMenagerieOn(): boolean;
  /** The session's host: who left the latest aside, unless the transcript's greeting or swap (`resident`) is newer. */
  lastHost(entries: HistoryEntry[], hosts: HostRef[] | null, resident?: ResidentHost | null): HostRef | undefined;
  /** Splits a host's aside off the end of a message (null: none). */
  splitAside(markdown: string, hosts: HostRef[]): { body: string; aside: HostAside } | null;
  /** One of the host's question lines, the same one every time for a given `seed`. */
  askLine(host: HostRef, seed: string): string | undefined;
  /** CSS variables carrying the host's palette. */
  hostVars(host: HostRef): CSSProperties;
  /** Classes and palette that style `part` after the host. */
  frame(host: HostRef, part: HostPart): { className: string; style: CSSProperties };
  AsideCard(props: { aside: HostAside }): ReactNode;
  /** The working bubble in the host's style. */
  WorkingPulse(props: { working: Working; host: HostRef }): ReactNode;
  /** The portrait and ask line above a question; `inLog`: the logged question (a quip box, no name) rather than the form. */
  AskHeader(props: { host: HostRef; line?: string; inLog?: boolean }): ReactNode;
  /** The real working bubble, question and aside in a mock Chat log (the faces page). */
  HostInContext(props: { host: HostRef }): ReactNode;
  /** The quip box's phase for the bottom-most host group (`quipId`: '' = none; `answered`: you've replied below it). */
  useQuipPhase(quipId: string, answered: boolean): 'in' | 'bye' | 'gone';
  /** Wraps a Chat group: whether its quip box shows, and whether it's leaving. */
  QuipScope(props: { show: boolean; bye: boolean; children: ReactNode }): ReactNode;
}

export interface SlotItems {
  page: PageItem;
  'session-view': SessionViewItem;
  'workspace-panel': WorkspacePanelItem;
  'workspace-section': WorkspaceSectionItem;
  'workspace-tab-kind': WorkspaceTabKindItem;
  'log-card': LogCardItem;
  'markdown-override': MarkdownOverrideItem;
  'inline-text': InlineTextItem;
  'composer-addon': ComposerAddonItem;
  'session-header': SessionHeaderItem;
  'workspace-action': WorkspaceActionItem;
  'session-action': SessionActionItem;
  'tabstrip-action': TabstripActionItem;
  'worktree-action': WorktreeActionItem;
  'pr-action': PrActionItem;
  'pr-tab': PrTabItem;
  'workspace-list-action': WorkspaceListActionItem;
  'workspace-card': WorkspaceCardItem;
  'plugins-action': PluginsActionItem;
  'settings-section': SettingsSectionItem;
  'status-block': StatusBlockItem;
  'health-issues': HealthIssuesItem;
  'app-banner': AppBannerItem;
  'palette-items': PaletteItemsItem;
  'palette-commands': PaletteCommandsItem;
  'job-kind': JobKindItem;
  'link-kind': LinkKindItem;
  'host-provider': HostProviderItem;
  'working-activity': WorkingActivityItem;
  shortcut: ShortcutItem;
}

/** A known slot name, or any other string for a plugin's own slot. */
export type SlotName = keyof SlotItems | (string & {});
export type SlotItem<K extends SlotName> = K extends keyof SlotItems ? SlotItems[K] : SlotBase & Record<string, unknown>;
/** What a plugin passes to `ctx.contribute`: the item without `plugin` (the context fills it in). */
export type SlotInput<K extends SlotName> = Omit<SlotItem<K>, 'plugin'> & { plugin?: string };

/** What a plugin's `web.tsx` default export receives. */
export interface WebPluginContext {
  id: string;
  contribute<K extends SlotName>(slot: K, item: SlotInput<K>): void;
  useSlot<K extends SlotName>(slot: K): SlotItem<K>[];
  slotItems<K extends SlotName>(slot: K, opts?: { plugin?: string }): SlotItem<K>[];
  /** One source's live state (rides the SSE stream; undefined until it first arrives). */
  useSource<T = unknown>(id: string): SourceState<T> | undefined;
  get: typeof api.get;
  post: typeof api.post;
  ago: typeof api.ago;
  navigate: typeof router.navigate;
  Link: typeof router.Link;
  usePath: typeof router.usePath;
  match: typeof router.match;
  useLowData(): boolean;
  /** `useState` kept in localStorage under `wh.p.<plugin id>.<key>` (JSON), shared live by every component using it. */
  usePersisted<T>(key: string, initial: T): [T, (v: T | ((cur: T) => T)) => void];
  useToast(): { show(t: ToastInput): void };
  useIsPhone(): boolean;
  components: typeof components;
  /** highlight.js helpers, loaded on demand (kept out of the main bundle). */
  highlightCode(): Promise<typeof import('../web/src/highlightCode.ts')>;
  /** react-markdown + GFM with the `markdown-override` slot merged into `components`. */
  markdown: typeof import('../web/src/components/Markdown.tsx').Markdown;
  SessionIdContext: Context<string | null>;
}

/** The default export of a plugin's `web.tsx`. */
export type RegisterWebPlugin = (ctx: WebPluginContext) => void;
