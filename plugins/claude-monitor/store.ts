/**
 * claude-monitor's tables in hub.db (its own migrations, `ctx.db.migrate`): a small key/value table for its state
 * (the version the user last acknowledged, the last registry check, the latest analysis) and one row per plugin with
 * the Claude version it was last looked at for and how (seen, skipped, updating).
 */
import type { DatabaseSync } from 'node:sqlite';
import { nextRecord, type PluginRecord } from './suggest.ts';

/** Append only: never edit an applied migration. */
export const MIGRATIONS = [
  `CREATE TABLE claude_monitor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE claude_monitor_plugins (
     plugin_id TEXT PRIMARY KEY, version TEXT NOT NULL, action TEXT NOT NULL, workspace_id TEXT, at TEXT NOT NULL
   );`,
];

export interface MonitorStore {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  records(): Map<string, PluginRecord>;
  /** Records the action unless the plugin already has a newer version recorded; returns what's kept. */
  record(r: Omit<PluginRecord, 'at'>): PluginRecord;
}

export function monitorStore(db: () => DatabaseSync, now = () => new Date().toISOString()): MonitorStore {
  const records = (): Map<string, PluginRecord> => {
    const rows = db().prepare('SELECT plugin_id, version, action, workspace_id, at FROM claude_monitor_plugins').all() as Array<Record<string, string | null>>;
    return new Map(
      rows.map((r) => [
        r.plugin_id as string,
        { pluginId: r.plugin_id as string, version: r.version as string, action: r.action as PluginRecord['action'], workspaceId: r.workspace_id, at: r.at as string },
      ]),
    );
  };
  return {
    get<T>(key: string): T | null {
      const row = db().prepare('SELECT value FROM claude_monitor_state WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return null;
      }
    },
    set(key, value) {
      db().prepare('INSERT INTO claude_monitor_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    },
    records,
    record(r) {
      const kept = nextRecord(records().get(r.pluginId), { ...r, at: now() });
      db()
        .prepare(
          `INSERT INTO claude_monitor_plugins (plugin_id, version, action, workspace_id, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(plugin_id) DO UPDATE SET version = excluded.version, action = excluded.action, workspace_id = excluded.workspace_id, at = excluded.at`,
        )
        .run(kept.pluginId, kept.version, kept.action, kept.workspaceId, kept.at);
      return kept;
    },
  };
}
