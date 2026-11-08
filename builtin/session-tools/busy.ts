import { useSyncExternalStore } from 'react';

/**
 * What's running for a session from its ⋯ menu ('handoff' | 'close'), shared by the menu items and the hand-off dialog,
 * which are separate slot items. Also the hand-off box's draft, so Cancel and reopening keep your text, as before.
 */
const busy = new Map<string, string>();
const listeners = new Set<() => void>();

export function setBusy(sessionId: string, what: string | null): void {
  if (what) busy.set(sessionId, what);
  else busy.delete(sessionId);
  for (const l of listeners) l();
}

export function useBusy(sessionId: string): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => busy.get(sessionId) ?? null,
  );
}

export const handoffDrafts = new Map<string, { note: string; model: string }>();
