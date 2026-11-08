import { useRef, useState } from 'react';
import { Linkify, SessionIdContext, post, useHostProvider, type ComposerAddonProps, type HistoryEntry, type HostRef } from '../../../plugin-api/web.ts';

/** `text` is the own-answer box, kept while a fixed option is picked; it only counts while `other` (the box was the last thing used). */
type Answer = { options: number[]; text: string; other: boolean };

/**
 * A pending AskUserQuestion, as a form. The server turns the answers into the menu keystrokes and
 * refuses if the question is no longer the one on screen (see POST /api/sessions/:id/answer).
 */
export function QuestionForm({ sessionId, ask, host }: { sessionId: string; ask: HistoryEntry; host?: HostRef }) {
  // Framed as the session's menagerie host when there is one (the host-provider slot).
  const hp = useHostProvider();
  const framed = (part: 'qform' | 'qform-sent') => (host && hp ? hp.frame(host, part) : null);
  const fx = (part: 'qform' | 'qform-sent') => framed(part)?.className ?? '';
  const qs = ask.questions ?? [];
  const [answers, setAnswers] = useState<Answer[]>(() => qs.map(() => ({ options: [], text: '', other: false })));
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Shrunk to a one-line bar so the message above it has the room (answers are kept while shrunk).
  const [shrunk, setShrunk] = useState(false);

  const update = (qi: number, fn: (a: Answer) => Answer) => setAnswers((prev) => prev.map((a, i) => (i === qi ? fn(a) : a)));
  const usesOther = (q: { multiSelect?: boolean }, a: Answer) => !q.multiSelect && a.other && !!a.text.trim();
  const isDone = (q: (typeof qs)[number], a: Answer) => (q.multiSelect ? a.options.length > 0 : usesOther(q, a) || a.options.length === 1);
  const complete = qs.every((q, i) => isDone(q, answers[i]));

  const formRef = useRef<HTMLFormElement>(null);
  const isComplete = (as: Answer[]) => qs.every((q, i) => isDone(q, as[i]));

  const submit = async (final: Answer[] = answers) => {
    setState('sending');
    setError(null);
    try {
      await post(`/api/sessions/${sessionId}/answer`, {
        toolUseId: ask.id,
        answers: final.map((a, i) => (usesOther(qs[i], a) ? { text: a.text } : { options: a.options })),
      });
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  };

  if (state === 'sent') {
    return (
      <div className={`qform sent${fx('qform-sent') ? ` ${fx('qform-sent')}` : ''}`} style={framed('qform-sent')?.style}>
        Answers sent ✓ · Claude is picking them up…
      </div>
    );
  }

  const answered = qs.filter((q, i) => isDone(q, answers[i])).length;
  if (shrunk) {
    return (
      <div className={`qform qform-shrunk${fx('qform') ? ` ${fx('qform')}` : ''}`} style={framed('qform')?.style}>
        <span className="qform-title">Claude is asking</span>
        <span className="muted small-text grow">
          {qs.length} {qs.length === 1 ? 'question' : 'questions'}
          {answered > 0 && ` · ${answered} answered`}
        </span>
        <button type="button" className="ghost small qform-toggle" aria-expanded={false} onClick={() => setShrunk(false)}>
          Expand ▴
        </button>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      className={`qform${fx('qform') ? ` ${fx('qform')}` : ''}`}
      style={framed('qform')?.style}
      // Keys: ↑/↓ move between the options (and the "own answer" box), Space picks, Enter picks the focused option and sends.
      onKeyDown={(ev) => {
        if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
        const items = [...(formRef.current?.querySelectorAll<HTMLElement>('.q-option, .q-other') ?? [])];
        const at = items.indexOf(ev.target as HTMLElement);
        if (at < 0) return;
        ev.preventDefault();
        items[Math.max(0, Math.min(items.length - 1, at + (ev.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && state === 'idle') void submit();
      }}
    >
      {host && hp ? <hp.AskHeader host={host} line={hp.askLine(host, ask.id ?? '')} /> : <div className="qform-title">Claude is asking</div>}
      {qs.map((q, qi) => {
        const a = answers[qi];
        return (
          <fieldset key={qi} className="q" disabled={state !== 'idle'}>
            <legend>
              {q.header && <span className="tag">{q.header}</span>} <Linkify text={q.question} />
              {q.multiSelect && <span className="muted small-text"> (pick any)</span>}
            </legend>
            <div className="q-options">
              {q.options.map((o, oi) => {
                const on = a.options.includes(oi) && !usesOther(q, a);
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={oi}
                    className={`q-option ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    aria-disabled={state !== 'idle'}
                    onKeyDown={(ev) => {
                      if (ev.target !== ev.currentTarget || state !== 'idle') return;
                      if (ev.key === ' ') {
                        ev.preventDefault();
                        ev.currentTarget.click();
                      } else if (ev.key === 'Enter') {
                        ev.preventDefault();
                        // Pick the focused option (single-select), then send if that completes the form, else go on to the next question.
                        const next = answers.map((cur, i) => (i === qi && !q.multiSelect ? { ...cur, options: [oi], other: false } : cur));
                        if (!q.multiSelect) setAnswers(next);
                        if (isComplete(next)) void submit(next);
                        else formRef.current?.querySelectorAll<HTMLElement>('fieldset')[qi + 1]?.querySelector<HTMLElement>('.q-option')?.focus();
                      }
                    }}
                    onClick={() =>
                      state === 'idle' &&
                      update(qi, (cur) =>
                        q.multiSelect
                          ? { ...cur, options: cur.options.includes(oi) ? cur.options.filter((x) => x !== oi) : [...cur.options, oi] }
                          : { ...cur, options: [oi], other: false },
                      )
                    }
                  >
                    <span className="q-mark">{q.multiSelect ? (on ? '☑' : '☐') : on ? '◉' : '○'}</span>
                    <span className="grow">
                      <span className="q-label"><Linkify text={o.label} /></span>
                      {o.description && <span className="q-desc"><Linkify text={o.description} /></span>}
                    </span>
                  </div>
                );
              })}
              {!q.multiSelect && (
                <input
                  className={`q-other ${usesOther(q, a) ? 'on' : a.text.trim() ? 'dim' : ''}`}
                  placeholder="Or type your own answer…"
                  value={a.text}
                  // Going back into the box makes it the answer again; a fixed option set it aside without clearing it.
                  onFocus={() => a.text.trim() && !a.other && update(qi, (cur) => ({ ...cur, other: true }))}
                  onChange={(e) => update(qi, (cur) => ({ ...cur, text: e.target.value, other: true }))}
                />
              )}
            </div>
          </fieldset>
        );
      })}
      <div className="qform-actions">
        <button type="submit" className="primary" disabled={!complete || state !== 'idle'}>
          {state === 'sending' ? 'Sending answers…' : 'Send answers'}
        </button>
        {!complete && <span className="muted small-text">Answer every question to send.</span>}
        <button type="button" className="ghost small qform-toggle" aria-expanded onClick={() => setShrunk(true)} title="Shrink to one line to read the message above">
          Shrink ▾
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

/** The `composer-addon` item: the session's newest unanswered question form, in the prompt box (nothing when there is none). */
export function QuestionAddon({ sessionId, history, host }: ComposerAddonProps) {
  const pendingAsk = [...history].reverse().find((e) => e.questions && e.result === undefined) ?? null;
  if (!pendingAsk) return null;
  return (
    <div className="qform-slot">
      <SessionIdContext.Provider value={sessionId}>
        <QuestionForm key={pendingAsk.id} sessionId={sessionId} ask={pendingAsk} host={host} />
      </SessionIdContext.Provider>
    </div>
  );
}
