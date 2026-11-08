import { Fragment, useMemo, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import {
  Linkify,
  LogViewContext,
  Markdown,
  WorkingPulse,
  logTime as time,
  useHostProvider,
  useProviderHosts,
  useSlot,
  useToast,
  type HistoryEntry,
  type HostProviderItem,
  type HostRef,
  type LogCardContext,
  type LogCardItem,
  type PendingMessage,
  type ResidentHost,
  type Working,
} from '../../plugin-api/web.ts';
import { planChat } from './chatPlan.ts';
import { markdownToPlain } from './plainText.ts';

/**
 * The conversation behind the terminal, styled like Claude's own TUI so scrolling up from the live
 * screen reads as one session: `>` for your messages, ⏺ for Claude's replies (Markdown rendered) and
 * tool calls, ⎿ for tool output. react-markdown never renders raw HTML, so transcript text is safe.
 * Cards (file changes, git, `!` commands…) come from the `log-card` slot; Markdown overrides from `markdown-override`.
 */
export function History({
  sessionId,
  entries,
  pending = [],
  readable = false,
  working,
  resident,
  onSendNow,
  onStop,
  hidePendingQuestion = false,
}: {
  sessionId: string;
  entries: HistoryEntry[];
  /** The question Claude is waiting on is answered in the form below the log, so don't also draw it in the log (it appears once answered). */
  hidePendingQuestion?: boolean;
  /** The menagerie host the transcript names (see lastHost). */
  resident?: ResidentHost | null;
  pending?: PendingMessage[];
  /** Human-readable mode: hide tool calls (folded into "⋯ N steps"), show questions as Q&A cards. */
  readable?: boolean;
  /** Claude is still processing: a pending bubble with a quip animating at `level` (0–1, how fast its terminal is changing). */
  working?: Working;
  /** Messages you've queued while Claude works get a "Send now" button that runs this. */
  onSendNow?: () => void;
  /** While Claude works, its working bubble gets a "Stop" button that runs this (Esc, Claude's interrupt). */
  onStop?: () => void;
}) {
  const hp = useHostProvider();
  const fun = useProviderHosts(hp);
  const host = hp?.lastHost(entries, fun, resident);
  const cards = useSlot('log-card');
  const view = useMemo(() => ({ sessionId, readable }), [sessionId, readable]);
  const pendingAskI = hidePendingQuestion ? entries.findLast((e) => e.questions && e.result === undefined)?.i : undefined;
  if (readable)
    return (
      <LogViewContext.Provider value={view}>
        <ReadableHistory sessionId={sessionId} cards={cards} entries={entries} pendingAskI={pendingAskI} pending={pending} working={working} fun={fun} host={host} onSendNow={onSendNow} onStop={onStop} />
      </LogViewContext.Provider>
    );
  const pulse = working && <Pulse working={working} host={host} hp={hp} />;
  const cardsFor = (e: HistoryEntry, index: number) => {
    const ctx: LogCardContext = { sessionId, readable: false, index };
    return cards.filter((it) => it.match(e)).map((it) => <Fragment key={`${it.plugin}:${it.id}`}>{it.render(e, ctx)}</Fragment>);
  };
  return (
    <LogViewContext.Provider value={view}>
    <div className="history">
      {entries.map((e, index) => {
        if (e.questions && e.i === pendingAskI) return null;
        const own = cardsFor(e, index);
        // A card for anything but a tool call draws that entry's whole row.
        if (e.kind !== 'tool' && own.length) return <Fragment key={e.i}>{own}</Fragment>;
        if (e.kind === 'notice') return <Notice key={e.i} e={e} />;
        return e.kind === 'user' ? (
          <div key={e.i} className="h-user">
            <span className="h-prompt">&gt;</span>
            <div className="h-text"><Linkify text={e.text ?? ''} /></div>
            {e.at && <span className="h-time">{time(e.at)}</span>}
          </div>
        ) : e.kind === 'assistant' ? (
          <div key={e.i} className="h-assistant">
            <span className="h-dot">⏺</span>
            <div className="h-md">
              <AssistantText text={e.text ?? ''} fun={fun} />
            </div>
          </div>
        ) : e.questions ? (
          <div key={e.i} className="h-assistant">
            <span className="h-dot">⏺</span>
            <div className="h-md">
              <QuestionMessage e={e} host={host} />
              {answerText(e) && <div className="h-answer">↳ <Linkify text={answerText(e)} /></div>}
            </div>
          </div>
        ) : (
          <details key={e.i} className={`h-tool ${e.isError ? 'err' : ''} ${e.result === undefined ? 'running' : ''}`}>
            <summary>
              <span className="h-dot">⏺</span>
              <span className="h-tool-name">{e.tool}</span>
              <span className="h-summary">({e.summary})</span>
            </summary>
            {own}
            <div className="h-result">
              <span className="h-elbow">⎿</span>
              <pre>{e.result === undefined ? 'running…' : e.result || '(no output)'}</pre>
            </div>
          </details>
        );
      })}
      {pending.map((p) => (
        <div key={p.key} className={`h-user pending ${p.state}`}>
          <span className="h-prompt">&gt;</span>
          <div className="h-text">{p.text}</div>
          <span className="h-time">{p.state === 'sending' ? 'sending…' : 'sent ✓'}</span>
        </div>
      ))}
      {working && (
        <div className="h-assistant">
          <span className="h-dot">⏺</span>
          <div className="h-md">{pulse}</div>
        </div>
      )}
    </div>
    </LogViewContext.Provider>
  );
}

const NOTICE_LABEL: Record<NonNullable<HistoryEntry['notice']>, string> = { 'away-summary': 'Recap' };

/** A notice in the conversation (an away summary): a muted line between the messages, not a bubble. */
function Notice({ e }: { e: HistoryEntry }) {
  return (
    <div className="h-notice">
      <span className="h-notice-label">{e.notice ? NOTICE_LABEL[e.notice] : 'Note'}</span>
      <span>{e.text}</span>
      {e.at && <span className="h-time">{time(e.at)}</span>}
    </div>
  );
}

/** Every `log-card` item's Wrap around `children` (the first item outermost). */
export function LogWraps({ sessionId, entries, children }: { sessionId: string; entries: HistoryEntry[]; children: ReactNode }) {
  const cards = useSlot('log-card');
  return cards.reduceRight<ReactNode>((inner, it) => (it.Wrap ? <it.Wrap sessionId={sessionId} entries={entries}>{inner}</it.Wrap> : inner), children);
}

/** The working bubble: the host provider's when there is a host, else the plain pulse. */
function Pulse({ working, host, hp }: { working: Working; host?: HostRef; hp?: HostProviderItem }) {
  return host && hp ? <hp.WorkingPulse working={working} host={host} /> : <WorkingPulse working={working} />;
}

/**
 * An assistant message as Markdown, with a menagerie host's closing aside drawn as that host (`fun`: the hosts, null
 * when off). `markdown-override` items (file links, `!` command cards…) go on top of MD_COMPONENTS.
 */
function AssistantText({ text, fun }: { text: string; fun: HostRef[] | null }) {
  const hp = useHostProvider();
  const split = fun && hp ? hp.splitAside(text, fun) : null;
  return (
    <>
      {(!split || split.body) && <Markdown components={MD_COMPONENTS}>{split ? split.body : text}</Markdown>}
      {split && hp && <hp.AsideCard aside={split.aside} />}
    </>
  );
}

/** The conversation's own Markdown defaults: links open in a new tab. */
const MD_COMPONENTS: Components = {
  a({ node: _node, children, ...rest }) {
    return (
      <a {...rest} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

/**
 * Answers from an AskUserQuestion result, which reads `…: "Question?"="Answer", "Next?"="A, B". You can…`.
 * Questions and answers can contain quotes themselves (unescaped), so find each known question and read
 * its answer up to the next question or the closing sentence, rather than splitting on quotes.
 */
export function parseAnswers(result: string | undefined, questions: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!result) return out;
  for (let qi = 0; qi < questions.length; qi++) {
    const marker = `"${questions[qi]}"="`;
    const at = result.indexOf(marker);
    if (at < 0) continue;
    const start = at + marker.length;
    let end = -1;
    const next = questions.slice(qi + 1).find((q) => result.indexOf(`", "${q}"="`, start) >= 0);
    if (next) end = result.indexOf(`", "${next}"="`, start);
    if (end < 0) {
      const close = /"\. (You can now|Read the answers)/.exec(result.slice(start));
      end = close ? start + close.index : result.lastIndexOf('"');
    }
    if (end > start) out.set(questions[qi], result.slice(start, end));
  }
  return out;
}

/** Claude's question(s) as the text of a message from Claude; framed as the menagerie host when there is one. */
function QuestionMessage({ e, host }: { e: HistoryEntry; host?: HostRef }) {
  const hp = useHostProvider();
  const framed = host && hp ? hp.frame(host, 'ask') : null;
  return (
    <div className={`ask-msg${framed ? ` ${framed.className}` : ''}`} style={framed?.style}>
      {host && hp && <hp.AskHeader host={host} line={hp.askLine(host, e.id ?? String(e.i))} inLog />}
      {(e.questions ?? []).map((q, qi) => (
        <div key={qi} className="ask-msg-q">
          <div><Linkify text={q.question} /></div>
          <div className="ask-msg-options"><Linkify text={q.options.map((o) => o.label).join(' · ')} /></div>
        </div>
      ))}
    </div>
  );
}

/** What you answered, as the text of your message ("" while unanswered). */
function answerText(e: HistoryEntry): string {
  if (e.result === undefined) return '';
  const qs = e.questions ?? [];
  const answers = parseAnswers(e.result, qs.map((q) => q.question));
  if (answers.size === 0) return e.result;
  return qs
    .map((q) => {
      const a = answers.get(q.question);
      if (a === undefined) return '';
      return qs.length > 1 ? `${q.header || q.question}: ${a}` : a;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * The conversation as people would read it, like a text thread: Claude's messages (tool work folded into
 * "⋯ N steps"; questions are Claude messages and your answers are yours) share one bubble on the left until you reply; your messages
 * share one on the right. Tool work is hidden.
 */
function ReadableHistory({
  sessionId,
  cards,
  entries,
  pendingAskI,
  pending,
  working,
  fun,
  host,
  onSendNow,
  onStop,
}: {
  sessionId: string;
  /** The `log-card` items. */
  cards: LogCardItem[];
  entries: HistoryEntry[];
  /** Entry index of a pending question that's shown as a form elsewhere (skipped here). */
  pendingAskI?: number;
  pending: PendingMessage[];
  working?: Working;
  onSendNow?: () => void;
  onStop?: () => void;
  /** The session's menagerie host, framing questions and the working bubble. */
  host?: HostRef;
  /** The menagerie's hosts, or null when their styling is off (or there's no host provider). */
  fun: HostRef[] | null;
}) {
  const hp = useHostProvider();
  interface Group {
    key: string;
    side: 'claude' | 'user' | 'raw';
    label: string;
    /** `raw` groups draw this as is (a card's own pending bubble). */
    raw?: ReactNode;
    /** When the group's latest entry happened. */
    at?: string | null;
    /** The menagerie host who chimed in on this group, if any. */
    host?: HostRef;
    /** The latest aside or question in this group with a quip box: its transcript time and index, stable for good. */
    quipId?: string;
    /** What the bubble is styled after: its own host, else the nearest earlier Claude bubble's, else the session's. */
    styleHost?: HostRef;
    parts: Array<{ key: string; node: ReactNode; quipOnly?: boolean }>;
    /** The Markdown source of each text part, for the Copy menu (cards, steps and questions have none). */
    copy: string[];
  }
  const groups: Group[] = [];
  const add = (side: Group['side'], label: string, key: string, node: ReactNode, cls = '', at?: string | null, quipOnly = false) => {
    let g = groups[groups.length - 1];
    if (!g || g.side !== side) {
      g = { key: `g-${key}`, side, label, parts: [], copy: [] };
      groups.push(g);
    }
    if (at) g.at = at;
    g.parts.push({ key, node: cls ? <div className={cls}>{node}</div> : node, quipOnly });
  };
  /** Offer `text` (Markdown) in the last group's Copy menu. */
  const addCopy = (text: string) => {
    if (text.trim()) groups[groups.length - 1]!.copy.push(text);
  };
  // Cards from the `log-card` slot, with runs (file changes, git ops…) collapsed; other tool work folds into "⋯ N steps".
  for (const step of planChat(entries, cards, pendingAskI)) {
    if (step.kind === 'steps') {
      add('claude', 'Claude', `steps-${step.first}`, <>⋯ {step.count} {step.count === 1 ? 'step' : 'steps'}</>, 'h-steps');
      continue;
    }
    if (step.kind === 'card') {
      const { item, entries: es, index } = step;
      const head = es[0]!;
      const ctx: LogCardContext = { sessionId, readable: true, index };
      const node = step.run && item.run ? item.run.render(es, ctx) : item.render(head, ctx);
      const mine = head.kind === 'user';
      add(mine ? 'user' : 'claude', mine ? `${item.label ?? 'You'}${head.at ? ` · ${time(head.at)}` : ''}` : 'Claude', `${item.plugin}:${item.id}-${head.i}`, node, '', head.at);
      continue;
    }
    const e = step.entry;
    if (e.kind === 'tool') {
      add('claude', 'Claude', `q-${e.i}`, <QuestionMessage e={e} host={host} />, '', e.at);
      if (host) Object.assign(groups[groups.length - 1]!, { host, quipId: `${e.at ?? ''}|${e.i}` });
      const ans = answerText(e);
      if (ans) {
        add('user', 'You', `qa-${e.i}`, <Linkify text={ans} />, 'h-text');
        addCopy(ans);
      }
    }
    else if (e.kind === 'notice') {
      groups.push({ key: `g-n-${e.i}`, side: 'raw', label: '', parts: [], copy: [], raw: <Notice e={e} /> });
    }
    else if (e.kind === 'user') {
      // A message queued while Claude worked sits where Claude took it in (the transcript line is written then), so
      // what follows is Claude acting on it; holding it back would drop it below the reply that answered it.
      add('user', `You${e.at ? ` · ${time(e.at)}` : ''}`, `u-${e.i}`, <Linkify text={e.text ?? ''} />, 'h-text');
      addCopy(e.text ?? '');
    }
    else {
      const split = fun && hp ? hp.splitAside(e.text ?? '', fun) : null;
      add('claude', 'Claude', `a-${e.i}`, <AssistantText text={e.text ?? ''} fun={fun} />, 'h-md', e.at, !!split && !split.body);
      addCopy(split ? split.body : (e.text ?? ''));
      if (split) Object.assign(groups[groups.length - 1]!, { host: split.aside.host, quipId: `${e.at ?? ''}|${e.i}` });
    }
  }
  const pendingBubble = (p: PendingMessage) => {
    const queued = working && p.queued && p.state === 'sent';
    add(
      'user',
      `You · ${p.state === 'sending' ? 'sending…' : queued ? 'queued' : 'sent ✓'}`,
      p.key,
      <>
        {p.text}
        {queued && onSendNow && (
          <button className="send-now" onClick={onSendNow} title="Interrupt what Claude is doing and deliver your queued messages now">
            Send now
          </button>
        )}
      </>,
      `h-text pending ${p.state}`,
    );
    addCopy(p.text);
  };
  // Messages sent to an idle Claude start its next turn: they go above the working bubble, like a sent message.
  const fresh = pending.filter((p) => !p.queued);
  fresh.forEach(pendingBubble);
  const addPending = (stage: 'started' | 'waiting') =>
    cards.forEach((it) => {
      if (it.Pending) groups.push({ key: `g-pending-${stage}-${it.plugin}:${it.id}`, side: 'raw', label: '', parts: [], copy: [], raw: <it.Pending sessionId={sessionId} stage={stage} /> });
    });
  addPending('started');
  // The in-progress bubble continues Claude's current response (above anything you've since queued).
  if (working) {
    add('claude', 'Claude', 'working', <>
        <Pulse working={working} host={host} hp={hp} />
        {onStop && (
          <button className="send-now stop-now" onClick={onStop} title="Stop Claude (Esc)">
            ■ Stop
          </button>
        )}
      </>, 'working');
    if (host) groups[groups.length - 1]!.host = host;
  }
  pending.filter((p) => p.queued).forEach(pendingBubble);
  addPending('waiting');
  // Every Claude bubble is styled: the nearest earlier one's host when it has none of its own (so a lone "1 step" or
  // the working bubble never shows up bare), else the session's host.
  let styleFrom: HostRef | undefined = host;
  for (const g of groups) {
    if (g.side !== 'claude') continue;
    if (g.host) styleFrom = g.host;
    g.styleHost = g.host ?? styleFrom;
  }
  // The quip box (portrait and all) only belongs to the bottom-most message a host chimed in on, and only for
  // QUIP_MS from when it first appears on screen, or until you send something (a message of yours below it),
  // whichever comes first; then it plays its exit and is gone for good (remembered, so it never comes back).
  const quipIndex = groups.findLastIndex((g) => g.quipId);
  const quipGroup = quipIndex >= 0 ? groups[quipIndex] : undefined;
  const quipKey = quipGroup?.key;
  const quipId = quipGroup?.quipId ?? '';
  const answered = quipIndex >= 0 && groups.slice(quipIndex + 1).some((g) => g.side === 'user');
  const phase = hp ? hp.useQuipPhase(quipId, answered) : 'gone';
  const quipShown = (g: Group) => g.key === quipKey && phase !== 'gone';
  // A message that was only a quip leaves nothing behind once the quip is gone.
  const visible = groups.filter((g) => g.raw || quipShown(g) || !g.parts.every((p) => p.quipOnly));
  return (
    <div className="history readable">
      {visible.map((g) => {
        if (g.raw) return <Fragment key={g.key}>{g.raw}</Fragment>;
        const tint = g.styleHost && hp ? hp.frame(g.styleHost, 'group') : null;
        const group = (
        <div
          className={`msg-group ${g.side}${tint ? ` ${tint.className}` : ''}`}
          style={tint?.style}
        >
          {g.label && (
            <div className="r-who">
              {g.label}
              {g.host && (
                <span className="fun-who">
                  {' '}
                  with {g.host.name}
                </span>
              )}
            </div>
          )}
          <div className="bubble">
            {g.parts.map((p) => (
              <div key={p.key} className="bubble-part">
                {p.node}
              </div>
            ))}
          </div>
          {(g.copy.length > 0 || (g.side === 'claude' && g.at)) && (
            <div className="bubble-foot">
              {g.copy.length > 0 && <CopyMenu texts={g.copy} />}
              {g.side === 'claude' && g.at && <div className="bubble-time">{time(g.at)}</div>}
            </div>
          )}
        </div>
        );
        return hp ? (
          <hp.QuipScope key={g.key} show={quipShown(g)} bye={phase === 'bye'}>
            {group}
          </hp.QuipScope>
        ) : (
          <Fragment key={g.key}>{group}</Fragment>
        );
      })}
    </div>
  );
}

/** Two buttons that copy a bubble's text: as the Markdown Claude wrote it (MD) or as plain text (Text). Several text parts are joined by a blank line. */
function CopyMenu({ texts }: { texts: string[] }) {
  const { show } = useToast();
  const copy = async (plain: boolean) => {
    const md = texts.join('\n\n');
    try {
      await navigator.clipboard.writeText(plain ? markdownToPlain(md) : md);
      show({ text: plain ? 'Copied as plain text.' : 'Copied as Markdown.' });
    } catch {
      show({ text: "Couldn't copy: the browser blocked clipboard access.", kind: 'error' });
    }
  };
  return (
    <span className="bubble-copy-btns">
      <button className="ghost bubble-copy" aria-label="Copy message as Markdown" title="Copy as Markdown" onClick={() => void copy(false)}>
        MD
      </button>
      <button className="ghost bubble-copy" aria-label="Copy message as plain text" title="Copy as plain text" onClick={() => void copy(true)}>
        Text
      </button>
    </span>
  );
}
