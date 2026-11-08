/** A tool-permission menu on Claude's screen ("Do you want to proceed?" and its numbered choices). */
export interface PermissionPrompt {
  /** The dialog's heading, e.g. "Bash command", "Tool use", "Edit file". */
  title: string;
  /** What it wants to do: the command, the file, the reason given (frame characters stripped). */
  body: string[];
  /** The question above the choices, e.g. "Do you want to proceed?". */
  question: string;
  options: Array<{ n: number; label: string }>;
}

const RULE = /^\s*[─━]{8,}/;
const DASHES = /^\s*[╌┄┈-]{8,}\s*$/;
const OPTION = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+)$/;
const FOOTER = /Esc to cancel/i;

/**
 * Finds the permission menu at the bottom of Claude's screen (plain text). Null unless the screen ends with numbered
 * choices under a question and Claude's "Esc to cancel" footer, and it isn't an AskUserQuestion form (those have
 * their own "Type something" / "Chat about this" entries and their own form).
 */
export function parsePermissionPrompt(screen: string): PermissionPrompt | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  const footer = findLast(lines, (l) => FOOTER.test(l));
  if (footer < 0) return null;

  // The choices run up from the footer: option lines, plus wrapped continuations indented under them.
  let first = -1;
  let last = -1;
  for (let i = footer - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) {
      if (first >= 0) break;
      continue;
    }
    if (OPTION.test(l)) {
      first = i;
      if (last < 0) last = i;
    } else if (first < 0) {
      last = i; // a continuation of the bottom option, or a stray line under it
    } else if (/^\s{3,}\S/.test(l) && !/\?\s*$/.test(l)) {
      // could be a continuation of an option further up: keep looking
      continue;
    } else break;
  }
  if (first < 0) return null;

  const options: PermissionPrompt['options'] = [];
  for (let i = first; i <= last; i++) {
    const m = OPTION.exec(lines[i]);
    if (m) options.push({ n: Number(m[1]), label: m[2].trim() });
    else if (options.length && lines[i].trim()) options[options.length - 1].label += ` ${lines[i].trim()}`;
  }
  if (options.some((o) => /^(Type something|Chat about this)/.test(o.label))) return null;
  if (!options.every((o, i) => o.n === i + 1)) return null;

  let q = first - 1;
  while (q >= 0 && !lines[q].trim()) q--;
  if (q < 0 || !/\?\s*$/.test(lines[q])) return null;
  const question = lines[q].trim();

  // Heading and body: from the rule above the dialog down to the question.
  let top = q - 1;
  while (top >= 0 && !RULE.test(lines[top])) top--;
  const inner = lines
    .slice(top + 1, q)
    .filter((l) => !DASHES.test(l))
    .map((l) => l.replace(/^\s*[│┃]\s?/, '').trim());
  while (inner.length && !inner[0]) inner.shift();
  const title = inner.shift() ?? '';
  const body: string[] = [];
  for (const l of inner) {
    if (l === title && !body.length) continue;
    if (!l && (!body.length || !body[body.length - 1])) continue;
    body.push(l);
  }
  while (body.length && !body[body.length - 1]) body.pop();
  return { title, body, question, options };
}

/** Whether two option labels are the same once whitespace (wrapping) is ignored. */
export function sameLabel(a: string, b: string): boolean {
  const squash = (t: string) => t.replace(/\s+/g, '');
  return squash(a) === squash(b);
}

function findLast<T>(xs: T[], fn: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (fn(xs[i])) return i;
  return -1;
}
