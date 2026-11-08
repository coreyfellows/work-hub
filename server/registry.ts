import { EventEmitter } from 'node:events';
import { hubEvents } from './lib/events.ts';
import { run } from './lib/exec.ts';
import { idleSeconds as idleSeconds_ } from './lib/platform.ts';

/**
 * A Source is one integration: something that periodically produces data for a panel.
 * To add an integration, write a module in server/sources/ that exports a Source and
 * register it in server/index.ts.
 */
export interface Source<T = unknown> {
  id: string;
  title: string;
  intervalMs: number;
  /** Cheap and token-free (local DB / CLI): loaded at startup and as soon as a viewer connects, before the idle check. */
  local?: boolean;
  fetch(): Promise<T>;
}

export interface SourceState<T = unknown> {
  id: string;
  title: string;
  data: T | null;
  error: string | null;
  updatedAt: number | null;
  loading: boolean;
}

export interface HubStatus {
  /** Polling only happens while this is true. */
  active: boolean;
  viewers: number;
  idleSeconds: number | null;
  reason: string;
}

/**
 * Polls sources only while someone is looking (a visible browser tab holds an SSE connection)
 * AND the machine is in use (recent keyboard/mouse input). Otherwise nothing runs: no CLI calls and,
 * importantly, no token-spending `claude -p` fetches. Manual refreshes always run.
 */
export class Registry extends EventEmitter {
  private sources = new Map<string, Source>();
  private states = new Map<string, SourceState>();
  private lastRun = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private viewers = 0;
  private status: HubStatus = { active: false, viewers: 0, idleSeconds: null, reason: 'starting' };
  private ticker: NodeJS.Timeout | null = null;
  private started = false;

  private readonly opts: { idleThresholdMs: number; tickMs?: number };

  constructor(opts: { idleThresholdMs: number; tickMs?: number }) {
    super();
    this.opts = opts;
  }

  add(source: Source): this {
    this.sources.set(source.id, source);
    this.states.set(source.id, { id: source.id, title: source.title, data: null, error: null, updatedAt: null, loading: false });
    // Added after start() (a plugin's source): a local one loads now, like the ones start() loaded.
    if (this.started && source.local) void this.runOnce(source);
    return this;
  }

  start(): void {
    this.started = true;
    this.ticker = setInterval(() => void this.tick(), this.opts.tickMs ?? 2_000);
    // Local sources don't wait for a viewer: the first page load finds them already cached.
    this.runStale(true);
    void this.tick();
  }

  /** Stop polling (tests). */
  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.started = false;
  }

  all(): SourceState[] {
    return [...this.states.values()];
  }

  get(id: string): SourceState | undefined {
    return this.states.get(id);
  }

  hubStatus(): HubStatus {
    return this.status;
  }

  /** Called by the SSE route as viewers connect and disconnect. */
  viewerJoined(): void {
    this.viewers++;
    // A page just opened: refresh stale local sources now rather than after the idle probe.
    this.runStale(true);
    void this.tick();
  }

  viewerLeft(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    void this.tick();
  }

  /** Refresh now regardless of activity (an explicit user action). Deduped if already running. */
  refresh(id: string): Promise<void> {
    const s = this.sources.get(id);
    if (!s) return Promise.reject(new Error(`unknown source ${id}`));
    return this.runOnce(s);
  }

  private async tick(): Promise<void> {
    let idleSeconds: number | null = null;
    let active = false;
    let reason: string;
    if (this.viewers === 0) {
      reason = 'no browser open';
    } else {
      idleSeconds = await idleSeconds_(run);
      // If idle time can't be read, err on the side of working while someone is looking.
      active = idleSeconds === null || idleSeconds * 1000 < this.opts.idleThresholdMs;
      reason = active ? 'active' : 'computer idle';
    }
    this.setStatus({ active, viewers: this.viewers, idleSeconds, reason });
    if (!active) {
      // Idle machine but someone is watching (e.g. from a phone): keep the free local sources fresh, or
      // session status freezes (a "working" indicator that never clears).
      if (this.viewers > 0) this.runStale(true);
      return;
    }

    this.runStale(false);
  }

  /** Start every source whose interval has elapsed; `localOnly` limits it to the cheap local ones. */
  private runStale(localOnly: boolean): void {
    const now = Date.now();
    for (const s of this.sources.values()) {
      if (localOnly && !s.local) continue;
      if (now - (this.lastRun.get(s.id) ?? 0) >= s.intervalMs) void this.runOnce(s);
    }
  }

  private setStatus(next: HubStatus): void {
    const changed = next.active !== this.status.active || next.viewers !== this.status.viewers || next.reason !== this.status.reason;
    this.status = next;
    if (changed) this.emit('status', next);
  }

  private runOnce(s: Source): Promise<void> {
    const existing = this.inflight.get(s.id);
    if (existing) return existing;
    this.lastRun.set(s.id, Date.now());
    const p = (async () => {
      this.patch(s.id, { loading: true });
      try {
        const data = await s.fetch();
        this.patch(s.id, { data, error: null, updatedAt: Date.now(), loading: false });
      } catch (err) {
        // Keep the last good data; just surface the error alongside it.
        this.patch(s.id, { error: (err as Error).message, loading: false });
      } finally {
        this.inflight.delete(s.id);
      }
    })();
    this.inflight.set(s.id, p);
    return p;
  }

  private patch(id: string, partial: Partial<SourceState>): void {
    const prev = this.states.get(id)!;
    const next = { ...prev, ...partial };
    this.states.set(id, next);
    // Fast-polling sources often return identical data; only push real changes.
    const same =
      JSON.stringify(prev.data) === JSON.stringify(next.data) &&
      prev.error === next.error &&
      prev.loading === next.loading;
    if (!same) {
      this.emit('change', next);
      hubEvents.emit('source-changed', { id });
    }
  }
}
