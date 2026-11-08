/**
 * Brute-force brake for sign-in (token and passkey): too many recent failures and further attempts are refused. Single-user
 * app, so it is global rather than per address. The failures live in a store so a restart can't be used to reset it.
 */
export interface FailureStore {
  /** Failure times (ms) at or after `since`. */
  since(since: number): number[];
  add(at: number): void;
  /** Forget failures older than `before`. */
  prune(before: number): void;
}

export class FailureBrake {
  private readonly store: FailureStore;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(store: FailureStore, limit = 10, windowMs = 10 * 60_000) {
    this.store = store;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  tooMany(now = Date.now()): boolean {
    this.store.prune(now - this.windowMs);
    return this.store.since(now - this.windowMs).length >= this.limit;
  }

  note(now = Date.now()): void {
    this.store.add(now);
  }
}
