/** Finding path-looking pieces of a message (a server check decides which are real files; see panels/FileLinks.tsx). */

const EXTS =
  'ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|txt|yml|yaml|toml|ini|conf|cfg|env|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|css|scss|html|xml|svg|sql|diff|patch|lock|log|csv|plist';
// A path with a slash (optionally ~/ ./ ../ or absolute), or a bare file name with a known extension; `:12` / `#L12` allowed.
const PATH_RE = new RegExp(
  `(?<![\\w/.@~:+-])(?:(?:~|\\.{1,2})?/)?[\\w.@+-]+(?:/[\\w.@+-]+)+(?::\\d+(?::\\d+)?|#L\\d+)?|(?<![\\w/.@~:+-])[\\w@+-][\\w.@+-]*\\.(?:${EXTS})(?::\\d+(?::\\d+)?|#L\\d+)?(?![\\w/-])`,
  'g',
);

/** Path-looking pieces of a text: [start, end, text] with trailing punctuation left out. */
export function pathCandidates(text: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  for (const m of text.matchAll(PATH_RE)) {
    let t = m[0];
    while (/[.,;:!?)\]]$/.test(t)) t = t.slice(0, -1);
    if (t.length < 3 || /^\d+(\.\d+)*$/.test(t)) continue;
    const at = m.index ?? 0;
    out.push([at, at + t.length, t]);
  }
  return out;
}
