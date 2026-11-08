import { useState, useSyncExternalStore } from 'react';
import type { SlotItem, SlotName } from '../../plugin-api/web.ts';

/**
 * The web slot registry: plugins `contribute(slot, item)` at module init (before React renders), the shell reads them
 * with `useSlot(slot)`. Items sort by `order ?? 100`, then by when they were contributed. Slot names and item types
 * are declared in plugin-api/web.ts; any other name works too (a plugin's own slot).
 */

type Entry = { item: SlotItem<SlotName>; seq: number };

const slots = new Map<string, Entry[]>();
const sorted = new Map<string, { version: number; list: SlotItem<SlotName>[] }>();
const listeners = new Set<() => void>();
let version = 0;
let seq = 0;

const EMPTY: never[] = [];

export function contribute<K extends SlotName>(slot: K, item: SlotItem<K>): void {
  const list = slots.get(slot) ?? [];
  list.push({ item: item as SlotItem<SlotName>, seq: seq++ });
  slots.set(slot, list);
  version++;
  for (const fn of listeners) fn();
}

/** A slot's items in order. The same array comes back until something is contributed (safe as a hook snapshot). */
export function slotItems<K extends SlotName>(slot: K, opts?: { plugin?: string }): SlotItem<K>[] {
  let list: SlotItem<SlotName>[];
  const hit = sorted.get(slot);
  if (hit && hit.version === version) list = hit.list;
  else {
    const entries = slots.get(slot);
    list = entries
      ? [...entries].sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100) || a.seq - b.seq).map((e) => e.item)
      : EMPTY;
    sorted.set(slot, { version, list });
  }
  if (opts?.plugin !== undefined) return list.filter((i) => i.plugin === opts.plugin) as SlotItem<K>[];
  return list as SlotItem<K>[];
}

export function subscribeSlots(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useSlot<K extends SlotName>(slot: K): SlotItem<K>[] {
  return useSyncExternalStore(
    subscribeSlots,
    () => slotItems(slot),
    () => slotItems(slot),
  );
}

/** Tests only: forget every contribution. */
export function resetSlots(): void {
  slots.clear();
  sorted.clear();
  version++;
  for (const fn of listeners) fn();
}

/**
 * A slot's items as they were when the calling component mounted (never changes for its lifetime). For slots whose
 * items are hooks (`useItem`, `useTabs`, `useData`): the hook count must stay the same between renders, and plugins
 * contribute at module init anyway, before the first render.
 */
export function useSlotOnce<K extends SlotName>(slot: K): SlotItem<K>[] {
  const [items] = useState(() => slotItems(slot));
  return items;
}
