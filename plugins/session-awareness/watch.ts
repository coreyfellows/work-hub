import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * Call `onChange` (debounced) whenever the database file or its WAL changes. `wh` writes the database from its own
 * process, so the server's in-process events never see those writes; this is how the digest follows them with no
 * polling. Watches the folder, not the files: SQLite creates and removes the WAL file as it checkpoints.
 */
export function watchDb(dbPath: string, onChange: () => void, debounceMs = 500): () => void {
  const names = new Set([basename(dbPath), `${basename(dbPath)}-wal`]);
  let timer: NodeJS.Timeout | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dirname(dbPath), { persistent: false }, (_event, file) => {
      if (file && !names.has(String(file))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
      timer.unref();
    });
    watcher.on('error', (err) => {
      console.error('session-awareness: database watch stopped:', (err as Error).message);
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    console.error('session-awareness: cannot watch the database folder:', (err as Error).message);
  }
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
  };
}
