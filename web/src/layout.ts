import { useSyncExternalStore } from 'react';
import { get, post } from './api.ts';
import { applyOrder } from './lib/order.ts';
import { mergeIds } from './lib/slotOrder.ts';
import { slotItems, useSlot } from './slots.ts';

/**
 * The workspace's right-hand panel arrangement: the order of its tabs and of the Details sections. One layout for
 * every workspace, kept on the server (so every device shows it); loaded once on first use, no polling.
 *
 * The ids are the core's plus the slots' (`workspace-panel`, `workspace-section`, `session-view`), sorted by order with
 * the core first on a tie; `applyOrder` puts saved ids first and any never saved at their default spot.
 */
/** The core's tabs and Details sections with their sort keys (slot items default to 100). */
export const CORE_TABS: Array<[id: string, order: number]> = [['details', 0]];
export const CORE_SECTIONS: Array<[id: string, order: number]> = [
  ['links', 10],
  ['worktrees', 30],
  ['notes', 40],
  ['activity', 50],
];
export const tabIds = (): string[] => mergeIds(CORE_TABS, slotItems('workspace-panel'));
export const sectionIds = (): string[] => mergeIds(CORE_SECTIONS, slotItems('workspace-section'));
export const viewIds = (): string[] => mergeIds([], slotItems('session-view'));

interface Saved {
  tabs: string[];
  sections: string[];
  views: string[];
  items: Record<string, string[]>;
}

const norm = (r: Partial<Saved>): Saved => ({ tabs: r.tabs ?? [], sections: r.sections ?? [], views: r.views ?? [], items: r.items ?? {} });

let saved: Saved = norm({});
let started = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function load() {
  if (started) return;
  started = true;
  get<Saved>('/api/layout').then(
    (r) => {
      saved = norm(r);
      emit();
    },
    () => {
      started = false; // try again next time something asks
    },
  );
}

const subscribe = (f: () => void) => {
  subs.add(f);
  load();
  return () => subs.delete(f);
};
const snapshot = () => saved;

/** Save a new order at once (optimistic) and tell the server; `onError` hears about a failed save. */
async function save(next: Saved, onError?: (message: string) => void) {
  const prev = saved;
  saved = next;
  emit();
  try {
    saved = norm(await post<Saved>('/api/layout', next));
  } catch (e) {
    saved = prev;
    onError?.((e as Error).message);
  }
  emit();
}

// Edit mode ("unlocked") is global to the app: one lock in the header, never remembered (every load starts locked).
let editing = false;
const editSubs = new Set<() => void>();
const subscribeEditing = (f: () => void) => {
  editSubs.add(f);
  return () => editSubs.delete(f);
};
export function setLayoutEditing(on: boolean) {
  editing = on;
  editSubs.forEach((f) => f());
}
export function useLayoutEditing(): boolean {
  return useSyncExternalStore(subscribeEditing, () => editing);
}

export function useLayout(onError?: (message: string) => void) {
  const s = useSyncExternalStore(subscribe, snapshot);
  // Subscribed so a late contribution re-renders; the ids come from the same registry.
  useSlot('workspace-panel');
  useSlot('workspace-section');
  useSlot('session-view');
  const tabs = applyOrder(s.tabs, tabIds());
  const sections = applyOrder(s.sections, sectionIds());
  const views = applyOrder(s.views, viewIds());
  return {
    tabs,
    sections,
    views,
    setTabs: (order: string[]) => void save({ ...s, tabs: order, sections, views }, onError),
    setSections: (order: string[]) => void save({ ...s, tabs, sections: order, views }, onError),
    setViews: (order: string[]) => void save({ ...s, tabs, sections, views: order }, onError),
    /** A workspace's saved order of its session and terminal tabs (ids not saved yet go last, in their natural order). */
    itemsFor: (workspaceId: string, current: string[]) => applyOrder(s.items[workspaceId], current),
    setItems: (workspaceId: string, order: string[]) => void save({ ...s, tabs, sections, views, items: { ...s.items, [workspaceId]: order } }, onError),
  };
}
