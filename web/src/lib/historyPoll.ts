/** Where a history poll starts: a little before the last entry (late tool results fill in), or earlier if a question is still open. */
export const POLL_OVERLAP = 10;

/**
 * Entry index to ask the server for with `?after=`. Normally `total - POLL_OVERLAP`, but never later than the oldest
 * question the page still shows as unanswered: its answer lands on that entry without adding one, so a poll that only
 * looked at the newest few entries would never learn that it was answered and the form would stay up until a reload.
 */
export function pollFrom(total: number, history: ReadonlyArray<{ i: number; questions?: unknown; result?: unknown }>): number {
  let from = Math.max(0, total - POLL_OVERLAP);
  for (const e of history) if (e.questions && e.result === undefined && e.i < from) from = e.i;
  return from;
}
