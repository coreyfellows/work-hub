import type { DatabaseSync } from 'node:sqlite';

/**
 * Per-plugin schema versions. Each plugin passes a positional list of SQL migrations; the number
 * already applied is kept in `plugin_migrations`. Version 0 means nothing has run yet, so tables
 * created by core migrations stay where they are and their plugins start with an empty list.
 * Never edit an applied entry; append.
 */
export function migratePlugin(db: DatabaseSync, pluginId: string, migrations: string[]): number {
  db.prepare('INSERT OR IGNORE INTO plugin_migrations (plugin, version) VALUES (?, 0)').run(pluginId);
  const row = db.prepare('SELECT version FROM plugin_migrations WHERE plugin = ?').get(pluginId) as { version: number };
  let version = row.version;
  for (let v = version; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.prepare('UPDATE plugin_migrations SET version = ? WHERE plugin = ?').run(v + 1, pluginId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`plugin ${pluginId}: migration step ${v + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    version = v + 1;
  }
  return version;
}
