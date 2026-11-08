import type { HistoryEntry, LogCardItem } from '../../plugin-api/web.ts';

/** The parts of a `log-card` item the planner reads. */
export type PlanItem = Pick<LogCardItem, 'match' | 'run'>;

/** One thing the Chat view draws, in order. */
export type ChatStep<I extends PlanItem> =
  /** An item's card: one entry (`run` false: `render`) or a run of them (`run.render`). `index`: the first entry's position. */
  | { kind: 'card'; item: I; entries: HistoryEntry[]; run: boolean; index: number }
  /** Tool calls nobody draws, folded into "⋯ N steps" (`first`: the first one's transcript index, for a stable key). */
  | { kind: 'steps'; count: number; first: number }
  /** An entry with the default rendering (your message, Claude's text, a question). */
  | { kind: 'entry'; entry: HistoryEntry; index: number };

/**
 * Lays out the Chat view (see `LogCardItem` in plugin-api/web.ts): every matching item contributes, in order; a
 * contribution with a non-null `run.key` joins the open run of the same item and key, else ends it and opens its own;
 * folded tool steps never break a run and are drawn after it; anything else drawn ends the run first. `skipI`: the
 * transcript index of a question that's answered in the form below the log (not drawn here, but it still ends a run).
 */
export function planChat<I extends PlanItem>(entries: HistoryEntry[], items: I[], skipI?: number): ChatStep<I>[] {
  const out: ChatStep<I>[] = [];
  let hidden = 0;
  let first = -1;
  let open: { item: I; key: string; entries: HistoryEntry[]; index: number } | null = null;
  const flush = () => {
    if (!hidden) return;
    out.push({ kind: 'steps', count: hidden, first });
    hidden = 0;
  };
  const endRun = () => {
    if (open) out.push({ kind: 'card', item: open.item, entries: open.entries, run: true, index: open.index });
    open = null;
    flush(); // steps taken during the run come after its card
  };
  entries.forEach((e, index) => {
    const matched = items.filter((it) => it.match(e));
    if (matched.length) {
      for (const item of matched) {
        const key = item.run ? item.run.key(e) : null;
        if (key === null) {
          endRun();
          out.push({ kind: 'card', item, entries: [e], run: false, index });
        } else if (open && open.item === item && open.key === key) {
          open.entries.push(e);
        } else {
          endRun();
          open = { item, key, entries: [e], index };
        }
      }
      return;
    }
    if (e.kind === 'tool' && !e.questions) {
      if (!hidden) first = e.i;
      hidden++;
      return;
    }
    endRun();
    if (e.kind === 'tool' && e.i === skipI) return;
    out.push({ kind: 'entry', entry: e, index });
  });
  endRun();
  return out;
}
