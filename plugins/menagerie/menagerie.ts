import { useSyncExternalStore, type CSSProperties } from 'react';
import { get, type ResidentHost } from '../../plugin-api/web.ts';
import type { Aside, FunHost } from './types.ts';

export type { Aside, FunHost, ResidentHost };
export { askLine, lastHost, splitAside } from './aside.ts';

// The cast, fetched once per page load and again after a change (reloadHosts). Empty until it arrives, and when the
// user has no cast yet: then nothing is themed.
let hosts: FunHost[] = [];
let loaded = false;
let requested = false;
const hostListeners = new Set<() => void>();
const EMPTY: FunHost[] = [];

/** Fetches the cast again (after a generate, reroll, undo, remove or import) and re-renders every user. */
export function reloadHosts(): Promise<void> {
  requested = true;
  return get<FunHost[] | null>('/api/menagerie/hosts').then(
    (list) => {
      hosts = Array.isArray(list) ? list : [];
      loaded = true;
      for (const l of hostListeners) l();
    },
    () => {},
  );
}

function subscribeHosts(cb: () => void): () => void {
  hostListeners.add(cb);
  if (!requested) void reloadHosts();
  return () => hostListeners.delete(cb);
}

/** The cast, as the user's cast file has it ([] until loaded or when there's none). */
export function useFunHosts(): FunHost[] {
  return useSyncExternalStore(subscribeHosts, () => hosts, () => EMPTY);
}

/** Whether the cast has been fetched at least once (so an empty list means "no cast", not "not yet"). */
export function useHostsLoaded(): boolean {
  return useSyncExternalStore(subscribeHosts, () => loaded, () => false);
}

/** CSS variables carrying a host's palette. */
export function hostVars(h: FunHost): CSSProperties {
  const trim = h.trimColors ?? h.borderColors;
  return {
    '--fun-color': h.color,
    '--fun-text': h.text,
    '--fun-grad': `linear-gradient(90deg, ${[...h.letters, h.letters[0]].join(', ')})`,
    '--fun-border': `linear-gradient(90deg, ${[...h.borderColors, h.borderColors[0]].join(', ')})`,
    '--fun-trim': `linear-gradient(90deg, ${[...trim, trim[0]].join(', ')})`,
  } as CSSProperties;
}

