import type { Session } from './api.ts';

/** The indicators on a workspace's card: how many of its shown sessions need you, are working, or have unread replies. */
export interface CardCounts {
  waiting: number;
  working: number;
  unread: number;
  /** The latest activity of those sessions (ms), or 0 if there's none. */
  lastActiveAt: number;
}

/**
 * Counts over a workspace's shown sessions (already without the hidden ones). Working means really working: a session
 * only waiting on its background tasks isn't counted. Unread counts only sessions that aren't working or waiting on you,
 * as the unread dot does.
 */
export function cardCounts(sessions: Session[]): CardCounts {
  let waiting = 0;
  let working = 0;
  let unread = 0;
  let lastActiveAt = 0;
  for (const s of sessions) {
    if (s.needsInput) waiting++;
    else if (s.status === 'working' && !s.waitingOnTasks) working++;
    else if (s.unread && s.status !== 'working') unread++;
    lastActiveAt = Math.max(lastActiveAt, s.lastActiveAt ?? 0);
  }
  return { waiting, working, unread, lastActiveAt };
}
