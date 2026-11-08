/** Claude Code's CHANGELOG.md: `## <version>` sections of `- ` items. Pure, unit-tested. */
import { compareVersions, newer, parseVersion } from './version.ts';

export interface ChangelogEntry {
  version: string;
  /** The section's items, each one Markdown line without its leading `- `. */
  items: string[];
}

/** Every `## x.y.z` section, in file order (newest first in Claude Code's file). Continuation lines join their item. */
export function parseChangelog(md: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const h = /^##\s+\[?v?(\d+(?:\.\d+)+)\]?/.exec(raw);
    if (h) {
      cur = { version: h[1], items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^#\s/.test(raw)) {
      cur = null;
      continue;
    }
    const item = /^\s{0,1}[-*]\s+(.*)$/.exec(raw);
    if (item) cur.items.push(item[1].trim());
    else if (raw.trim() && cur.items.length) cur.items[cur.items.length - 1] += ` ${raw.trim()}`;
  }
  return out;
}

/** The newest version the changelog names, or null. */
export function newestIn(entries: ChangelogEntry[]): string | null {
  let best: string | null = null;
  for (const e of entries) if (best === null || newer(e.version, best)) best = e.version;
  return best;
}

/** Entries with `from < version <= to` (`from` null: everything up to `to`), newest first. */
export function between(entries: ChangelogEntry[], from: string | null, to: string): ChangelogEntry[] {
  return entries
    .filter((e) => parseVersion(e.version) && (from === null || newer(e.version, from)) && compareVersions(e.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The entries as Markdown (`## version` then its items), newest first, cut to about `maxChars` by dropping the oldest. */
export function toMarkdown(entries: ChangelogEntry[], maxChars = Infinity): { text: string; dropped: number } {
  const parts: string[] = [];
  let size = 0;
  let dropped = 0;
  for (const e of entries) {
    const block = [`## ${e.version}`, ...e.items.map((i) => `- ${i}`)].join('\n');
    if (dropped || (parts.length && size + block.length > maxChars)) {
      dropped++; // once one doesn't fit, every older one goes too: no gaps
      continue;
    }
    parts.push(block);
    size += block.length + 2;
  }
  return { text: parts.join('\n\n'), dropped };
}
