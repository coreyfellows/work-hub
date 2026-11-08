import { useEffect, useState } from 'react';
import { ago } from '../api.ts';

/**
 * Low data: views that stopped refreshing by themselves say how old they are; tapping refreshes them.
 * Renders nothing until the first load (`at` null).
 */
export function AsOf({ at, onRefresh, busy = false }: { at: number | null; onRefresh: () => void; busy?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (at === null) return null;
  const fresh = Date.now() - at < 10_000;
  return (
    <button className="as-of" onClick={onRefresh} disabled={busy} title={`Loaded ${new Date(at).toLocaleTimeString()}; tap to refresh`}>
      {busy ? 'refreshing…' : fresh ? 'as of just now' : `as of ${ago(at)} ago`} ↻
    </button>
  );
}
