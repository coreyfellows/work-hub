/** Claude's spinner line: a glyph, the word, an ellipsis, then a ticking timer/token count. */
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+([^\s…].{0,40}?)…/;

/**
 * The screen's meaningful lines (frames, prompt and footer dropped) without the spinner line, whose timer
 * changes every second whether or not anything is happening, plus the spinner word as the quip.
 * `text` is the snapshot's text (the server's HTML spans with the tags stripped).
 */
export function readScreenText(text: string): { lines: string[]; quip: string } {
  let quip = '';
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─│╭╮╰╯┌┐└┘━┃>❯]*$/.test(l) && !/^\s*[?⏵].*(shortcuts|to cycle|esc to)/i.test(l))
    .filter((l) => {
      const m = SPINNER.exec(l);
      if (m) quip = m[1]!.trim();
      return !m;
    });
  return { lines, quip };
}

/** Roughly how many characters changed between two screens: text of lines that are new, plus lines that went. */
export function changeSize(prev: string[], next: string[]): number {
  const before = new Set(prev);
  const after = new Set(next);
  let n = 0;
  for (const l of next) if (!before.has(l)) n += l.trim().length;
  for (const l of prev) if (!after.has(l)) n += l.trim().length / 2;
  return n;
}
