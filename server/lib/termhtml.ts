import { createRequire } from 'node:module';
import type { Terminal as TerminalType, IBufferCell } from '@xterm/headless';

/**
 * Turn terminal output into coloured HTML for the session page: `ansiToHtml` replays a raw terminal
 * stream (from `claude logs`, with cursor moves and 24-bit colour) through a headless xterm, then
 * walks the cell buffer emitting styled spans.
 *
 * All text is HTML-escaped; styles are built only from numbers, so the output is safe to inject.
 */

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as { Terminal: typeof TerminalType };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rgb = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

// xterm's default 16-colour palette, tuned for a dark background.
const ANSI16 = [
  0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5,
  0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

function palette(i: number): string {
  if (i < 16) return rgb(ANSI16[i]);
  if (i < 232) {
    const n = i - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgb((level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6));
  }
  const g = 8 + (i - 232) * 10;
  return rgb((g << 16) | (g << 8) | g);
}

function cellStyle(c: IBufferCell): string {
  let fg = c.isFgRGB() ? rgb(c.getFgColor()) : c.isFgPalette() ? palette(c.getFgColor()) : '';
  let bg = c.isBgRGB() ? rgb(c.getBgColor()) : c.isBgPalette() ? palette(c.getBgColor()) : '';
  if (c.isInverse()) [fg, bg] = [bg || 'var(--term-bg)', fg || 'var(--term-fg)'];
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (c.isBold()) parts.push('font-weight:700');
  if (c.isDim()) parts.push('opacity:.6');
  if (c.isItalic()) parts.push('font-style:italic');
  if (c.isUnderline()) parts.push('text-decoration:underline');
  if (c.isStrikethrough()) parts.push('text-decoration:line-through');
  if (c.isInvisible()) parts.push('visibility:hidden');
  return parts.join(';');
}

let cache: { raw: string; maxLines: number; html: string } | null = null;

export async function ansiToHtml(raw: string, maxLines = 400): Promise<string> {
  if (cache && cache.raw === raw && cache.maxLines === maxLines) return cache.html;

  // Size the virtual terminal to the stream: as wide as its furthest cursor column, and tall
  // enough that downward cursor moves never hit the bottom (they don't scroll; they'd overwrite).
  let cols = 80;
  for (const m of raw.matchAll(/\x1b\[(\d+)G/g)) cols = Math.max(cols, Number(m[1]) + 1);
  let rows = (raw.match(/\n/g) ?? []).length + 10;
  for (const m of raw.matchAll(/\x1b\[(\d*)B/g)) rows += Number(m[1] || 1);
  rows = Math.min(rows, 6000);
  cols = Math.min(cols, 400);

  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  await new Promise<void>((done) => term.write(raw, done));

  const buf = term.buffer.active;
  let last = buf.length - 1;
  while (last >= 0 && !buf.getLine(last)?.translateToString(true).trim()) last--;
  const first = Math.max(0, last - maxLines + 1);

  const out: string[] = [];
  const cell = buf.getNullCell();
  for (let y = first; y <= last; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const width = line.translateToString(true).length;
    let html = '';
    let runStyle: string | null = null;
    let runText = '';
    const flush = () => {
      if (!runText) return;
      html += runStyle ? `<span style="${runStyle}">${esc(runText)}</span>` : esc(runText);
      runText = '';
    };
    for (let x = 0; x < Math.max(width, 0) && x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // trailing half of a wide character
      const style = cellStyle(cell);
      if (style !== runStyle) {
        flush();
        runStyle = style;
      }
      runText += cell.getChars() || ' ';
    }
    flush();
    out.push(html);
  }
  term.dispose();

  const html = out.join('\n');
  cache = { raw, maxLines, html };
  return html;
}
