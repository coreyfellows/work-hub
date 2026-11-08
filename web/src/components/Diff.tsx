import { Fragment, type ReactNode } from 'react';

/** Unified-diff rendering with old/new line numbers, and a slot to show review threads under a line. */

export interface DiffLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  old: number | null;
  new: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const raw of patch.split('\n')) {
    const m = HUNK.exec(raw);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      out.push({ kind: 'hunk', text: raw, old: null, new: null });
    } else if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), old: null, new: n++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), old: o++, new: null });
    else if (raw.startsWith('\\')) out.push({ kind: 'meta', text: raw, old: null, new: null });
    else if (out.length) out.push({ kind: 'ctx', text: raw.slice(1), old: o++, new: n++ });
  }
  // A trailing newline in the patch leaves an empty context line that isn't in the file.
  const last = out[out.length - 1];
  if (last?.kind === 'ctx' && last.text === '' && patch.endsWith('\n')) out.pop();
  return out;
}

/** Key for "the line a thread sits on": side + line number on that side. */
export const lineKey = (side: 'LEFT' | 'RIGHT', line: number) => `${side}:${line}`;

const SIGN = { add: '+', del: '−', ctx: ' ', hunk: '', meta: '' } as const;

export function DiffTable({
  lines,
  after,
  highlight,
}: {
  lines: DiffLine[];
  /** Rendered in a full-width row under the line with this key (see lineKey). */
  after?: (keys: string[]) => ReactNode;
  /** Keys of lines to tint (the lines a comment covers). */
  highlight?: Set<string>;
}) {
  return (
    <div className="diff-scroll">
      <table className="diff">
        <tbody>
          {lines.map((l, i) => {
            const keys = [l.new != null ? lineKey('RIGHT', l.new) : null, l.old != null ? lineKey('LEFT', l.old) : null].filter(Boolean) as string[];
            const extra = after?.(keys);
            const hl = keys.some((k) => highlight?.has(k));
            return (
              <Fragment key={i}>
                {l.kind === 'hunk' || l.kind === 'meta' ? (
                  <tr className="d-hunk">
                    <td className="ln" colSpan={2} />
                    <td className="code">{l.text}</td>
                  </tr>
                ) : (
                  <tr className={`d-${l.kind}${hl ? ' d-hl' : ''}`}>
                    <td className="ln">{l.old ?? ''}</td>
                    <td className="ln">{l.new ?? ''}</td>
                    <td className="code">
                      <span className="sign">{SIGN[l.kind]}</span>
                      {l.text}
                    </td>
                  </tr>
                )}
                {extra && (
                  <tr className="d-extra">
                    <td colSpan={3}>{extra}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A unified diff (a patch's text) as a table with old/new line numbers. */
export function Diff({ patch, after, highlight }: { patch: string; after?: (keys: string[]) => ReactNode; highlight?: Set<string> }) {
  return <DiffTable lines={parsePatch(patch)} after={after} highlight={highlight} />;
}
