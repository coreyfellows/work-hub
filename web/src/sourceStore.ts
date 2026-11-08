import { useSyncExternalStore } from 'react';
import type { SourceState } from './api.ts';

/**
 * A module-level copy of every source's live state, fed by `App` from `useSources()` (which stays the one SSE
 * connection), so plugin components can read a source without it being passed down: `useSource('github')`.
 */

let all: Record<string, SourceState> = {};
const listeners = new Set<() => void>();

export function setSources(next: Record<string, SourceState>): void {
  if (next === all) return;
  all = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Non-hook read (event handlers, slot callbacks). */
export function getSources(): Record<string, SourceState> {
  return all;
}

/** One source; re-renders only when that source's state object changes. */
export function useSource<T = unknown>(id: string): SourceState<T> | undefined {
  return useSyncExternalStore(
    subscribe,
    () => all[id] as SourceState<T> | undefined,
    () => undefined,
  );
}

/** Every source (re-renders on any change). */
export function useAllSources(): Record<string, SourceState> {
  return useSyncExternalStore(subscribe, getSources, getSources);
}
