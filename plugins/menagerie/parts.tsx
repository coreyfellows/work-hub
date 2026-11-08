import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Linkify, WorkingPulse as Pulse, type HostPart, type Working } from '../../plugin-api/web.ts';
import { AskHeader as FormAskHeader, HostAvatar } from './HostAvatar.tsx';
import { askLine, hostVars } from './menagerie.ts';
import type { Aside, FunHost } from './types.ts';

/** The bottom-most host message's quip box: shown for 10s from when it appears, then it leaves in the host's own way. */
const QuipCtx = createContext<{ show: boolean; bye: boolean }>({ show: false, bye: false });
const QUIP_MS = 10_000;

// Quips that have played out, remembered in this browser so one never comes back (reload, reopening the session).
// Keyed by the aside's or question's transcript time and index; only the latest few hundred are kept.
const EXPIRED_KEY = 'wh.quipsExpired';
function expiredQuips(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXPIRED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
function expireQuip(id: string): void {
  try {
    const list = expiredQuips().filter((x) => x !== id);
    localStorage.setItem(EXPIRED_KEY, JSON.stringify([...list, id].slice(-300)));
  } catch {
    /* private mode: it just won't be remembered */
  }
}
const BYE_MS = 2_600; // longest exit in styles.css (the Dude's) plus a margin

/**
 * The quip box's phase for the bottom-most group with a `quipId` ('' = none): shown for QUIP_MS from when it first
 * appears on screen, or until you send something (`answered`: a message of yours below it), whichever comes first;
 * then it plays its exit and is gone for good (remembered, so it never comes back).
 */
export function useQuipPhase(quipId: string, answered: boolean): 'in' | 'bye' | 'gone' {
  const answeredRef = useRef(answered);
  answeredRef.current = answered;
  const leaveRef = useRef<(() => void) | undefined>(undefined);
  const [phase, setPhase] = useState<'in' | 'bye' | 'gone'>(() =>
    quipId && (answered || expiredQuips().includes(quipId)) ? 'gone' : 'in',
  );
  useEffect(() => {
    if (!quipId) return;
    if (expiredQuips().includes(quipId)) return setPhase('gone');
    // You'd already replied before it ever showed (e.g. opening an older session): retire it without a show.
    if (answeredRef.current) {
      expireQuip(quipId);
      return setPhase('gone');
    }
    setPhase('in');
    let bye: ReturnType<typeof setTimeout> | undefined;
    const leave = () => {
      if (bye !== undefined) return;
      expireQuip(quipId);
      setPhase('bye');
      bye = setTimeout(() => setPhase('gone'), BYE_MS);
    };
    leaveRef.current = leave;
    const a = setTimeout(leave, QUIP_MS);
    return () => {
      clearTimeout(a);
      if (bye !== undefined) clearTimeout(bye);
      leaveRef.current = undefined;
    };
  }, [quipId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Sending a message while it's up clears it out with its exit.
  useEffect(() => {
    if (answered) leaveRef.current?.();
  }, [answered]);
  return phase;
}

export function QuipScope({ show, bye, children }: { show: boolean; bye: boolean; children: ReactNode }) {
  return <QuipCtx.Provider value={{ show, bye }}>{children}</QuipCtx.Provider>;
}

/** Wraps a host's whole quip box (portrait included): nothing once it's gone, an exit animation while leaving. */
function Quip({ host, children }: { host: FunHost; children: ReactNode }) {
  const { show, bye } = useContext(QuipCtx);
  if (!show) return null;
  return (
    <div className={`quip${bye ? ` quip-bye quip-bye-${host.id}` : ''}`}>
      <div className="quip-inner">{children}</div>
    </div>
  );
}

/** Classes and palette that style a part of the page after the host. */
export function frame(host: FunHost, part: HostPart): { className: string; style: CSSProperties } {
  const className =
    part === 'group' ? `fun-group fun-${host.id}` : part === 'qform-sent' ? 'fun-qform' : `fun-${part} fun-${host.id} fun-${host.mode}`;
  return { className, style: hostVars(host) };
}

/** A host's aside, styled after their banner in the terminal: trim, gradient name, their colors and motion. */
export function AsideCard({ aside }: { aside: Aside }) {
  const { host, text } = aside;
  // Two identical halves, so scrolling by half loops seamlessly.
  const half = host.trim ? host.trim.repeat(Math.ceil(120 / host.trim.length)) : '';
  const trim = half + half;
  return (
    <Quip host={host}>
      <div className={`fun-aside fun-${host.id} fun-${host.mode}`} style={hostVars(host)}>
        {trim && (
          <div className="fun-trim" aria-hidden>
            <span>{trim}</span>
          </div>
        )}
        <div className="fun-body">
          <HostAvatar host={host} size={44} mood="pleased" react="delight" />
          <div className="fun-words">
            <div className="fun-text">
              <Linkify text={text} />
            </div>
          </div>
        </div>
      </div>
    </Quip>
  );
}

/** The working bubble as the host: portrait, dots in their letters, their spinner words and trim. */
export function WorkingPulse({ working, host }: { working: Working; host: FunHost }) {
  return (
    <Pulse
      working={working}
      decor={{
        className: `fun-pulse fun-${host.id}`,
        style: hostVars(host),
        lead: <HostAvatar host={host} size={26} mood="thinking" react="nod" />,
        dotColors: host.letters,
        words: host.spinner,
        trim: host.trim,
      }}
    />
  );
}

/** Above a question: in the form, portrait + name + line; in the log, a quip box with the portrait and line. */
export function AskHeader({ host, line, inLog }: { host: FunHost; line?: string; inLog?: boolean }) {
  if (!inLog) return <FormAskHeader host={host} line={line} />;
  return (
    <Quip host={host}>
      <div className="fun-ask-head">
        <HostAvatar host={host} size={30} mood="curious" react="alarm" />
        <div className="fun-words">{line && <div className="fun-ask-line">{line}</div>}</div>
      </div>
    </Quip>
  );
}

/**
 * The real working bubble, aside card and question, as they look in the Chat view, with sample content (for the
 * faces test page). Quip boxes are forced on and never expire here; remount (change `key`) to replay reactions.
 * The question is drawn like the core's logged question (`.ask-msg`).
 */
export function HostInContext({ host }: { host: FunHost }) {
  const q = { question: 'Ship it now or after lunch?', options: ['Now', 'After lunch'] };
  const ask = frame(host, 'ask');
  const groups: [string, string, ReactNode, string][] = [
    ['working', 'Working bubble', <WorkingPulse working={{ quip: '', level: 0.35 }} host={host} />, 'working'],
    [
      'ask',
      'Question',
      <div className={`ask-msg ${ask.className}`} style={ask.style}>
        <AskHeader host={host} line={askLine(host, `preview-${host.id}`)} inLog />
        <div className="ask-msg-q">
          <div>
            <Linkify text={q.question} />
          </div>
          <div className="ask-msg-options">
            <Linkify text={q.options.join(' · ')} />
          </div>
        </div>
      </div>,
      '',
    ],
    ['aside', 'Aside', <AsideCard aside={{ host, text: 'Sample aside: that went better than anyone expected.' }} />, 'h-md'],
  ];
  return (
    <QuipCtx.Provider value={{ show: true, bye: false }}>
      <div className="history readable">
        {groups.map(([key, label, node, cls]) => (
          <div key={key} className={`msg-group claude fun-group fun-${host.id}`} style={hostVars(host)}>
            <div className="r-who">
              {label}
              <span className="fun-who"> with {host.name}</span>
            </div>
            <div className="bubble">
              <div className="bubble-part">{cls ? <div className={cls}>{node}</div> : node}</div>
            </div>
          </div>
        ))}
      </div>
    </QuipCtx.Provider>
  );
}

