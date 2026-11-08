// The characters named on the app's first-run page (the plugin's `seed` setting, asked by its firstRunOffer while it
// was off). At the plugin's first start with a seed, if the cast is empty, they're generated as "play" (the user can
// reroll or swap them for someone "inspired" in the editor). Only ever that first start: a marker file says it
// happened, so a restart, an emptied cast or an edited seed never spends tokens on it again.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './cast.ts';
import type { CastStore } from './castStore.ts';

export const MAX_SEED = 6;

export function seedNames(seed: string): string[] {
  const out: string[] = [];
  for (const raw of seed.split(/[,\n]/)) {
    const n = raw.trim();
    if (n && n.length <= LIMITS.named && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_SEED);
}

/** Starts the seeded generations if they're due; returns how many it started. */
export async function seedOnce(deps: {
  seed: string;
  store: CastStore;
  dir: string;
  add: (named: string, kind: 'play' | 'inspired') => unknown;
}): Promise<number> {
  const names = seedNames(deps.seed);
  if (!names.length) return 0;
  const marker = join(deps.dir, 'seed-used');
  if ((await readFile(marker, 'utf8').catch(() => null)) !== null) return 0;
  await mkdir(deps.dir, { recursive: true });
  await writeFile(marker, deps.seed);
  if ((await deps.store.read()).characters.length) return 0;
  for (const n of names) deps.add(n, 'play');
  return names.length;
}
