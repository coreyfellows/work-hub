import type { ReactNode } from 'react';
import type { InlineTextItem } from '../../../plugin-api/web.ts';
import { useSlot } from '../slots.ts';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** The text between links: the first `inline-text` item that takes it (file paths, say) renders it, else it stays plain. */
function plain(items: InlineTextItem[], text: string, key: string): ReactNode {
  for (const it of items) {
    const r = it.render(text, key);
    if (r != null) return r;
  }
  return text;
}

/**
 * Plain text with http(s) links made clickable (opens in a new tab); the rest goes through the `inline-text` slot
 * (file paths the session can show, from FileLinks). Trailing punctuation stays outside the link.
 */
export function Linkify({ text }: { text: string }) {
  const inline = useSlot('inline-text');
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // Drop trailing punctuation, and a closing bracket with no opener inside the URL.
    for (;;) {
      const c = url[url.length - 1];
      if (c && /[.,;:!?'"*_]/.test(c)) url = url.slice(0, -1);
      else if (c === ')' && !url.includes('(')) url = url.slice(0, -1);
      else if (c === ']' && !url.includes('[')) url = url.slice(0, -1);
      else break;
    }
    if (url.length <= 'https://'.length - 1) continue;
    const at = m.index ?? 0;
    if (at > last) out.push(plain(inline, text.slice(last, at), `t${last}`));
    out.push(
      <a key={at} className="auto-link" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last === 0) return <>{plain(inline, text, 't0')}</>;
  if (last < text.length) out.push(plain(inline, text.slice(last), `t${last}`));
  return <>{out}</>;
}
