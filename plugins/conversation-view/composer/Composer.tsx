import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSlot, usePersistedString, type ComposerKeyHandler, type SessionFooterProps } from '../../../plugin-api/web.ts';
import './styles.css';

/** Keys for a menu Claude shows (a permission prompt, a picker…), when you're not on the live terminal. */
const KEYS: Array<[label: string, key: string]> = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
  ['↑', 'Up'],
  ['↓', 'Down'],
  ['Tab', 'Tab'],
  ['⇧Tab', 'S-Tab'],
  ['Enter', 'Enter'],
  ['Esc', 'Escape'],
];

/**
 * The Chat view's footer: the prompt box (with the `composer-addon` items drawn in or over it: question and permission
 * cards, the `/` picker), Send, Stop while Claude works, and a Keys drawer. Messages go through the core's `send`, which
 * puts them in the conversation as "sending…" and delivers them (to the live terminal if one is attached, else `POST /send`).
 */
export function Composer({ session, sessionId, history, host, working, stopping, stop, pressKey, keyBusy, send }: SessionFooterProps) {
  const addons = useSlot('composer-addon');
  // The draft is kept per session (localStorage), so it survives a reload or switching tabs.
  const [text, setText] = usePersistedString(`wh.draft.${sessionId}`);
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Key handlers composer addons register while open (e.g. the `/` picker); the first returning true wins.
  const addonKeys = useRef(new Map<string, ComposerKeyHandler>());
  // Phones get a short hint: the long one wraps and makes the box a line taller.
  const narrow = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 700px)').matches;

  // The prompt box is one line tall and grows with its text (to about 6 lines, then it scrolls).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const chrome = el.offsetHeight - el.clientHeight + parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
    el.style.height = `${Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), line * 6 + chrome)}px`;
  });

  /** Send the draft, or `override` (a composer add-on's text; the draft is left alone then). */
  const submit = async (override?: string) => {
    const msg = (override ?? text).trim();
    if (!msg || sendState === 'sending') return;
    setError(null);
    if (override === undefined) setText('');
    setSendState('sending');
    // On a phone, sending closes the on-screen keyboard; on desktop keep focus for the next message.
    if (matchMedia('(pointer: coarse)').matches) inputRef.current?.blur();
    try {
      await send(msg);
      setSendState('sent');
      setTimeout(() => setSendState((st) => (st === 'sent' ? 'idle' : st)), 2500);
    } catch (e) {
      if (override === undefined) setText((cur) => cur || msg); // it comes back on failure
      setError((e as Error).message);
      setSendState('idle');
    }
  };

  // A question form is up (the questions feature draws it above): it is the input now, so the prompt box steps aside.
  const questionUp = addons.some((a) => a.id === 'questions') && history.some((e) => e.questions && e.result === undefined);

  // Tab with nothing focused jumps to the current input: the prompt box, or the open question's first control.
  const boxRef = useRef<HTMLDivElement>(null);
  const focusCurrent = () => {
    const target = questionUp
      ? boxRef.current?.querySelector<HTMLElement>('.qform-slot .q-option, .qform-slot .q-other, .qform-slot button:not([disabled])')
      : inputRef.current;
    if (!target) return false;
    target.focus();
    // Cursor after what's already typed (the draft), not wherever the browser leaves it.
    if (target instanceof HTMLTextAreaElement) target.setSelectionRange(target.value.length, target.value.length);
    return true;
  };
  // The ⌘K palette asks (`wh:focus-input`, and a 4s window for a footer that mounts after it) for the current input after opening a workspace.
  const focusRef = useRef(focusCurrent);
  focusRef.current = focusCurrent;
  useEffect(() => {
    const wanted = () => Date.now() < ((window as unknown as { whFocusInputUntil?: number }).whFocusInputUntil ?? 0);
    // Retried through the window while nothing has focus: the history (and so the question form) can load after the footer mounts.
    const tryFocus = () => {
      const a = document.activeElement;
      if (wanted() && (!a || a === document.body)) focusRef.current();
    };
    tryFocus();
    window.addEventListener('wh:focus-input', tryFocus);
    const t = setInterval(tryFocus, 250); // the question form or textarea can appear a moment after the footer mounts
    return () => {
      window.removeEventListener('wh:focus-input', tryFocus);
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement) return;
      if (document.querySelector('[role="dialog"], .modal, .palette-backdrop')) return;
      if (!focusRef.current()) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [questionUp]);

  return (
    <>
      {error && <div className="error">{error}</div>}
      <div className="composer">
        <div ref={boxRef} className={`compose-box ${sendState}`}>
          {addons.map((a) => {
            const Addon = a.component;
            const k = `${a.plugin}:${a.id}`;
            const register = (fn: ComposerKeyHandler | null) => void (fn ? addonKeys.current.set(k, fn) : addonKeys.current.delete(k));
            return <Addon key={k} session={session} sessionId={sessionId} draft={text} setDraft={setText} send={(t) => void submit(t)} inputRef={inputRef} registerKeyHandler={register} history={history} host={host} />;
          })}
          {!questionUp && (<>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              for (const h of addonKeys.current.values()) if (h(e)) return;
              if (e.key === 'Escape' && working && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                stop();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={narrow ? 'Message Claude…' : 'Message Claude…  (Enter to send · Shift+Enter for a new line)'}
            rows={1}
          />
          {working && (
            <button
              className="stop"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => stop()}
              disabled={stopping}
              title="Stop Claude (Esc)"
              aria-label="Stop Claude"
            >
              {stopping ? <span className="spinner" /> : '■ Stop'}
            </button>
          )}
          <button
            className="primary send"
            // Don't steal focus on tap; submit() decides whether to keep it (desktop) or drop it (phone).
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void submit()}
            disabled={!text.trim() || sendState === 'sending'}
          >
            {sendState === 'sending' ? <span className="spinner" /> : 'Send'}
          </button>
          </>)}
        </div>
        <div className="compose-foot">
          <span className={`compose-status ${sendState}`}>
            {stopping ? 'Stopping Claude…' : sendState === 'sending' ? 'Sending to Claude…' : sendState === 'sent' ? 'Sent ✓' : ''}
          </span>
          <details className="keys-toggle">
            <summary>Keys</summary>
            <div className="keys">
              {KEYS.map(([label, key]) => (
                <button key={key} className={`key ${keyBusy === key ? 'busy' : ''}`} disabled={!!keyBusy} onClick={() => pressKey(key)}>
                  {keyBusy === key ? '…' : label}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
