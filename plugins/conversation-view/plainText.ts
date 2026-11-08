/**
 * Markdown to plain text for the chat's "Copy → Plain text": emphasis, headings, quotes, links and code fences lose their
 * markup but keep their words (a link keeps its address in brackets when the text differs). Not a full parser: the
 * Markdown copy is the lossless one.
 */
export function markdownToPlain(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null) {
      out.push(raw); // code stays as typed
      continue;
    }
    // A table's divider row (|---|---|) carries nothing; its other rows become tab-separated.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw) && raw.includes('|')) continue;
    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().slice(1, -1).split('|').map((c) => c.trim()).join('\t');
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(\s*)>\s?/, '$1')
      .replace(/^(\s*)[*+]\s+/, '$1- ')
      .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) => (text === url ? text : `${text} (${url})`))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/<!--.*?-->/g, '');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
