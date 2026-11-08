/** Claude Code version strings (`2.1.319`): parsing, comparing and the channel to follow. Pure, unit-tested. */

/** `2.1.319` → [2, 1, 319]; null for anything that isn't dotted numbers (a pre-release suffix is ignored). */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = typeof v === 'string' ? /^\s*v?(\d+(?:\.\d+)*)/.exec(v) : null;
  return m ? m[1].split('.').map(Number) : null;
}

/** <0, 0 or >0 like a sort comparator; an unparsable version sorts before every real one. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const newer = (a: string | null | undefined, b: string | null | undefined): boolean => compareVersions(a, b) > 0;

/** The highest of the given versions (unparsable ones ignored), or null. */
export function maxVersion(...vs: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of vs) if (parseVersion(v) && (best === null || newer(v, best))) best = v as string;
  return best;
}

/** The version in `claude --version` output (`2.1.319 (Claude Code)`), or null. */
export function versionFromCli(out: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  return m ? m[1] : null;
}

export type Channel = 'latest' | 'stable';

/**
 * Which npm dist-tag to compare against: the plugin's `channel` setting, or with `auto` Claude Code's own
 * `autoUpdatesChannel` (from its settings.json, `latest` by default).
 */
export function pickChannel(setting: string, claudeSettings: unknown): Channel {
  if (setting === 'latest' || setting === 'stable') return setting;
  const c = claudeSettings && typeof claudeSettings === 'object' ? (claudeSettings as Record<string, unknown>).autoUpdatesChannel : undefined;
  return c === 'stable' ? 'stable' : 'latest';
}

/** The channel's version from the npm dist-tags document (`{ latest, stable, next }`), or null. */
export function versionFromDistTags(tags: unknown, channel: Channel): string | null {
  if (!tags || typeof tags !== 'object') return null;
  const t = tags as Record<string, unknown>;
  const v = t[channel] ?? (channel === 'stable' ? t.latest : undefined);
  return typeof v === 'string' && parseVersion(v) ? v : null;
}
