/**
 * The keep-awake decision, apart from any process or timer so it can be tested: hold a sleep assertion while some
 * session is working and for `graceMs` after the last one stopped (so the gap between two turns doesn't let the Mac nap),
 * release it after that. A session waiting on you (`needs-input`) or idle is not work: nobody is running anything.
 */
export interface Hold {
  stop(): void;
}

export interface KeepAwakeOpts {
  graceMs: number;
  now(): number;
  /** Starts the assertion (e.g. `caffeinate`); `onLost` is called if it ends by itself, so the next update starts it again. */
  acquire(onLost: () => void): Hold | null;
  log?(msg: string): void;
}

export function anyWorking(sessions: ReadonlyArray<{ status: string }>): boolean {
  return sessions.some((s) => s.status === 'working');
}

export function createKeepAwake(opts: KeepAwakeOpts) {
  let hold: Hold | null = null;
  let lastBusy = -Infinity;

  function release(why: string): void {
    if (!hold) return;
    hold.stop();
    hold = null;
    opts.log?.(`released: ${why}`);
  }

  return {
    /** Call with the current sessions; returns whether the Mac is being held awake afterwards. */
    update(sessions: ReadonlyArray<{ status: string }>): boolean {
      const now = opts.now();
      if (anyWorking(sessions)) lastBusy = now;
      const wanted = now - lastBusy <= opts.graceMs;
      if (wanted && !hold) {
        hold = opts.acquire(() => {
          hold = null;
        });
        if (hold) opts.log?.('holding: a session is working');
      } else if (!wanted) {
        release('no session working');
      }
      return hold !== null;
    },
    holding: () => hold !== null,
    stop: () => release('shutting down'),
  };
}
