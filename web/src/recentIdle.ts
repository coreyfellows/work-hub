import { useSyncExternalStore } from 'react';

/** How long an idle workspace counts as "Warm" on the front page. Per device, like other wh.* prefs. */
export const RECENT_IDLE_CHOICES: Array<[ms: number, label: string]> = [
  [30 * 60_000, '30m'],
  [3600_000, '1h'],
  [2 * 3600_000, '2h'],
  [8 * 3600_000, '8h'],
  [24 * 3600_000, '24h'],
];
const DEFAULT_MS = 2 * 3600_000;
const KEY = 'wh.recentIdleMs';
const EVENT = 'wh-recent-idle';

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return RECENT_IDLE_CHOICES.some(([ms]) => ms === n) ? n : DEFAULT_MS;
  } catch {
    return DEFAULT_MS;
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('storage', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function setRecentIdleMs(ms: number): void {
  try {
    if (ms === DEFAULT_MS) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(ms));
  } catch {
    /* private mode: nothing to remember */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useRecentIdleMs(): number {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_MS);
}
