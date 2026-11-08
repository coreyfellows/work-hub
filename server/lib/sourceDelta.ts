/**
 * Change-only updates for the SSE stream (`/api/events`). Each connection gets a source's full state once, then
 * `SourcePatch`es: for keyed lists (`claude.sessions` by `sessionId`, `workspaces.workspaces` by `id`) only the
 * items that changed, otherwise the changed top-level keys of `data`. `applyPatch` (also used by the browser, so this
 * file imports types only) rebuilds exactly the state the server has.
 *
 * `isUrgent` says whether a change is one you'd act on (a session appearing/going, its status, a question or menu);
 * low-data connections send those at once and batch the rest.
 */
import type { SourceState } from '../registry.ts';

export type ListPatch = { upsert: unknown[]; remove: string[]; order: string[] };

export type SourcePatch = {
  id: string;
  fields: Partial<Pick<SourceState, 'title' | 'error' | 'updatedAt' | 'loading'>>;
  data?: { replace: unknown } | { lists: Record<string, ListPatch>; set: Record<string, unknown>; unset: string[] };
};

type Obj = Record<string, unknown>;

const FIELDS = ['title', 'error', 'updatedAt', 'loading'] as const;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function itemKey(v: unknown): string | null {
  if (!isObj(v)) return null;
  if (typeof v.sessionId === 'string') return v.sessionId;
  if (typeof v.id === 'string') return v.id;
  return null;
}

/** Every item is an object with a unique string key. */
function keyed(list: unknown): list is Obj[] {
  if (!Array.isArray(list)) return false;
  const keys = new Set<string>();
  for (const v of list) {
    const k = itemKey(v);
    if (k === null || keys.has(k)) return false;
    keys.add(k);
  }
  return true;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffList(prev: Obj[], next: Obj[]): ListPatch | null {
  const before = new Map(prev.map((v) => [itemKey(v)!, v]));
  const nextKeys = next.map((v) => itemKey(v)!);
  const nextSet = new Set(nextKeys);
  const upsert = next.filter((v) => !same(before.get(itemKey(v)!), v));
  const remove = [...before.keys()].filter((k) => !nextSet.has(k));
  const kept = prev.map((v) => itemKey(v)!).filter((k) => nextSet.has(k));
  // Applying upserts appends new items in order; only send the full order when that wouldn't reproduce it.
  const appended = [...kept, ...nextKeys.filter((k) => !before.has(k))];
  const order = same(appended, nextKeys) ? [] : nextKeys;
  return upsert.length || remove.length || order.length ? { upsert, remove, order } : null;
}

export function diffSource(prev: SourceState, next: SourceState): SourcePatch | null {
  const fields: SourcePatch['fields'] = {};
  for (const f of FIELDS) if (prev[f] !== next[f]) (fields as Obj)[f] = next[f];
  let data: SourcePatch['data'];
  if (!same(prev.data, next.data)) {
    if (isObj(prev.data) && isObj(next.data)) {
      const lists: Record<string, ListPatch> = {};
      const set: Obj = {};
      const unset: string[] = [];
      const a = prev.data;
      const b = next.data;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (same(a[k], b[k])) continue;
        if (k in a && k in b && keyed(a[k]) && keyed(b[k])) {
          const l = diffList(a[k], b[k]);
          if (l) lists[k] = l;
        } else if (b[k] !== undefined) set[k] = b[k];
        else unset.push(k); // gone, or undefined (which JSON would drop from `set`)
      }
      data = { lists, set, unset };
    } else data = { replace: next.data };
  }
  if (!data && !Object.keys(fields).length) return null;
  return data ? { id: next.id, fields, data } : { id: next.id, fields };
}

function applyList(prev: Obj[], p: ListPatch): Obj[] {
  const byKey = new Map(prev.map((v) => [itemKey(v)!, v]));
  for (const k of p.remove) byKey.delete(k);
  const order = prev.map((v) => itemKey(v)!).filter((k) => byKey.has(k));
  for (const v of p.upsert as Obj[]) {
    const k = itemKey(v)!;
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, v);
  }
  return (p.order.length ? p.order : order).map((k) => byKey.get(k)!);
}

export function applyPatch(prev: SourceState, patch: SourcePatch): SourceState {
  const next: SourceState = { ...prev, ...patch.fields };
  const d = patch.data;
  if (!d) return next;
  if ('replace' in d) return { ...next, data: d.replace };
  const data: Obj = { ...(prev.data as Obj) };
  for (const k of d.unset) delete data[k];
  Object.assign(data, d.set);
  for (const [k, l] of Object.entries(d.lists)) data[k] = applyList(data[k] as Obj[], l);
  return { ...next, data };
}

/**
 * Which changes are urgent, per source: a rule names a keyed list in the source's data and the fields of its items whose
 * change (or an item appearing/going) is something you'd act on. Plugins add theirs with `registerUrgent` (`ctx.urgent`).
 */
const URGENT = new Map<string, Array<{ list: string; fields: string[]; owner: string }>>();

/** Make changes to `fields` of the items in `data[listKey]` of source `sourceId` urgent (rules add up). */
export function registerUrgent(sourceId: string, listKey: string, fields: string[], owner = 'core'): void {
  const rules = URGENT.get(sourceId) ?? [];
  rules.push({ list: listKey, fields: [...fields], owner });
  URGENT.set(sourceId, rules);
}

/** Drop every rule `owner` registered. */
export function removeUrgent(owner: string): void {
  for (const [id, rules] of URGENT) {
    const kept = rules.filter((r) => r.owner !== owner);
    if (kept.length) URGENT.set(id, kept);
    else URGENT.delete(id);
  }
}

registerUrgent('claude', 'sessions', ['status', 'rawStatus', 'promptState', 'waitingFor', 'needsInput', 'questionId', 'unread']);
registerUrgent('workspaces', 'workspaces', ['status', 'sessions', 'worktrees', 'links']);
// A job starting, finishing or failing is something you'd act on (open the result), so it goes at once.
registerUrgent('jobs', 'jobs', ['status', 'link', 'error', 'detail']);

function urgentBy(rule: { list: string; fields: string[] }, prev: SourceState, next: SourceState): boolean {
  const list = (s: SourceState): Obj[] => {
    const v = isObj(s.data) ? s.data[rule.list] : undefined;
    return Array.isArray(v) ? (v as Obj[]) : [];
  };
  const before = new Map(list(prev).map((v) => [itemKey(v), v]));
  const after = list(next);
  if (before.size !== after.length) return true;
  return after.some((v) => {
    const old = before.get(itemKey(v));
    return !old || rule.fields.some((f) => !same(old[f], v[f]));
  });
}

export function isUrgent(prev: SourceState | undefined, next: SourceState): boolean {
  if (!prev) return true;
  return (URGENT.get(next.id) ?? []).some((rule) => urgentBy(rule, prev, next));
}
