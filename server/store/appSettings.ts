/**
 * Values set in Settings (`app_settings`: key → JSON). Read on every use through a small cache the writes keep fresh, so a
 * change applies at once to whatever reads it per use, with no restart.
 */
import { getDb } from './db.ts';

let cache: Map<string, unknown> | null = null;

function load(): Map<string, unknown> {
  if (cache) return cache;
  const m = new Map<string, unknown>();
  for (const r of getDb().prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>) {
    try {
      m.set(r.key, JSON.parse(r.value));
    } catch {
      /* a value that isn't JSON is ignored */
    }
  }
  return (cache = m);
}

/** The stored value, or undefined if Settings never set it. */
export function appSetting(key: string): unknown {
  return load().get(key);
}

/** Store `value` (any JSON), or remove the key with `null`/`undefined` so the default applies again. */
export function setAppSetting(key: string, value: unknown): void {
  const db = getDb();
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    load().delete(key);
    return;
  }
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  load().set(key, value);
}

/** Forget the cache (tests that swap databases). */
export function resetAppSettingsCache(): void {
  cache = null;
}
