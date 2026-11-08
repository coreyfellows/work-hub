import { join } from 'node:path';
import type { FileEdit } from './transcript.ts';

const SIDE_CAP = 6000;
const clip = (s: string) => (s.length > SIDE_CAP ? `${s.slice(0, SIDE_CAP)}…` : s);

/** A unified diff → one FileEdit per file; each hunk becomes { old: context+removed, new: context+added }. */
export function parseDiff(diff: string, top: string, at: string | null): FileEdit[] {
  const out: FileEdit[] = [];
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n');
    if (lines.some((l) => l.startsWith('Binary files '))) continue;
    const plus = lines.find((l) => l.startsWith('+++ '));
    const minus = lines.find((l) => l.startsWith('--- '));
    const created = minus === '--- /dev/null';
    const name = (plus && plus !== '+++ /dev/null' ? plus.slice(4) : (minus?.slice(4) ?? '')).replace(/^[ab]\//, '');
    if (!name) continue;
    const hunks: Array<{ old: string; new: string }> = [];
    let cur: { old: string[]; new: string[] } | null = null;
    for (const l of lines) {
      if (l.startsWith('@@')) {
        if (cur) hunks.push({ old: clip(cur.old.join('\n')), new: clip(cur.new.join('\n')) });
        cur = { old: [], new: [] };
      } else if (cur) {
        if (l.startsWith('+')) cur.new.push(l.slice(1));
        else if (l.startsWith('-')) cur.old.push(l.slice(1));
        else if (l.startsWith(' ')) {
          cur.old.push(l.slice(1));
          cur.new.push(l.slice(1));
        }
      }
    }
    if (cur) hunks.push({ old: clip(cur.old.join('\n')), new: clip(cur.new.join('\n')) });
    const path = join(top, name);
    if (created && hunks.length === 1) {
      const content = hunks[0]!.new;
      out.push({ path, tool: 'Bash', at, content, lines: content.split('\n').length, created: true });
    } else if (hunks.length) out.push({ path, tool: 'Bash', at, hunks });
  }
  return out;
}
