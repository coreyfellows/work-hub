/** Human labels for normalised session statuses (see server/sources/claude.ts). */
export const STATUS_LABEL: Record<string, string> = {
  'needs-input': 'waiting on you',
  working: 'working',
  /** Working, but its turn is over: only its background tasks run (`Session.waitingOnTasks`). */
  waiting: 'waiting',
  idle: 'idle',
  warm: 'warm',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  gone: 'ended',
};

export const FINISHED = ['done', 'failed', 'stopped'];

/** Finished sessions left out of workspace tabs and cards. Failed ones stay, so you see the failure. */
export const HIDDEN = ['done', 'stopped'];

/** An idle session whose latest activity is within the "warm" window (Settings → Workspaces) is "warm", not "idle". */
export function displayStatus(status: string, lastActiveAt: number | null | undefined, warmMs: number, now = Date.now()): string {
  return status === 'idle' && lastActiveAt != null && now - lastActiveAt < warmMs ? 'warm' : status;
}

/**
 * The status a session shows: waiting on you, "waiting" (working, but only its background tasks run: its turn is over,
 * so what it said is there to read), else `displayStatus` (warm or idle for idle ones).
 */
export function sessionShownStatus(
  s: { status: string; needsInput?: boolean; waitingOnTasks?: boolean; lastActiveAt?: number | null },
  warmMs: number,
  now = Date.now(),
): string {
  if (s.needsInput) return 'needs-input';
  if (s.status === 'working' && s.waitingOnTasks) return 'waiting';
  return displayStatus(s.status, s.lastActiveAt, warmMs, now);
}

/** Show the unread dot only on sessions whose turn is over (idle, warm, waiting on tasks): working and waiting-on-you are already loud. */
export function showUnread(shownStatus: string, unread: boolean | undefined): boolean {
  return !!unread && (shownStatus === 'idle' || shownStatus === 'warm' || shownStatus === 'waiting');
}

/** What a badge reads of a session to tell "waiting on task" (see `waitingOnTasks` in server/lib/sessionStatus.ts). */
type TaskWait = { status: string; waitingOnTasks?: boolean; tasks?: Array<{ label: string; startedAt?: number }> };

/** The short description of what a job waiting on its background tasks is waiting for (several joined with "; "). */
export function waitingOnText(s: TaskWait | undefined): string {
  if (!s || s.status !== 'working' || !s.waitingOnTasks) return '';
  return (s.tasks ?? []).map((t) => t.label).filter(Boolean).join('; ');
}

/** Hover text for a status badge: background work keeps a job "working" after its own turn has ended. */
export function statusTitle(s: TaskWait | undefined): string | undefined {
  if (!s || s.status !== 'working' || !s.waitingOnTasks) return undefined;
  const what = waitingOnText(s);
  const n = s.tasks?.length ?? 0;
  return `Claude's turn has ended; it carries on when its ${n > 1 ? `${n} background tasks finish` : 'background task finishes'}${what ? `: ${what}` : ''}`;
}

/** Badge text: a job kept working only by background tasks says "waiting on task" (or "tasks"). */
export function statusLabel(shownStatus: string, s?: TaskWait): string {
  if (statusTitle(s)) {
    // Badges are a fixed 104px, so no count here (the hover text lists them).
    return (s!.tasks?.length ?? 0) > 1 ? 'waiting on tasks' : 'waiting on task';
  }
  return shownStatus === 'gone' ? 'ended' : (STATUS_LABEL[shownStatus] ?? shownStatus);
}

/** What trashing a session does, for its confirm popover. */
export function trashHint(s: { kind: string; shortId: string }): string {
  return s.kind === 'background'
    ? `Stops the job; \`claude attach ${s.shortId}\` reopens it.`
    : 'Ends its Claude process; `claude --resume` continues it.';
}

/** Palette order for sessions: waiting on you, then warm or waiting (on tasks) and unread, then those, then the rest (stable within a group). */
export function statusRank(shownStatus: string, unread: boolean | undefined): number {
  if (shownStatus === 'needs-input') return 0;
  if (shownStatus === 'warm' || shownStatus === 'waiting') return unread ? 1 : 2;
  return 3;
}

/** A workspace's badge: its most urgent live session (waiting on you, working, warm, idle), unread if any idle or warm one is. */
export function workspaceBadge(
  sessions: Array<{ status: string; needsInput?: boolean; waitingOnTasks?: boolean; unread?: boolean; lastActiveAt?: number | null }>,
  warmMs: number,
  now = Date.now(),
): { status: string; unread: boolean } | null {
  const live = sessions.filter((s) => !FINISHED.includes(s.status));
  if (!live.length) return null;
  const shown = live.map((s) => ({ s, st: sessionShownStatus(s, warmMs, now) }));
  const unread = shown.some(({ s, st }) => showUnread(st, s.unread));
  for (const want of ['needs-input', 'working', 'waiting', 'warm'])
    if (shown.some(({ st }) => st === want)) return { status: want, unread };
  return { status: shown[0]!.st, unread };
}

/**
 * Does the transcript end with Claude still to answer? Your message, or a tool call with no result yet, within the last
 * two minutes (it covers the gap before the sessions poll notices the job is busy). Not after an interrupt: Esc leaves
 * a "[Request interrupted by user]" entry, and the call it cut short never gets a result.
 */
export function awaitingClaude(entries: Array<{ kind: string; at: string | null; text?: string; shell?: unknown; localOutput?: string; result?: string; questions?: unknown }>, now = Date.now()): boolean {
  const last = entries[entries.length - 1];
  if (!last?.at || now - Date.parse(last.at) >= 120_000) return false;
  // Not for a `!` command or a slash command Claude Code ran itself (it has its output): neither gets a reply.
  if (last.kind === 'user') return !last.shell && last.localOutput === undefined && !/^\[Request interrupted by user/.test(last.text ?? '');
  return last.kind === 'tool' && last.result === undefined && !last.questions;
}

/** Order of a workspace's sessions in the palette: waiting on you, then unread, then warm or waiting (on tasks), then the rest. */
export function sessionRank(shownStatus: string, unread: boolean | undefined): number {
  if (shownStatus === 'needs-input') return 0;
  if (showUnread(shownStatus, unread)) return 1;
  return shownStatus === 'warm' || shownStatus === 'waiting' ? 2 : 3;
}
