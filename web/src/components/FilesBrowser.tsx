import { useEffect, useRef, useState } from 'react';
import type { FileEdit } from '../api.ts';

/**
 * How file changes are drawn everywhere (log cards, the session's changed-files modal, commit browsers): one change
 * as a diff or, for a new file, as the file; and a tree of files beside the selected file's net change.
 */

/** `h`/`n` (unchanged lines): which hunk and which line of its new text, to look up the syntax-highlighted version. */
type Line = { t: ' ' | '+' | '-'; l: string; h?: number; n?: number };

/** A line diff of one replacement (LCS); big inputs fall back to all-removed then all-added. */
function lineDiff(oldText: string, newText: string): Line[] {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  if (a.length * b.length > 250_000) return [...a.map((l) => ({ t: '-' as const, l })), ...b.map((l) => ({ t: '+' as const, l }))];
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', l: a[i]!, n: j });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ t: '-', l: a[i++]! });
    else out.push({ t: '+', l: b[j++]! });
  }
  while (i < a.length) out.push({ t: '-', l: a[i++]! });
  while (j < b.length) out.push({ t: '+', l: b[j++]! });
  return out;
}

/** Keeps changed lines and `ctx` lines of context around them; longer unchanged runs become one "⋯" line. */
function withContext(lines: Line[], ctx = 2): Array<Line | null> {
  const keep = lines.map((x) => x.t !== ' ');
  const near = lines.map((_, i) => keep.slice(Math.max(0, i - ctx), i + ctx + 1).some(Boolean));
  const out: Array<Line | null> = [];
  lines.forEach((x, i) => {
    if (near[i]) out.push(x);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

function changeLines(edit: FileEdit): Array<Line | null> {
  if (edit.content !== undefined) return edit.content.split('\n').map((l) => ({ t: '+' as const, l }));
  const out: Array<Line | null> = [];
  (edit.hunks ?? []).forEach((h, k) => {
    if (k > 0) out.push(null);
    out.push(...withContext(lineDiff(h.old, h.new)).map((x) => (x && x.t === ' ' ? { ...x, h: k } : x)));
  });
  return out;
}

/** `~/…/dir/file.ts` → file name and a short parent path. */
export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.replace(/^\/Users\/[^/]+/, '~').split('/');
  const name = parts.pop() ?? path;
  // Drop the worktree/repo root noise: keep the last three directories.
  const dir = parts.slice(-3).join('/');
  return { name, dir };
}

export type State = 'running' | 'error' | 'done';

const isNewFile = (edit: FileEdit, state: State) => edit.content !== undefined && edit.created !== false && state !== 'error';

/** The one-line description of a change: verb, file, where, and its counts. */
export function EditSummary({ edit, state }: { edit: FileEdit; state: State }) {
  const { name, dir } = splitPath(edit.path);
  if (isNewFile(edit, state)) {
    const total = edit.lines ?? edit.content!.split('\n').length;
    return (
      <>
        <span className="edit-verb">{state === 'running' ? 'Creating…' : 'Created'}</span>
        <span className="edit-name">{name}</span>
        {dir && <span className="edit-dir">{dir}</span>}
        <span className="edit-stat">
          <span className="edit-lines">
            {total} {total === 1 ? 'line' : 'lines'}
          </span>
        </span>
      </>
    );
  }
  const lines = changeLines(edit);
  const added = lines.filter((x) => x?.t === '+').length;
  const removed = lines.filter((x) => x?.t === '-').length;
  const write = edit.content !== undefined;
  const verb = state === 'running' ? (write ? 'Writing…' : 'Editing…') : write ? 'Wrote' : 'Edited';
  return (
    <>
      <span className="edit-verb">{verb}</span>
      <span className="edit-name">{name}</span>
      {dir && <span className="edit-dir">{dir}</span>}
      <span className="edit-stat">
        {added > 0 && <span className="add">+{added}</span>}
        {removed > 0 && <span className="del">−{removed}</span>}
        {state === 'error' && <span className="del">didn't apply</span>}
        {state !== 'error' && lines.length === 0 && <span className="edit-lines">no net change</span>}
      </span>
    </>
  );
}

/** The change itself: a new file as the file (line numbers, highlighted), anything else as a diff. */
export function EditBody({ edit, state }: { edit: FileEdit; state: State }) {
  return isNewFile(edit, state) ? <NewFileBody edit={edit} content={edit.content!} /> : <DiffBody edit={edit} />;
}

function DiffBody({ edit }: { edit: FileEdit }) {
  // Unchanged lines get syntax colours (each hunk's new text highlighted whole, then split per line).
  const [hl, setHl] = useState<Array<string[] | null> | null>(null);
  const hunkKey = (edit.hunks ?? []).map((h) => h.new).join('\u0000'); // polls hand back a new object each time
  useEffect(() => {
    let alive = true;
    const hunks = edit.hunks ?? [];
    if (hunks.length)
      void import('../highlightCode.ts')
        .then((m) => alive && setHl(hunks.map((h) => m.highlightLines(edit.path, h.new))))
        .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.path, hunkKey]);
  const lines = changeLines(edit);
  if (!lines.length) return <div className="edit-dir modal-empty">No net change.</div>;
  return (
    <pre className="diff edit-diff">
      {lines.map((x, k) =>
        x === null ? (
          <span key={k} className="gap">
            {'⋯\n'}
          </span>
        ) : x.t === ' ' && x.h !== undefined && x.n !== undefined && hl?.[x.h]?.[x.n] !== undefined ? (
          <span key={k} className="ctx hl">
            {'  '}
            <span dangerouslySetInnerHTML={{ __html: hl[x.h]![x.n]! }} />
            {'\n'}
          </span>
        ) : (
          <span key={k} className={x.t === '+' ? 'add' : x.t === '-' ? 'del' : 'ctx'}>
            {`${x.t} ${x.l}\n`}
          </span>
        ),
      )}
    </pre>
  );
}

const WRAP_KEY = 'wh.wrapFiles';

/** Word wrap for file views: on unless turned off, remembered per device. */
function useWrap(): [boolean, (v: boolean) => void] {
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem(WRAP_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  return [
    wrap,
    (v) => {
      setWrap(v);
      try {
        if (v) localStorage.removeItem(WRAP_KEY);
        else localStorage.setItem(WRAP_KEY, 'off');
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

/**
 * A file the session created: its content with line numbers and syntax highlighting (by extension or shebang).
 * `highlight` marks a line range (1-based, inclusive) and scrolls it into view.
 */
export function NewFileBody({ edit, content, highlight }: { edit: { path: string }; content: string; highlight?: { from: number; to: number } }) {
  const [html, setHtml] = useState<string | null>(null);
  const [lineHtml, setLineHtml] = useState<string[] | null>(null);
  const [wrap, setWrap] = useWrap();
  const mark = useRef<HTMLDivElement>(null);
  const hl = highlight ? { from: Math.max(1, highlight.from), to: Math.max(highlight.from, highlight.to) } : null;
  useEffect(() => {
    if (hl) mark.current?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl?.from, hl?.to, wrap, html !== null]);
  useEffect(() => {
    let alive = true;
    void import('../highlightCode.ts')
      .then((m) => {
        if (!alive) return;
        setHtml(m.highlightFile(edit.path, content));
        setLineHtml(m.highlightLines(edit.path, content));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [edit.path, content]);
  const lines = content.split('\n');
  const n = lines.length;
  return (
    <div className="edit-filewrap">
      <div className="edit-toolbar">
        <label className="edit-wrap-toggle">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
        </label>
      </div>
      {wrap ? (
        // One row per line, so a wrapped line keeps its number beside its first row.
        <div className="edit-file wrap hljs-host">
          <div className="edit-wrap-lines hljs" style={{ ['--ln-w' as string]: `${String(n).length}ch` }}>
            {lines.map((l, i) => (
              <div key={i} ref={hl && i + 1 === hl.from ? mark : undefined} className={`edit-wl${hl && i + 1 >= hl.from && i + 1 <= hl.to ? ' hl' : ''}`}>
                <span className="edit-ln" aria-hidden>
                  {i + 1}
                </span>
                {lineHtml?.[i] !== undefined ? <span className="edit-wt" dangerouslySetInnerHTML={{ __html: lineHtml[i] || ' ' }} /> : <span className="edit-wt">{l || ' '}</span>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className={`edit-file${hl ? ' has-hl' : ''}`}>
          {hl && <div ref={mark} className="edit-hl" style={{ ['--hl-from' as string]: hl.from, ['--hl-n' as string]: Math.min(hl.to, n) - hl.from + 1 }} aria-hidden />}
          <pre className="edit-ln" aria-hidden>
            {Array.from({ length: n }, (_, i) => i + 1).join('\n')}
          </pre>
          {html !== null ? <pre className="edit-src hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="edit-src">{content}</pre>}
        </div>
      )}
    </div>
  );
}

/** +/− line counts of one change, and whether it created the file. */
export function editStats(edit: FileEdit): { added: number; removed: number; created: boolean } {
  const created = edit.content !== undefined && edit.created !== false;
  if (created) return { added: edit.lines ?? edit.content!.split('\n').length, removed: 0, created };
  const lines = changeLines(edit);
  return { added: lines.filter((x) => x?.t === '+').length, removed: lines.filter((x) => x?.t === '-').length, created };
}

export type GroupItem = { key: string; edit: FileEdit; state: State };

/** A file in a changes tree: its net change (null while loading or if nothing applied) and counts; `status` A/M/D. */
export type FileNode = { path: string; edits: GroupItem[]; net: GroupItem | null; added: number; removed: number; created: boolean; failed: boolean; status?: string };

/** A run's changes to one file as a single item (net change, failed ones dropped); null if none applied. */
export function netItem(items: GroupItem[]): GroupItem | null {
  const ok = items.filter((it) => it.state !== 'error');
  if (!ok.length) return null;
  return { key: ok[0]!.key, edit: composeEdits(ok.map((it) => it.edit)), state: ok.some((it) => it.state === 'running') ? 'running' : 'done' };
}
type Dir = { name: string; dirs: Map<string, Dir>; files: FileNode[] };

/** Paths → a directory tree under their common parent, with single-child directory chains merged ("server/lib"). */
export function buildTree(files: FileNode[]): { root: Dir; base: string } {
  const split = files.map((f) => f.path.split('/'));
  let common = split[0]!.length - 1;
  for (const p of split) {
    let k = 0;
    while (k < common && k < p.length - 1 && p[k] === split[0]![k]) k++;
    common = k;
  }
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  files.forEach((f, i) => {
    let d = root;
    for (const part of split[i]!.slice(common, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { name: part, dirs: new Map(), files: [] });
      d = d.dirs.get(part)!;
    }
    d.files.push(f);
  });
  const merge = (d: Dir): Dir => {
    for (const [k, c] of d.dirs) d.dirs.set(k, merge(c));
    if (d.name && d.dirs.size === 1 && d.files.length === 0) {
      const only = [...d.dirs.values()][0]!;
      return { ...only, name: `${d.name}/${only.name}` };
    }
    return d;
  };
  return { root: merge(root), base: split[0]!.slice(0, common).join('/') };
}

function Stat({ added, removed, failed }: { added: number; removed: number; failed?: boolean }) {
  return (
    <span className="edit-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
      {failed && <span className="del">didn't apply</span>}
    </span>
  );
}

function TreeDir({ d, selected, onSelect }: { d: Dir; selected: string; onSelect: (path: string) => void }) {
  const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...d.files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <ul className="ftree">
      {dirs.map((c) => (
        <li key={`d-${c.name}`}>
          <div className="ftree-dir">{c.name}/</div>
          <TreeDir d={c} selected={selected} onSelect={onSelect} />
        </li>
      ))}
      {files.map((f) => (
        <li key={f.path}>
          <button type="button" className={`ftree-file${f.path === selected ? ' sel' : ''}`} title={f.path} onClick={() => onSelect(f.path)}>
            {(() => {
              const st = f.status ?? (f.created ? 'A' : 'M');
              return (
                <span className={`git-st ${st === 'A' ? 'add' : st === 'D' ? 'del' : 'mod'}`} title={st === 'A' ? 'new file' : st === 'D' ? 'deleted' : 'modified'}>
                  {st}
                </span>
              );
            })()}
            <span className="ftree-name">{f.path.split('/').pop()}</span>
            {f.edits.length > 1 && <span className="edit-dir">{f.edits.length} edits</span>}
            <Stat added={f.added} removed={f.removed} failed={f.failed} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A file tree beside the selected file's change (stacked on phones), for the grouped-changes and commit modals. */
export function FilesBrowser({ files, selected, onSelect, empty = 'No change applied.' }: { files: FileNode[]; selected: string; onSelect: (path: string) => void; empty?: string }) {
  const { root } = buildTree(files);
  const sel = files.find((f) => f.path === selected) ?? null;
  return (
    <div className="fg-split">
      <nav className="fg-tree">
        <TreeDir d={root} selected={selected} onSelect={onSelect} />
      </nav>
      <div className="fg-pane">
        {sel?.net ? (
          <>
            <div className="fg-pane-head" title={sel.path}>
              <EditSummary edit={sel.net.edit} state={sel.net.state} />
            </div>
            <EditBody key={sel.path} edit={sel.net.edit} state={sel.net.state} />
          </>
        ) : (
          <div className="edit-dir modal-empty">{empty}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Several changes to one file → one change from before the first to after the last. Edits only carry snippets, so
 * they're replayed onto regions: an edit whose old text sits inside an earlier region's current text folds into it
 * (keeping that region's original "before"); one whose old text contains earlier regions absorbs them; anything else
 * is a new region. A Write replaces the whole file and later edits apply inside it. Failed edits are skipped.
 */
export function composeEdits(edits: FileEdit[]): FileEdit {
  if (edits.length === 1) return edits[0]!;
  const last = edits[edits.length - 1]!;
  const replaceOnce = (s: string, a: string, b: string) => {
    const i = s.indexOf(a);
    return i < 0 ? s : s.slice(0, i) + b + s.slice(i + a.length);
  };
  let whole: { content: string; created: boolean } | null = null;
  let segs: Array<{ old: string; cur: string }> = [];
  for (const e of edits) {
    if (e.content !== undefined) {
      whole = { content: e.content, created: whole ? whole.created : e.created !== false };
      segs = [];
      continue;
    }
    for (const h of e.hunks ?? []) {
      if (!h.old) continue;
      if (whole) {
        whole.content = replaceOnce(whole.content, h.old, h.new);
        continue;
      }
      const inside = segs.find((s) => s.cur.includes(h.old));
      if (inside) {
        inside.cur = replaceOnce(inside.cur, h.old, h.new);
        continue;
      }
      const absorbed = segs.filter((s) => s.cur && h.old.includes(s.cur));
      let old = h.old;
      for (const s of absorbed) old = replaceOnce(old, s.cur, s.old);
      segs = segs.filter((s) => !absorbed.includes(s));
      segs.push({ old, cur: h.new });
    }
  }
  if (whole) return { path: last.path, tool: last.tool, at: last.at, content: whole.content, lines: whole.content.split('\n').length, created: whole.created };
  return { path: last.path, tool: last.tool, at: last.at, hunks: segs.filter((s) => s.old !== s.cur).map((s) => ({ old: s.old, new: s.cur })) };
}
