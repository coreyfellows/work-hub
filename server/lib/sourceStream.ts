/**
 * One SSE connection's view of the sources: the first state of each source goes out whole (`source`), later
 * changes as `source-patch` (see sourceDelta.ts), and changes that alter nothing aren't sent.
 *
 * With `batchMs` (low-data connections, `/api/events?low=1`) a source's non-urgent changes go out at most once per
 * `batchMs`, as one patch to the latest state; an urgent one (`isUrgent`: a session appearing/going, its status, a
 * question or menu) goes out at once and takes any batched changes with it.
 */
import type { SourceState } from '../registry.ts';
import { diffSource, isUrgent } from './sourceDelta.ts';

export type Write = (event: 'source' | 'source-patch', data: string) => void;

export class SourceStream {
  private readonly write: Write;
  private readonly batchMs: number;
  private readonly lastSent = new Map<string, SourceState>();
  private readonly sentAt = new Map<string, number>();
  private readonly pending = new Map<string, SourceState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(write: Write, opts: { batchMs?: number } = {}) {
    this.write = write;
    this.batchMs = opts.batchMs ?? 0;
  }

  change(next: SourceState): void {
    const prev = this.lastSent.get(next.id);
    if (!this.batchMs || !prev || isUrgent(prev, next)) return this.send(next);
    const wait = (this.sentAt.get(next.id) ?? 0) + this.batchMs - Date.now();
    if (wait <= 0) return this.send(next);
    this.pending.set(next.id, next);
    if (!this.timers.has(next.id)) {
      this.timers.set(
        next.id,
        setTimeout(() => {
          this.timers.delete(next.id);
          const latest = this.pending.get(next.id);
          if (latest) this.send(latest);
        }, wait),
      );
    }
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }

  private send(next: SourceState): void {
    const id = next.id;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.pending.delete(id);
    const prev = this.lastSent.get(id);
    if (!prev) this.write('source', JSON.stringify(next));
    else {
      const patch = diffSource(prev, next);
      if (!patch) return;
      this.write('source-patch', JSON.stringify(patch));
    }
    this.lastSent.set(id, next);
    this.sentAt.set(id, Date.now());
  }
}
