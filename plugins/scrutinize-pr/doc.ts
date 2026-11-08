/**
 * The summary document as sections, shared by the server (addenda, rewrites) and the web tab (threads sit under the
 * section they were asked about). Pure: no Node or DOM.
 *
 * A section is a heading of level 1 to 3 and everything up to the next such heading (deeper headings stay inside it),
 * so a `##` with `###` children is its intro only. Text before the first heading is the `top` section. Headings inside
 * fenced code blocks don't count.
 */

export interface Section {
  /** Stable while the heading text is: a slug of it, `-2`, `-3`… for repeats; `top` for the preamble. */
  id: string;
  /** 0 for the preamble, else the heading's level (1–3). */
  level: number;
  /** The heading's text ('' for the preamble). */
  title: string;
  /** The section's Markdown, heading line included. */
  text: string;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```+|~~~+)/;

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'section';
}

export function splitSections(md: string): Section[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Section[] = [];
  const seen = new Map<string, number>();
  let cur: { level: number; title: string; lines: string[] } = { level: 0, title: '', lines: [] };
  let fence: string | null = null;
  const push = () => {
    if (cur.level === 0 && cur.lines.every((l) => !l.trim())) return;
    const base = cur.level === 0 ? 'top' : slug(cur.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}-${n}`, level: cur.level, title: cur.title, text: cur.lines.join('\n') });
  };
  for (const line of lines) {
    const f = line.match(FENCE);
    if (f) {
      const mark = f[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
    }
    const h = fence === null && !f ? line.match(HEADING) : null;
    if (h) {
      push();
      cur = { level: h[1].length, title: h[2], lines: [line] };
    } else cur.lines.push(line);
  }
  push();
  return out;
}

export const joinSections = (sections: Section[]): string => sections.map((s) => s.text.replace(/\n+$/, '')).join('\n\n') + '\n';

/** Push headings of level 1–3 in model-written content down to `####`, so an addendum or rewrite never splits sections. */
export function demoteHeadings(md: string): string {
  let fence: string | null = null;
  return md
    .split('\n')
    .map((line) => {
      const f = line.match(FENCE);
      if (f) {
        const mark = f[1][0];
        if (fence === null) fence = mark;
        else if (fence === mark) fence = null;
        return line;
      }
      return fence === null ? line.replace(/^#{1,3}(\s)/, '####$1') : line;
    })
    .join('\n');
}

function replaceSection(md: string, sectionId: string, fn: (s: Section) => string): string {
  const sections = splitSections(md);
  const s = sections.find((x) => x.id === sectionId);
  if (!s) throw new Error('that section is no longer in the summary');
  s.text = fn(s);
  return joinSections(sections);
}

const headingLine = (s: Section) => (s.level === 0 ? null : s.text.split('\n')[0]);
const quoteLine = (q: string) => {
  const one = q.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
};

/** Append an addendum (from a question) to a section. */
export function applyAddendum(md: string, sectionId: string, content: string, question: string): string {
  return replaceSection(md, sectionId, (s) => {
    const body = demoteHeadings(content.trim());
    return `${s.text.replace(/\n+$/, '')}\n\n**Addendum** (asked: “${quoteLine(question)}”)\n\n${body}\n`;
  });
}

/** Replace a section's body, keeping its heading. A leading copy of the heading in `content` is dropped. */
export function applyRewrite(md: string, sectionId: string, content: string): string {
  return replaceSection(md, sectionId, (s) => {
    const head = headingLine(s);
    let body = content.trim();
    const first = body.split('\n')[0];
    const m = first.match(HEADING);
    if (m && m[2].trim().toLowerCase() === s.title.trim().toLowerCase()) body = body.slice(first.length).trim();
    body = demoteHeadings(body);
    return head ? `${head}\n\n${body}\n` : `${body}\n`;
  });
}

/** The section a thread belongs to now: by id, else by title (the document was regenerated), else null. */
export function findSection(sections: Section[], t: { sectionId: string; sectionTitle: string }): Section | null {
  return sections.find((s) => s.id === t.sectionId) ?? sections.find((s) => s.title && s.title === t.sectionTitle) ?? null;
}

/** One change an update makes (see `updatePrompt`): a section's body replaced, a new section added, or one removed. */
export type SectionEdit =
  | { action: 'replace'; section: string; content: string }
  | { action: 'insert'; after: string; content: string }
  | { action: 'remove'; section: string };

const UPDATES_TITLE = 'Updates';

/**
 * Apply an update's edits. Unknown section ids are skipped (and returned), so one bad id doesn't lose the rest. An insert
 * must start with a `##`/`###` heading (it becomes a section of its own); without one it is appended to `after`.
 * The title, Updates and Minutiae can't be removed.
 */
export function applyEdits(md: string, edits: SectionEdit[]): { markdown: string; skipped: string[] } {
  const skipped: string[] = [];
  let out = md;
  const has = (id: string) => splitSections(out).some((s) => s.id === id);
  // Replacements and removals first (by id, as the model saw them), then inserts.
  for (const e of edits) {
    if (e.action === 'replace') {
      if (has(e.section)) out = applyRewrite(out, e.section, e.content);
      else skipped.push(e.section);
    } else if (e.action === 'remove') {
      const sections = splitSections(out);
      const s = sections.find((x) => x.id === e.section);
      if (!s || s.level <= 1 || [UPDATES_TITLE, 'Minutiae'].includes(s.title)) skipped.push(e.section);
      else out = joinSections(sections.filter((x) => x !== s));
    }
  }
  // In reverse, so several inserts after the same section keep their order.
  for (const e of [...edits].reverse()) {
    if (e.action !== 'insert') continue;
    const sections = splitSections(out);
    const at = sections.findIndex((x) => x.id === e.after);
    if (at < 0) {
      skipped.push(e.after);
      continue;
    }
    const body = e.content.trim();
    const first = body.split('\n')[0];
    const h = first.match(HEADING);
    if (!h || h[1].length < 2) {
      sections[at] = { ...sections[at], text: `${sections[at].text.replace(/\n+$/, '')}\n\n${demoteHeadings(body)}\n` };
      out = joinSections(sections);
      continue;
    }
    // The new section's own heading stays; anything inside it is pushed below `###`.
    const rest = body.slice(first.length).trim();
    const added = splitSections(`${first}\n\n${rest ? demoteHeadings(rest) : ''}\n`);
    sections.splice(at + 1, 0, ...added);
    out = joinSections(sections);
  }
  return { markdown: out, skipped };
}

/** Add a line to the `## Updates` section (made just before Minutiae, else at the end, the first time). */
export function addUpdateNote(md: string, line: string): string {
  const sections = splitSections(md);
  const bullet = `- ${line.replace(/\s*\n\s*/g, ' ').trim()}`;
  const u = sections.find((s) => s.level === 2 && s.title === UPDATES_TITLE);
  if (u) {
    u.text = `${u.text.replace(/\n+$/, '')}\n${bullet}\n`;
    return joinSections(sections);
  }
  const created = { id: 'updates', level: 2, title: UPDATES_TITLE, text: `## ${UPDATES_TITLE}\n\n${bullet}\n` };
  const m = sections.findIndex((s) => s.level === 2 && s.title === 'Minutiae');
  sections.splice(m < 0 ? sections.length : m, 0, created);
  return joinSections(sections);
}
