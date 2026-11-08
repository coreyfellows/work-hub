/**
 * The source-control providers in force. The core registers git and folder at startup (owner 'core'); plugins add theirs
 * through `ctx.vcs.register` (owner = plugin id), and the loader takes a failed plugin's back (`removeProviders`).
 */
import type { SourceControlProvider } from './types.ts';

const providers: Array<{ provider: SourceControlProvider; owner: string }> = [];

/** Detection order for the ids that can overlap (a colocated jj repo also has `.git`); others follow, folder last. */
const ORDER = ['git', 'jj', 'hg', 'p4'];
const FOLDER = 'folder';

function rank(id: string): number {
  if (id === FOLDER) return Number.MAX_SAFE_INTEGER;
  const i = ORDER.indexOf(id);
  return i === -1 ? ORDER.length : i;
}

/** `owner`: the plugin adding it, for `removeProviders`. A second provider with the same id throws. */
export function registerProvider(p: SourceControlProvider, owner = 'core'): void {
  if (providers.some((e) => e.provider.id === p.id)) throw new Error(`source-control provider "${p.id}" is already registered`);
  providers.push({ provider: p, owner });
}

/** Drop every provider `owner` registered. */
export function removeProviders(owner: string): void {
  for (let i = providers.length - 1; i >= 0; i--) if (providers[i].owner === owner) providers.splice(i, 1);
}

export function getProvider(id: string): SourceControlProvider | undefined {
  return providers.find((e) => e.provider.id === id)?.provider;
}

/** Every provider, in detection order (git, jj, hg, p4, then the rest as registered, folder last). */
export function listProviders(): SourceControlProvider[] {
  return providers
    .map((e, i) => ({ p: e.provider, i }))
    .sort((a, b) => rank(a.p.id) - rank(b.p.id) || a.i - b.i)
    .map((e) => e.p);
}

/**
 * The provider whose working copy `path` is in, and its root. `prefer` (the workspace's choice or Settings' default) is
 * asked first when it names a provider other than folder; then the detection order. folder matches anything, with the
 * path itself as the root, so it never beats a real match. A provider whose `detect` throws counts as not matching.
 */
export async function detectProvider(path: string, opts: { prefer?: string | null } = {}): Promise<{ provider: SourceControlProvider; root: string } | null> {
  const list = listProviders();
  const preferred = opts.prefer && opts.prefer !== FOLDER ? list.find((p) => p.id === opts.prefer) : undefined;
  const order = preferred ? [preferred, ...list.filter((p) => p !== preferred)] : list;
  for (const provider of order) {
    const root = await provider.detect(path).catch(() => null);
    if (root) return { provider, root };
  }
  return null;
}
