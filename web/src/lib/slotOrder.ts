/**
 * The core's own entries (each with a fixed `order`) merged with a slot's items: sorted by `order` (slot items default
 * to 100), the core first on a tie, otherwise each list keeps its own order. Pure, so it's tested (slotOrder.test.ts).
 */
export function mergeByOrder<C extends { order: number }, S extends { order?: number }>(
  core: C[],
  slot: S[],
): Array<{ core: C; slot?: undefined } | { slot: S; core?: undefined }> {
  const all = [
    ...core.map((c, i) => ({ key: c.order, rank: 0, i, v: { core: c } as { core: C } })),
    ...slot.map((s, i) => ({ key: s.order ?? 100, rank: 1, i, v: { slot: s } as { slot: S } })),
  ];
  all.sort((a, b) => a.key - b.key || a.rank - b.rank || a.i - b.i);
  return all.map((x) => x.v);
}

/** Ids only: the core's `[id, order]` pairs merged with slot items that carry an `id`. */
export function mergeIds(core: Array<[id: string, order: number]>, slot: Array<{ id: string; order?: number }>): string[] {
  return mergeByOrder(
    core.map(([id, order]) => ({ id, order })),
    slot,
  ).map((x) => (x.core ? x.core.id : x.slot!.id));
}
