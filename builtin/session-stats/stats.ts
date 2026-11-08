import { costOf, type Usage } from './pricing.ts';
import type { SessionStats } from './types.ts';

type FileChange = { path: string; at?: string | null; content?: string };

/** Token totals, API-equivalent cost and the files a session changed, from its per-response usage and its recorded edits (oldest first). */
export function computeStats(usage: Array<{ model: string; usage: Usage }>, edits: FileChange[]): SessionStats {
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let cost = 0;
  let priced = 0;
  const unpriced = new Set<string>();
  for (const { model, usage: u } of usage) {
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    const k = costOf(model, u);
    if (k === null) unpriced.add(model || 'unknown');
    else {
      cost += k;
      priced++;
    }
  }
  const byPath = new Map<string, { path: string; edits: number; lastAt: string | null; wrote: boolean }>();
  for (const e of edits) {
    const f = byPath.get(e.path) ?? { path: e.path, edits: 0, lastAt: null, wrote: false };
    f.edits++;
    f.lastAt = e.at ?? f.lastAt;
    f.wrote ||= e.content !== undefined;
    byPath.set(e.path, f);
  }
  const files = [...byPath.values()].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  return { tokens, costUsd: priced ? cost : null, unpricedModels: [...unpriced], responses: usage.length, files };
}
