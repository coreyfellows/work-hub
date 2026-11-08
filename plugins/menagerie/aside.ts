// Pure host helpers (no React), shared by the web half and its tests.
import type { HistoryEntry, ResidentHost } from '../../plugin-api/web.ts';
import type { Aside, FunHost } from './types.ts';

/**
 * Splits a host's aside off the end of an assistant message: the last non-empty line, a blockquote
 * holding a known host's emoji. Returns the message without it, or null when there's no aside.
 */
export function splitAside(markdown: string, hosts: FunHost[]): { body: string; aside: Aside } | null {
  const lines = markdown.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (!last.startsWith('>')) return null;
  const host = hosts.find((h) => last.includes(h.emoji));
  if (!host) return null;
  const text = last
    .replace(/^>\s*/, '')
    .replace(host.emoji, '')
    .replace(/^\s*\*?|\*?\s*$/g, '')
    .trim();
  if (!text) return null;
  return { body: lines.slice(0, -1).join('\n').replace(/\s+$/, ''), aside: { host, text } };
}

/**
 * The session's menagerie host: whoever left the latest aside, unless the transcript's greeting or a
 * `/fun host` swap is newer (so a session is themed from its first message, before any aside).
 */
export function lastHost(entries: HistoryEntry[], fun: FunHost[] | null, resident?: ResidentHost | null): FunHost | undefined {
  if (!fun) return undefined;
  const named = resident ? fun.find((h) => h.name === resident.name) : undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (named && e.i < resident!.at) break;
    if (e.kind !== 'assistant') continue;
    const split = splitAside(e.text ?? '', fun);
    if (split) return split.aside.host;
  }
  return named;
}

/** One of the host's question lines, the same one every render for a given question. */
export function askLine(host: FunHost, seed: string): string | undefined {
  if (!host.asks.length) return undefined;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return host.asks[Math.abs(h) % host.asks.length];
}
