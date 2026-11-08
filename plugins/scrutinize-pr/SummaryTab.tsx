import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmPopover, Markdown, ago, get, isMod, keyLabel, post, useLowData, useToast } from '../../plugin-api/web.ts';
import { findSection, splitSections, type Section } from './doc.ts';
import type { Since, SummaryView, Thread } from './types.ts';

/**
 * The PR page's Summary tab: the summary (or a button to write one), its age and how much the PR changed since, and
 * question threads. Select text in the summary and "Ask about this" opens a thread under that section; Claude answers
 * there, or adds to or rewrites the section. Loaded when the tab opens and when the PR's head moves; polled only while
 * something is being written (3s, 10s in Low data).
 */

const short = (oid: string | null) => (oid ? oid.slice(0, 7) : '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface Pick {
  sectionId: string;
  quote: string;
  /** Where to float the button, relative to the document box. */
  top: number;
  left: number;
}

export function SummaryTab({ owner, repo, number, pr }: { owner: string; repo: string; number: number; pr: unknown }) {
  const api = `/api/plugins/scrutinize-pr/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;
  const head = (pr as { headOid?: string } | undefined)?.headOid ?? '';
  const lowData = useLowData();
  const { show: toast } = useToast();
  const [view, setView] = useState<SummaryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kicked, setKicked] = useState(0); // when we last started something the server may not show yet
  const [composer, setComposer] = useState<{ sectionId: string; quote: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await get<SummaryView>(`${api}?head=${head}`));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [api, head]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = !!view && (view.generating || view.updating || view.threads.some((t) => t.pending));
  const watching = busy || Date.now() - kicked < 15_000;
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), lowData ? 10_000 : 3_000);
    return () => clearInterval(t);
  }, [watching, load, lowData]);

  const generate = async () => {
    try {
      await post(`${api}/generate`, {});
      setKicked(Date.now());
      toast({ text: 'Writing the summary in the background (jobs tray, top right). It carries on if you leave this page.' });
      await load();
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
    }
  };

  const update = async () => {
    try {
      await post(`${api}/update`, {});
      setKicked(Date.now());
      toast({ text: 'Folding the new commits into the summary in the background (jobs tray, top right).' });
      await load();
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
    }
  };

  const ask = async (body: { threadId?: string; sectionId?: string; quote?: string; question: string }) => {
    await post(`${api}/ask`, body);
    setKicked(Date.now());
    await load();
  };

  const removeThread = async (threadId: string) => {
    try {
      await post(`${api}/threads/remove`, { threadId });
      await load();
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
    }
  };

  if (!view) {
    return <div className="scr-tab">{loadError ? <p className="bad">{loadError}</p> : <p className="muted">Loading…</p>}</div>;
  }

  const generating = view.generating || (!view.exists && Date.now() - kicked < 15_000 && !view.error);
  if (!view.exists) {
    return (
      <div className="scr-tab">
        <div className="block scr-empty">
          <p>
            No summary yet. Claude reads the PR, and the code around it in your local clone when there is one, and writes a guide to it: the story of
            the change in the order that makes sense, with snippets and links to the files, and the minutiae at the end.
          </p>
          <p className="muted small-text">
            It takes a few minutes and spends tokens. Once it's written, select any passage to ask about it.
          </p>
          {generating ? (
            <p className="scr-working">Writing the summary…</p>
          ) : (
            <div>
              <button className="primary" onClick={() => void generate()}>
                Summarize this PR
              </button>
            </div>
          )}
          {view.error && !generating && <p className="bad small-text">Last attempt failed: {view.error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="scr-tab">
      <SummaryBar view={view} head={head} generating={generating} onRegenerate={() => void generate()} onUpdate={() => void update()} onReload={() => void load()} />
      <SummaryDoc
        markdown={view.markdown ?? ''}
        threads={view.threads}
        composer={composer}
        setComposer={setComposer}
        ask={ask}
        removeThread={removeThread}
      />
    </div>
  );
}

function sinceText(s: Since): string {
  if (s.files === 0) return 'The PR has new commits, but its diff is the same.';
  const parts = [plural(s.files, 'file')];
  if (s.newFiles.length) parts.push(`${s.newFiles.length} new`);
  if (s.goneFiles.length) parts.push(`${s.goneFiles.length} no longer in the PR`);
  return `Changed since: ${parts.join(', ')}; +${s.linesAdded} −${s.linesRemoved} diff lines.`;
}

function sinceTitle(s: Since): string {
  return [
    ...s.newFiles.map((p) => `new: ${p}`),
    ...s.changedFiles.map((p) => `changed: ${p}`),
    ...s.goneFiles.map((p) => `gone: ${p}`),
    `The PR now: ${plural(s.now.files, 'file')}, +${s.now.additions} −${s.now.deletions}`,
  ].join('\n');
}

function SummaryBar({
  view,
  head,
  generating,
  onRegenerate,
  onUpdate,
  onReload,
}: {
  view: SummaryView;
  head: string;
  generating: boolean;
  onRegenerate(): void;
  onUpdate(): void;
  onReload(): void;
}) {
  const stale = view.since && view.since.files > 0;
  const busy = generating || view.updating;
  return (
    <div className={`block scr-bar${stale ? ' stale' : ''}`}>
      <div className="scr-bar-row">
        <span title={view.generatedAt ?? ''}>Written {view.generatedAt ? `${ago(view.generatedAt)} ago` : ''}</span>
        {view.updatedAt && (
          <span className="muted" title={view.updatedAt}>
            updated {ago(view.updatedAt)} ago
          </span>
        )}
        {view.headOid && (
          <span className="muted">
            at <code>{short(view.headOid)}</code>
          </span>
        )}
        {view.model && <span className="muted">{view.model}</span>}
        {view.mode === 'inline' && (
          <span className="muted" title="There was no local clone of this repo (or the PR's commits couldn't be fetched into it), so Claude only had the diff.">
            from the diff alone
          </span>
        )}
        {view.stats && (
          <span className="muted">
            {plural(view.stats.files, 'file')}, <span className="ok">+{view.stats.additions}</span> <span className="bad">−{view.stats.deletions}</span>
          </span>
        )}
        <span className="grow" />
        {view.updating ? (
          <span className="scr-working">Updating…</span>
        ) : generating ? (
          <span className="scr-working">Rewriting…</span>
        ) : (
          <>
            {view.since && (
              <button
                className={stale ? 'small primary' : 'small'}
                onClick={onUpdate}
                title={
                  stale
                    ? 'Read only what the new commits changed and revise just the sections they affect; the rest stays as it is'
                    : "The PR's diff is the same: move the summary to the new head without asking Claude"
                }
              >
                Update
              </button>
            )}
            <ConfirmPopover
            className="small"
            message="Write the summary again from the PR as it is now? The current version, addenda included, is kept in history/ beside it; question threads stay."
            confirmLabel="Rewrite"
            onConfirm={onRegenerate}
          >
            Regenerate
          </ConfirmPopover>
          </>
        )}
      </div>
      <div className="scr-bar-row small-text">
        {view.since ? (
          <span className={stale ? 'warn' : 'muted'} title={sinceTitle(view.since)}>
            {sinceText(view.since)}
          </span>
        ) : view.sinceError ? (
          <span className="muted">
            Couldn't check what changed since: {view.sinceError}{' '}
            <button className="linkish small-text" onClick={onReload}>
              retry
            </button>
          </span>
        ) : head && head === view.headOid ? (
          <span className="muted">Up to date with the PR.</span>
        ) : null}
        <span className="grow" />
        <span className="muted scr-path" title={view.path}>
          {view.path.replace(/^\/Users\/[^/]+/, '~')}
        </span>
      </div>
      {view.error && !busy && <div className="bad small-text">The last rewrite or update failed: {view.error}</div>}
    </div>
  );
}

function SummaryDoc({
  markdown,
  threads,
  composer,
  setComposer,
  ask,
  removeThread,
}: {
  markdown: string;
  threads: Thread[];
  composer: { sectionId: string; quote: string } | null;
  setComposer(c: { sectionId: string; quote: string } | null): void;
  ask(body: { threadId?: string; sectionId?: string; quote?: string; question: string }): Promise<void>;
  removeThread(id: string): Promise<void>;
}) {
  const sections = useMemo(() => splitSections(markdown), [markdown]);
  const box = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<Pick | null>(null);

  // A selection inside the summary's text (not a thread or a box) offers "Ask about this".
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const sel = window.getSelection();
      const root = box.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return setPick(null);
      const range = sel.getRangeAt(0);
      const el = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
      const startMd = el(range.startContainer)?.closest('.scr-md');
      const sec = startMd?.closest<HTMLElement>('[data-sid]');
      if (!startMd || !sec || !root.contains(sec)) return setPick(null);
      const quote = sel.toString().trim();
      if (!quote) return setPick(null);
      const r = range.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      setPick({
        sectionId: sec.dataset.sid ?? '',
        quote,
        top: r.bottom - b.top + 6,
        left: Math.max(0, Math.min(r.left - b.left, b.width - 150)),
      });
    };
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, 120);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const startAsk = (sectionId: string, quote: string) => {
    setComposer({ sectionId, quote });
    setPick(null);
    window.getSelection()?.removeAllRanges();
  };

  const placed = new Set<string>();
  const threadsFor = (s: Section) =>
    threads.filter((t) => {
      if (placed.has(t.id) || findSection(sections, t)?.id !== s.id) return false;
      placed.add(t.id);
      return true;
    });

  const body = sections.map((s) => {
    const mine = threadsFor(s);
    return (
      <section key={s.id} className="scr-sec" data-sid={s.id}>
        <div className="scr-md md">
          <Markdown components={{ a: ExternalLink }}>{s.text}</Markdown>
        </div>
        {mine.map((t) => (
          <ThreadView key={t.id} t={t} ask={ask} remove={removeThread} />
        ))}
        {composer?.sectionId === s.id ? (
          <Composer
            quote={composer.quote}
            placeholder="What would you like to know about this?"
            onCancel={() => setComposer(null)}
            onSend={async (question) => {
              await ask({ sectionId: s.id, quote: composer.quote, question });
              setComposer(null);
            }}
          />
        ) : (
          <button className="linkish small-text scr-ask-sec" onClick={() => startAsk(s.id, '')}>
            Ask about this section
          </button>
        )}
      </section>
    );
  });
  const orphans = threads.filter((t) => !placed.has(t.id));

  return (
    <div className="block scr-doc" ref={box}>
      {body}
      {orphans.length > 0 && (
        <section className="scr-sec">
          <h3>Questions about an earlier version</h3>
          {orphans.map((t) => (
            <ThreadView key={t.id} t={t} ask={ask} remove={removeThread} />
          ))}
        </section>
      )}
      {pick && (
        <button
          className="primary small scr-pick"
          style={{ top: pick.top, left: pick.left }}
          // Keep the selection while pressing (it's read again on click on touch devices).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => startAsk(pick.sectionId, pick.quote)}
        >
          Ask about this
        </button>
      )}
    </div>
  );
}

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const external = !!href && /^https?:/.test(href);
  return (
    <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
      {children}
    </a>
  );
}

const KIND_NOTE: Record<string, string> = { addendum: 'Added to the section above', rewrite: 'Rewrote the section above' };

function ThreadView({ t, ask, remove }: { t: Thread; ask(body: { threadId: string; question: string }): Promise<void>; remove(id: string): Promise<void> }) {
  const [open, setOpen] = useState(true);
  const first = t.messages[0]?.text ?? '';
  return (
    <div className={`scr-thread${open ? '' : ' closed'}`}>
      <div className="scr-thread-head">
        <button className="linkish small-text scr-thread-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'} {open ? 'Question' : first.length > 80 ? `${first.slice(0, 77)}…` : first}
        </button>
        {!open && t.pending && <span className="muted small-text">thinking…</span>}
        <span className="grow" />
        <ConfirmPopover className="small ghost" message="Remove this question and its answers? Changes it made to the summary stay." confirmLabel="Remove" onConfirm={() => remove(t.id)} ariaLabel="Remove thread">
          ✕
        </ConfirmPopover>
      </div>
      {open && (
        <>
          {t.quote && <blockquote className="scr-quote">{t.quote}</blockquote>}
          {t.messages.map((m, i) => (
            <div key={i} className={`scr-msg ${m.role}`}>
              <div className="scr-msg-head small-text">
                <b>{m.role === 'you' ? 'You' : 'Claude'}</b> <span className="muted">{ago(m.at)} ago</span>
                {m.kind && KIND_NOTE[m.kind] && <span className="scr-kind">{KIND_NOTE[m.kind]}</span>}
              </div>
              {m.role === 'claude' ? (
                <div className="md">
                  <Markdown components={{ a: ExternalLink }}>{m.text}</Markdown>
                </div>
              ) : (
                <div className="scr-you">{m.text}</div>
              )}
            </div>
          ))}
          {t.pending && <p className="scr-working small-text">Claude is looking into it…</p>}
          {t.error && <p className="bad small-text">That failed: {t.error}. Ask again below.</p>}
          {!t.pending && <Composer compact placeholder="Ask a follow-up…" onSend={(question) => ask({ threadId: t.id, question })} />}
        </>
      )}
    </div>
  );
}

function Composer({ quote, placeholder, compact, onSend, onCancel }: { quote?: string; placeholder: string; compact?: boolean; onSend(q: string): Promise<void>; onCancel?(): void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim());
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`scr-composer${compact ? ' compact' : ''}`}>
      {quote && <blockquote className="scr-quote">{quote}</blockquote>}
      <textarea
        rows={compact ? 1 : 3}
        value={text}
        autoFocus={!compact}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && isMod(e)) {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      <div className="scr-composer-actions">
        <button className="primary small" disabled={!text.trim() || sending} onClick={() => void send()} title={keyLabel('Mod+Enter')}>
          {sending ? 'Asking…' : 'Ask'}
        </button>
        {onCancel && (
          <button className="small ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        {error && <span className="bad small-text">{error}</span>}
      </div>
    </div>
  );
}
