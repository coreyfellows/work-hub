/** One question of an AskUserQuestion form, as the transcript records it. */
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface AnswerInput {
  options?: number[];
  text?: string;
}

export type KeyPlan = { ok: true; chunks: string[] } | { ok: false; status: 400; error: string };

/**
 * The keystrokes (verified against Claude's menu) that answer a form:
 *   single-select: the option's number (picks it and moves on); your own text: the "Type something" number
 *   (options + 1), the text, Enter. Multi-select: each option's number toggles it, Tab moves on.
 *   With more than one question a review screen follows, where 1 submits.
 */
export function answerKeys(qs: Question[], answers: AnswerInput[], enter: string, tab: string): KeyPlan {
  const chunks: string[] = [];
  for (let qi = 0; qi < qs.length; qi++) {
    const q = qs[qi];
    const a = answers[qi] ?? {};
    const n = q.options.length;
    const picks = (a.options ?? []).filter((o) => Number.isInteger(o) && o >= 0 && o < n);
    if (q.multiSelect) {
      if (!picks.length) return { ok: false, status: 400, error: `pick at least one option for "${q.question}"` };
      for (const o of [...new Set(picks)]) chunks.push(String(o + 1));
      chunks.push(tab);
    } else if (a.text?.trim()) {
      if (n + 1 > 9) return { ok: false, status: 400, error: 'too many options to type a custom answer' };
      chunks.push(String(n + 1), a.text.trim().replace(/[\r\n]+/g, ' '), enter);
    } else {
      if (picks.length !== 1) return { ok: false, status: 400, error: `pick one option for "${q.question}"` };
      chunks.push(String(picks[0] + 1));
    }
  }
  if (qs.length > 1) chunks.push('1'); // review screen: "1. Submit answers"
  return { ok: true, chunks };
}

/**
 * Whether Claude's screen (plain text) is showing this form. Compared without whitespace and box-drawing
 * characters: on a narrow terminal Claude wraps the question across lines inside its menu border. On a short
 * screen (a phone viewer is ~22 rows) a long form doesn't fit and Claude cuts off its top, question text
 * included, so also accept Claude's menu itself: its own "Type something" / "Chat about this" entries plus one
 * of the first question's option labels or its header.
 */
export function screenShowsQuestion(screen: string, qs: Question[]): boolean {
  const squash = (t: string) => t.replace(/[\s│┃║╭╮╰╯┌┐└┘╔╗╚╝─━═|]+/g, '');
  const flat = squash(screen);
  const showsQuestion = flat.includes(squash(qs[0].question).slice(0, 32));
  const showsMenu =
    /Typesomething|Chataboutthis/.test(flat) && [...qs[0].options.map((o) => o.label), qs[0].header ?? ''].some((t) => t && flat.includes(squash(t)));
  return showsQuestion || showsMenu;
}
