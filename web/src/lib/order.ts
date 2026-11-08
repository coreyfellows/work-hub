/** The saved order applied to the known `defaults`: saved ids first (unknown ones dropped), then any not mentioned, in default order. */
export function applyOrder(saved: string[] | undefined, defaults: string[]): string[] {
  const out: string[] = [];
  for (const id of saved ?? []) if (defaults.includes(id) && !out.includes(id)) out.push(id);
  for (const id of defaults) if (!out.includes(id)) out.push(id);
  return out;
}

/** Move `id` one step earlier (-1) or later (1); unchanged at the ends or for an unknown id. */
export function nudge(order: string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Put `id` in front of `beforeId` (null: at the end). */
export function moveBefore(order: string[], id: string, beforeId: string | null): string[] {
  if (!order.includes(id) || id === beforeId) return order;
  const rest = order.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at < 0) return order;
  rest.splice(at, 0, id);
  return rest;
}
