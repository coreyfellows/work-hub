import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Change notifications for transcript files, shared by every viewer of one file: one `fs.watch` per watched path
 * while anyone listens, closed with the last listener. Events are coalesced (`debounceMs`), since Claude appends a
 * message as several writes. `fs.watch` can miss events (network drives, an editor's atomic replace) or stop after
 * a rename, so a cheap `stat` every `checkMs` also fires on a size or mtime change and re-arms the watcher.
 * Local and free: nothing here spends tokens, and nothing runs once the last viewer has gone.
 */
export interface TranscriptWatcher {
  /** Calls `fn` after each change to the file at `path`; returns the unsubscribe. */
  subscribe(path: string, fn: () => void): () => void;
  /** Paths watched right now (tests). */
  watched(): string[];
}

type Entry = {
  listeners: Set<() => void>;
  watcher: FSWatcher | null;
  debounce: ReturnType<typeof setTimeout> | null;
  check: ReturnType<typeof setInterval>;
  sig: string;
};

export function createTranscriptWatcher(opts: { debounceMs?: number; checkMs?: number } = {}): TranscriptWatcher {
  const debounceMs = opts.debounceMs ?? 80;
  const checkMs = opts.checkMs ?? 5000;
  const entries = new Map<string, Entry>();

  const signature = async (path: string) => {
    const st = await stat(path).catch(() => null);
    return st ? `${st.size}:${st.mtimeMs}` : '';
  };

  const fire = (path: string) => {
    const e = entries.get(path);
    if (!e || e.debounce) return;
    e.debounce = setTimeout(() => {
      e.debounce = null;
      void signature(path).then((sig) => {
        if (entries.get(path) !== e) return;
        e.sig = sig;
        for (const fn of [...e.listeners]) {
          try {
            fn();
          } catch {
            /* one listener's failure doesn't stop the others */
          }
        }
      });
    }, debounceMs);
  };

  const arm = (path: string, e: Entry) => {
    e.watcher?.close();
    e.watcher = null;
    try {
      const w = watch(path, { persistent: false }, (type) => {
        // A rename (replaced or moved file) ends this watch on most platforms: watch the path again.
        if (type === 'rename') arm(path, e);
        fire(path);
      });
      w.on('error', () => {
        w.close();
        if (e.watcher === w) e.watcher = null;
      });
      e.watcher = w;
    } catch {
      /* missing or unwatchable: the periodic check still notices changes and retries */
    }
  };

  return {
    subscribe(path, fn) {
      let e = entries.get(path);
      if (!e) {
        const created: Entry = {
          listeners: new Set(),
          watcher: null,
          debounce: null,
          sig: '',
          check: setInterval(() => {
            void signature(path).then((sig) => {
              if (entries.get(path) !== created) return;
              if (!created.watcher) arm(path, created);
              if (sig !== created.sig) fire(path);
            });
          }, checkMs),
        };
        created.check.unref?.();
        e = created;
        entries.set(path, e);
        void signature(path).then((sig) => {
          if (entries.get(path) === created && !created.debounce) created.sig = sig;
        });
        arm(path, e);
      }
      e.listeners.add(fn);
      const entry = e;
      return () => {
        entry.listeners.delete(fn);
        if (entry.listeners.size || entries.get(path) !== entry) return;
        entries.delete(path);
        entry.watcher?.close();
        clearInterval(entry.check);
        if (entry.debounce) clearTimeout(entry.debounce);
      };
    },
    watched: () => [...entries.keys()],
  };
}
