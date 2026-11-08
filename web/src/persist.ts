import { useCallback, useRef, useState } from 'react';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage full or blocked: the value just won't survive a reload */
  }
};

/** Like useState for a string, kept in localStorage under `key` (empty/null removes it) so it survives a reload. Local only: no network. */
export function usePersistedString(key: string, initial = ''): [string, (v: string | ((cur: string) => string)) => void] {
  const [value, setValue] = useState(() => read(key) ?? initial);
  const cur = useRef(value);
  cur.current = value;
  const set = useCallback(
    (v: string | ((cur: string) => string)) => {
      const next = typeof v === 'function' ? v(cur.current) : v;
      cur.current = next;
      setValue(next);
      write(key, next);
    },
    [key],
  );
  return [value, set];
}

/** Nullable variant: `null` is "nothing picked". */
export function usePersistedPick(key: string): [string | null, (v: string | null) => void] {
  const [raw, setRaw] = usePersistedString(key);
  return [raw || null, (v) => setRaw(v ?? '')];
}
