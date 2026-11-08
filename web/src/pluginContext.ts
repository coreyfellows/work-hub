import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlotInput, SlotItem, SlotName, WebPluginContext } from '../../plugin-api/web.ts';
import { ago, get, post } from './api.ts';
import { Link, match, navigate, usePath } from './router.tsx';
import { useLowData } from './lowData.ts';
import { useToast } from './components/Toast.tsx';
import { useIsPhone } from './components/Reorder.tsx';
import { SessionIdContext } from './components/SessionIdContext.ts';
import { Markdown } from './components/Markdown.tsx';
import * as components from './components/kit.ts';
import { contribute, slotItems, useSlot } from './slots.ts';
import { useSource } from './sourceStore.ts';

/** Same-tab updates for `usePersisted` (other tabs get the `storage` event). */
const PERSIST_EVENT = 'wh-plugin-persist';

function readJson<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : (JSON.parse(raw) as T);
  } catch {
    return initial;
  }
}

/** `useState` backed by localStorage under `key` as JSON; every component using the same key stays in step. */
export function usePersistedJson<T>(key: string, initial: T): [T, (v: T | ((cur: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readJson(key, initial));
  const cur = useRef(value);
  cur.current = value;
  useEffect(() => {
    const sync = (e: Event) => {
      const k = e instanceof StorageEvent ? e.key : (e as CustomEvent<string>).detail;
      if (k === key) setValue(readJson(key, initial));
    };
    window.addEventListener('storage', sync);
    window.addEventListener(PERSIST_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(PERSIST_EVENT, sync);
    };
    // `initial` is only the fallback for a missing key; changing it later shouldn't resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (v: T | ((cur: T) => T)) => {
      const next = typeof v === 'function' ? (v as (cur: T) => T)(cur.current) : v;
      cur.current = next;
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage full or blocked: the value just won't survive a reload */
      }
      window.dispatchEvent(new CustomEvent(PERSIST_EVENT, { detail: key }));
    },
    [key],
  );
  return [value, set];
}

/** The context handed to plugin `id`'s `register(ctx)` (called from the generated plugins module). */
export function createWebContext(id: string): WebPluginContext {
  return {
    id,
    contribute: <K extends SlotName>(slot: K, item: SlotInput<K>) => contribute(slot, { ...item, plugin: id } as unknown as SlotItem<K>),
    useSlot,
    slotItems,
    useSource,
    get,
    post,
    ago,
    navigate,
    Link,
    usePath,
    match,
    useLowData,
    usePersisted: <T,>(key: string, initial: T) => usePersistedJson<T>(`wh.p.${id}.${key}`, initial),
    useToast,
    useIsPhone,
    components,
    highlightCode: () => import('./highlightCode.ts'),
    markdown: Markdown,
    SessionIdContext,
  };
}
