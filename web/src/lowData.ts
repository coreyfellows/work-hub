import { useSyncExternalStore } from 'react';

/**
 * Low-data mode, per device (this browser), off unless turned on in Settings. While on: the SSE stream batches
 * non-urgent changes (`/api/events?low=1`), session pages open on the log without the live terminal, and views that
 * would poll (Diff, PR page, stats, terminals) refresh only on tap and say how old they are.
 */
export const LOW_DATA_KEY = 'wh.lowData';
const EVENT = 'wh-lowdata';

function read(): boolean {
  try {
    return localStorage.getItem(LOW_DATA_KEY) === 'on';
  } catch {
    return false;
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

export function setLowData(on: boolean): void {
  try {
    if (on) localStorage.setItem(LOW_DATA_KEY, 'on');
    else localStorage.removeItem(LOW_DATA_KEY);
  } catch {
    /* private mode: nothing to remember */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The current setting, for one-off reads outside React's render (e.g. an initial state). */
export const lowDataOn = read;

export function useLowData(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
