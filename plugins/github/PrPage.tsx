import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AsOf, ConfirmPopover, DiffTable, Link, ago, get, keyLabel, lineKey, navigate, parsePatch, post, useLowData, useSlot, type DiffLine, type Session } from '../../plugin-api/web.ts';
import { linked } from './linked.ts';
import type { PrCheck, PrComment, PrDetail, PrFile, PrThread } from './types.ts';

/**
 * PR preview: the conversation with each review thread shown on the diff it was left on, reply/resolve,
 * the full diff with threads inline, checks, and merging, all without leaving work-hub.
 */

/** The page's own tabs, or a `pr-tab` slot item's id. */
type Tab = 'conversation' | 'files' | 'checks' | (string & {});

const POLL_MS = 30_000;

export function PrPage({ owner, repo, number, sessions }: { owner: string; repo: string; number: string; sessions: Session[] }) {
  const base = `/api/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [files, setFiles] = useState<PrFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'conversation');
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const filesFor = useRef<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const lowData = useLowData();
  const prActions = useSlot('pr-action');
  const prTabs = useSlot('pr-tab');
  // A hash naming no tab (e.g. a plugin's that is off) shows the conversation.
  const tab: Tab = ['conversation', 'files', 'checks', ...prTabs.map((t) => t.id)].includes(picked) ? picked : 'conversation';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await get<PrDetail>(base);
      setPr(d);
      setLoadedAt(Date.now());
      setError(null);
      // The diff only changes with the head commit.
      if (filesFor.current !== d.headOid) {
        filesFor.current = d.headOid;
        get<PrFile[]>(`${base}/files`).then(setFiles, (e: Error) => setError(e.message));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base]);

  // Load now, then refresh every 30s while the tab is visible (checks and new comments). Low data: on tap only.
  useEffect(() => {
    void load();
    if (lowData) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    const onVis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, lowData]);

  const switchTab = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `${location.pathname}#${t}`);
  };

  const viewInFile = (threadId: string) => {
    setFocusThread(threadId);
    switchTab('files');
  };

  const back = (
    <Link to="/prs" className="back">
      ← PRs
    </Link>
  );
  if (!pr) {
    return (
      <div className="page wide">
        {back}
        <p className={error ? 'bad' : 'muted'}>{error ?? 'Loading…'}</p>
      </div>
    );
  }

  const unresolved = pr.threads.filter((t) => !t.isResolved).length;
  const failing = pr.checks.filter((c) => c.state === 'failure').length;
  const pending = pr.checks.filter((c) => c.state === 'pending').length;
  const session = sessions.find((s) => linked(s, { branch: pr.head, repo: pr.repo }) && !['done', 'failed', 'stopped'].includes(s.status));

  return (
    <div className="page wide pr-page">
      {back}
      <div className="pr-head">
        <h2>
          {pr.title} <span className="muted">#{pr.number}</span>
        </h2>
        <div className="sub">
          <StateTag pr={pr} />
          <span>{pr.repo}</span>
          <span>
            {pr.author} wants to merge <code>{pr.head}</code> into <code>{pr.base}</code>
          </span>
          <span className="diffstat">
            <span className="ok">+{pr.additions}</span> <span className="bad">−{pr.deletions}</span>
          </span>
          <span title={pr.updatedAt}>updated {ago(pr.updatedAt)} ago</span>
          <span className="grow" />
          {session && (
            <button className={`small st-${session.status}`} onClick={() => navigate(`/sessions/${session.sessionId}`)} title={session.name}>
              {session.needsInput ? 'Session ⚠' : 'Session ▸'}
            </button>
          )}
          {lowData ? (
            <AsOf at={loadedAt} onRefresh={() => void load()} busy={loading} />
          ) : (
            <button className="small ghost" onClick={() => void load()} disabled={loading} title="Refresh" aria-label="Refresh">
              {loading ? '…' : '↻'}
            </button>
          )}
          {prActions.map((a) => {
            const Action = a.component;
            return <Action key={`${a.plugin}:${a.id}`} owner={owner} repo={repo} number={pr.number} pr={pr} />;
          })}
          <a className="small-text" href={pr.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
        {error && <div className="bad small-text">{error}</div>}
      </div>

      <div className="seg pr-tabs">
        <button className={tab === 'conversation' ? 'on' : ''} onClick={() => switchTab('conversation')}>
          Conversation {unresolved > 0 && <span className="count warn">{unresolved}</span>}
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => switchTab('files')}>
          Files <span className="count">{pr.changedFiles}</span>
        </button>
        <button className={tab === 'checks' ? 'on' : ''} onClick={() => switchTab('checks')}>
          Checks {failing > 0 ? <span className="count bad">{failing}</span> : pending > 0 ? <span className="count pending">{pending}</span> : null}
        </button>
        {prTabs.map((t) => (
          <button key={`${t.plugin}:${t.id}`} className={tab === t.id ? 'on' : ''} onClick={() => switchTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'conversation' && <Conversation pr={pr} base={base} reload={load} onViewInFile={viewInFile} />}
      {tab === 'files' && <Files pr={pr} files={files} base={base} reload={load} focusThread={focusThread} onFocused={() => setFocusThread(null)} />}
      {tab === 'checks' && <Checks checks={pr.checks} />}
      {prTabs.map((t) => {
        if (tab !== t.id) return null;
        const Tab = t.component;
        return <Tab key={`${t.plugin}:${t.id}`} owner={owner} repo={repo} number={pr.number} pr={pr} />;
      })}
      {(tab === 'conversation' || tab === 'checks') && <MergeBox pr={pr} base={base} reload={load} onShowChecks={() => switchTab('checks')} />}
    </div>
  );
}

function StateTag({ pr }: { pr: PrDetail }) {
  if (pr.state === 'MERGED') return <span className="tag merged">merged</span>;
  if (pr.state === 'CLOSED') return <span className="tag bad">closed</span>;
  if (pr.isDraft) return <span className="tag">draft</span>;
  return <span className="tag ok">open</span>;
}

const CLAMP_PX = 320;

// The GitHub emoji shortcodes bots actually use; anything else stays as written.
const EMOJI: Record<string, string> = {
  white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', warning: '⚠️', rocket: '🚀', hourglass: '⌛',
  hourglass_flowing_sand: '⏳', tada: '🎉', bulb: '💡', memo: '📝', mag: '🔍', robot: '🤖', red_circle: '🔴',
  green_circle: '🟢', yellow_circle: '🟡', no_entry: '⛔', information_source: 'ℹ️', recycle: '♻️', lock: '🔒',
  construction: '🚧', fire: '🔥', eyes: '👀', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
};
const emojify = (t: string) => t.replace(/:([a-z0-9_+-]+):/g, (m, k: string) => EMOJI[k] ?? m);

/** Markdown; with `clamp`, long text (bot reviews, CI reports) is cut to a few lines behind "Show more". */
function Md({ text, clamp }: { text: string; clamp?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (clamp && ref.current) setLong(ref.current.scrollHeight > CLAMP_PX + 80);
  }, [clamp, text]);
  if (!text.trim()) return <p className="muted small-text">No description.</p>;
  // Bots hide metadata in <!-- --> comments; other raw HTML is skipped (its markdown inside still renders).
  const md = emojify(text.replace(/<!--[\s\S]*?-->/g, ''));
  const clamped = long && !expanded;
  return (
    <>
      <div ref={ref} className={`md${clamped ? ' clamped' : ''}`} style={clamped ? { maxHeight: CLAMP_PX } : undefined}>
        <Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}>
          {md}
        </Markdown>
      </div>
      {long && (
        <button className="linkish small-text" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

function CommentView({ c, repeats }: { c: PrComment; repeats?: PrComment[] }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div className="pr-comment">
      <div className="pr-comment-head">
        <b>{c.author}</b>
        <a className="muted" href={c.url} target="_blank" rel="noreferrer" title={c.createdAt}>
          {ago(c.createdAt)} ago
        </a>
        {repeats && repeats.length > 1 && (
          <button className="linkish small-text" onClick={() => setShowAll(!showAll)} title="Identical comments from the same author, shown once">
            posted {repeats.length} times · first {ago(repeats[0].createdAt)} ago {showAll ? '▾' : '▸'}
          </button>
        )}
      </div>
      <Md text={c.body} clamp />
      {showAll && repeats && (
        <ul className="repeat-list small-text">
          {repeats.map((r) => (
            <li key={r.id}>
              <a className="muted" href={r.url} target="_blank" rel="noreferrer">
                {new Date(r.createdAt).toLocaleString()}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What a comment says, ignoring hidden metadata and whitespace (bots re-post the same status with new ids). */
const sameText = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();

/**
 * Bots (CI, review loops) re-post the same status over and over. Keep one entry per author + text, at its latest
 * time, with every occurrence attached.
 */
function collapseRepeats(comments: PrComment[]): Array<{ c: PrComment; repeats: PrComment[] }> {
  const groups = new Map<string, PrComment[]>();
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const k = `${c.author}\n${sameText(c.body)}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return [...groups.values()].map((g) => ({ c: g[g.length - 1], repeats: g }));
}

// --- Conversation ------------------------------------------------------------------------------

type Item =
  | { kind: 'comment'; at: string; c: PrComment; repeats: PrComment[] }
  | { kind: 'review'; at: string; r: PrDetail['reviews'][number] }
  | { kind: 'thread'; at: string; t: PrThread };

const REVIEW_LABEL: Record<string, [string, string]> = {
  APPROVED: ['approved', 'ok'],
  CHANGES_REQUESTED: ['requested changes', 'bad'],
  COMMENTED: ['reviewed', 'muted'],
  DISMISSED: ['review dismissed', 'muted'],
  PENDING: ['pending review', 'muted'],
};

function Conversation({ pr, base, reload, onViewInFile }: { pr: PrDetail; base: string; reload: () => Promise<void>; onViewInFile: (id: string) => void }) {
  const [onlyOpen, setOnlyOpen] = useState(false);
  const items = useMemo(() => {
    const all: Item[] = [
      ...collapseRepeats(pr.comments).map(({ c, repeats }): Item => ({ kind: 'comment', at: c.createdAt, c, repeats })),
      ...pr.reviews.map((r): Item => ({ kind: 'review', at: r.submittedAt ?? '', r })),
      ...pr.threads.map((t): Item => ({ kind: 'thread', at: t.comments[0]?.createdAt ?? '', t })),
    ];
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }, [pr]);
  const shown = onlyOpen ? items.filter((i) => i.kind === 'thread' && !i.t.isResolved) : items;

  return (
    <div className="pr-conv">
      <div className="panel pad">
        <div className="pr-comment-head">
          <b>{pr.author}</b>
          <span className="muted">opened {ago(pr.createdAt)} ago</span>
        </div>
        <Md text={pr.body} />
      </div>

      <div className="pr-conv-bar">
        <label className="small-text">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Unresolved threads only
        </label>
      </div>

      {shown.map((i) =>
        i.kind === 'comment' ? (
          <div key={i.c.id} className="panel pad">
            <CommentView c={i.c} repeats={i.repeats} />
          </div>
        ) : i.kind === 'review' ? (
          <div key={i.r.id} className="panel pad">
            <div className="pr-comment-head">
              <b>{i.r.author}</b>
              <span className={`tag ${REVIEW_LABEL[i.r.state]?.[1] ?? ''}`}>{REVIEW_LABEL[i.r.state]?.[0] ?? i.r.state.toLowerCase()}</span>
              {i.r.submittedAt && (
                <a className="muted" href={i.r.url} target="_blank" rel="noreferrer">
                  {ago(i.r.submittedAt)} ago
                </a>
              )}
            </div>
            {i.r.body.trim() && <Md text={i.r.body} clamp />}
          </div>
        ) : (
          <ThreadCard key={i.t.id} t={i.t} base={base} reload={reload} withHunk onViewInFile={() => onViewInFile(i.t.id)} />
        ),
      )}
      {onlyOpen && !shown.length && <p className="muted pad">No unresolved threads.</p>}

      <CommentBox
        placeholder="Leave a comment on the PR"
        label="Comment"
        onSubmit={async (text) => {
          await post(`${base}/comment`, { prId: pr.id, body: text });
          await reload();
        }}
      />
    </div>
  );
}

/** The last few lines of the hunk a thread was left on, with the commented line(s) tinted. */
function hunkContext(t: PrThread): { lines: DiffLine[]; highlight: Set<string> } {
  const all = parsePatch(t.diffHunk).filter((l) => l.kind !== 'hunk' && l.kind !== 'meta');
  const onSide = (l: DiffLine) => (t.side === 'LEFT' ? l.old : l.new);
  const span = t.startLine && t.line ? Math.max(1, t.line - t.startLine + 1) : 1;
  const highlight = new Set<string>();
  let i = all.length - 1;
  for (let n = 0; i >= 0 && n < span; i--) {
    const ln = onSide(all[i]);
    if (ln == null) continue;
    highlight.add(lineKey(t.side, ln));
    n++;
  }
  return { lines: all.slice(Math.max(0, i + 1 - 4)), highlight };
}

function ThreadCard({
  t,
  base,
  reload,
  withHunk,
  onViewInFile,
}: {
  t: PrThread;
  base: string;
  reload: () => Promise<void>;
  withHunk?: boolean;
  onViewInFile?: () => void;
}) {
  const [open, setOpen] = useState(!t.isResolved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ctx = useMemo(() => (withHunk ? hunkContext(t) : null), [t, withHunk]);
  const line = t.line ?? t.originalLine;

  const resolve = async (resolved: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await post(`${base}/threads/resolve`, { threadId: t.id, resolved });
      await reload();
      if (resolved) setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={`thread-${t.id}`} className={`panel pr-thread ${t.isResolved ? 'resolved' : ''}`}>
      <div className="pr-thread-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <code className="grow">
          {t.path}
          {line != null && `:${t.startLine && t.startLine !== line ? `${t.startLine}-` : ''}${line}`}
        </code>
        {t.isOutdated && <span className="tag">outdated</span>}
        {t.isResolved ? <span className="tag ok">resolved</span> : <span className="tag warn">unresolved</span>}
        {!open && <span className="muted small-text">{t.comments.length} comment{t.comments.length === 1 ? '' : 's'} · {t.comments[0]?.author}</span>}
      </div>
      {open && (
        <>
          {ctx && ctx.lines.length > 0 && <DiffTable lines={ctx.lines} highlight={ctx.highlight} />}
          <div className="pr-thread-body">
            {t.comments.map((c) => (
              <CommentView key={c.id} c={c} />
            ))}
            <CommentBox
              compact
              placeholder="Reply…"
              label="Reply"
              onSubmit={async (text) => {
                await post(`${base}/threads/reply`, { threadId: t.id, body: text });
                await reload();
              }}
              extra={
                <>
                  <button className="small ghost" disabled={busy} onClick={() => void resolve(!t.isResolved)}>
                    {t.isResolved ? 'Unresolve' : 'Resolve'}
                  </button>
                  {onViewInFile && !t.isOutdated && (
                    <button className="small ghost" onClick={onViewInFile}>
                      View in file
                    </button>
                  )}
                </>
              }
            />
            {err && <div className="bad small-text">{err}</div>}
          </div>
        </>
      )}
    </div>
  );
}

function CommentBox({
  placeholder,
  label,
  onSubmit,
  compact,
  extra,
}: {
  placeholder: string;
  label: string;
  onSubmit: (text: string) => Promise<void>;
  compact?: boolean;
  extra?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(text);
      setText('');
      setFocused(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`comment-box ${compact ? 'compact' : 'panel pad'}`}>
      <textarea
        value={text}
        placeholder={placeholder}
        rows={focused || text || !compact ? 4 : 1}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={busy}
      />
      <div className="comment-box-actions">
        {extra}
        <span className="grow" />
        {(text || !compact) && (
          <button className="small" disabled={busy || !text.trim()} onClick={() => void submit()} title={keyLabel('Mod+Enter')}>
            {busy ? 'Sending…' : label}
          </button>
        )}
      </div>
      {err && <div className="bad small-text">{err}</div>}
    </div>
  );
}

// --- Files ---------------------------------------------------------------------------------------

function Files({
  pr,
  files,
  base,
  reload,
  focusThread,
  onFocused,
}: {
  pr: PrDetail;
  files: PrFile[] | null;
  base: string;
  reload: () => Promise<void>;
  focusThread: string | null;
  onFocused: () => void;
}) {
  // Jump to the thread asked for from the conversation, once the diff is on screen.
  useEffect(() => {
    if (!focusThread || !files) return;
    const el = document.getElementById(`thread-${focusThread}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    onFocused();
  }, [focusThread, files]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!files) return <p className="muted pad">Loading diff…</p>;
  const big = files.reduce((n, f) => n + f.additions + f.deletions, 0) > 3000;
  const threadsByPath = new Map<string, PrThread[]>();
  for (const t of pr.threads) threadsByPath.set(t.path, [...(threadsByPath.get(t.path) ?? []), t]);

  return (
    <div className="pr-files">
      {files.map((f) => (
        <FileDiff key={f.path} f={f} threads={threadsByPath.get(f.path) ?? []} base={base} reload={reload} startOpen={!big || (threadsByPath.get(f.path)?.length ?? 0) > 0 || focusThread != null} />
      ))}
    </div>
  );
}

function FileDiff({ f, threads, base, reload, startOpen }: { f: PrFile; threads: PrThread[]; base: string; reload: () => Promise<void>; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const lines = useMemo(() => (f.patch ? parsePatch(f.patch) : []), [f.patch]);
  const placed = new Map<string, PrThread[]>();
  const loose: PrThread[] = [];
  const present = new Set(lines.flatMap((l) => [l.new != null ? lineKey('RIGHT', l.new) : '', l.old != null ? lineKey('LEFT', l.old) : '']));
  for (const t of threads) {
    const k = t.line != null ? lineKey(t.side, t.line) : null;
    if (k && present.has(k)) placed.set(k, [...(placed.get(k) ?? []), t]);
    else loose.push(t);
  }
  const unresolved = threads.filter((t) => !t.isResolved).length;

  return (
    <div className="panel pr-file">
      <div className="pr-file-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <code className="grow">
          {f.previousPath && f.previousPath !== f.path ? `${f.previousPath} → ` : ''}
          {f.path}
        </code>
        {f.status !== 'modified' && <span className="tag">{f.status}</span>}
        {unresolved > 0 && <span className="tag warn">{unresolved} unresolved</span>}
        <span className="diffstat">
          <span className="ok">+{f.additions}</span> <span className="bad">−{f.deletions}</span>
        </span>
      </div>
      {open && (
        <>
          {loose.map((t) => (
            <div key={t.id} className="pr-loose">
              <ThreadCard t={t} base={base} reload={reload} withHunk />
            </div>
          ))}
          {f.patch ? (
            <DiffTable
              lines={lines}
              after={(keys) => {
                const ts = keys.flatMap((k) => placed.get(k) ?? []);
                // A context line has both keys; don't show the same thread twice.
                const uniq = [...new Map(ts.map((t) => [t.id, t])).values()];
                return uniq.length ? uniq.map((t) => <ThreadCard key={t.id} t={t} base={base} reload={reload} />) : null;
              }}
            />
          ) : (
            <p className="muted pad small-text">Binary file or diff too large to show.</p>
          )}
        </>
      )}
    </div>
  );
}

// --- Checks --------------------------------------------------------------------------------------

const CHECK_GLYPH: Record<PrCheck['state'], [string, string]> = {
  failure: ['✗', 'bad'],
  pending: ['●', 'pending'],
  success: ['✓', 'ok'],
  cancelled: ['⊘', 'muted'],
  neutral: ['○', 'muted'],
  skipped: ['–', 'muted'],
};
const CHECK_ORDER: PrCheck['state'][] = ['failure', 'pending', 'cancelled', 'success', 'neutral', 'skipped'];

function duration(c: PrCheck): string {
  if (!c.startedAt || !c.completedAt) return '';
  const s = Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function Checks({ checks }: { checks: PrCheck[] }) {
  const [showSkipped, setShowSkipped] = useState(false);
  if (!checks.length) return <p className="muted pad">No checks on the head commit.</p>;
  const sorted = [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) || Number(b.required) - Number(a.required));
  const skipped = sorted.filter((c) => c.state === 'skipped').length;
  const shown = showSkipped ? sorted : sorted.filter((c) => c.state !== 'skipped');
  return (
    <div className="panel">
      <ul className="list">
        {shown.map((c, i) => {
          const [g, cls] = CHECK_GLYPH[c.state];
          return (
            <li key={i} className="row check-row">
              <span className={`checks ${cls}`}>{g}</span>
              <div className="grow">
                <div>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                  {c.required && <span className="tag"> required</span>}
                </div>
                <div className="sub">
                  {c.group && <span>{c.group}</span>}
                  {c.detail && <span>{c.detail}</span>}
                  {duration(c) && <span>{duration(c)}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {skipped > 0 && (
        <button className="ghost small pad-btn" onClick={() => setShowSkipped(!showSkipped)}>
          {showSkipped ? 'Hide' : 'Show'} {skipped} skipped
        </button>
      )}
    </div>
  );
}

// --- Merge ---------------------------------------------------------------------------------------

const MERGE_STATE: Record<string, [string, string]> = {
  CLEAN: ['Ready to merge', 'ok'],
  HAS_HOOKS: ['Ready to merge', 'ok'],
  UNSTABLE: ['Mergeable, but some non-required checks are failing', 'warn'],
  BLOCKED: ['Blocked by branch protection', 'bad'],
  BEHIND: ['The branch is behind its base; update it first', 'warn'],
  DIRTY: ['Merge conflicts; resolve them first', 'bad'],
  DRAFT: ['Draft PR; mark it ready for review first', 'muted'],
  UNKNOWN: ['GitHub is still working out whether this can merge', 'muted'],
};
const METHOD_LABEL = { SQUASH: 'Squash and merge', MERGE: 'Create a merge commit', REBASE: 'Rebase and merge' } as const;

function MergeBox({ pr, base, reload, onShowChecks }: { pr: PrDetail; base: string; reload: () => Promise<void>; onShowChecks: () => void }) {
  const [method, setMethod] = useState(pr.defaultMergeMethod);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  if (pr.state === 'MERGED') return <div className="panel pad merge-box"><span className="tag merged">merged</span> This PR has been merged.</div>;
  if (pr.state === 'CLOSED') return <div className="panel pad merge-box muted">This PR is closed.</div>;

  const [label, cls] = MERGE_STATE[pr.mergeStateStatus] ?? [pr.mergeStateStatus.toLowerCase(), 'muted'];
  const canMerge = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus);
  const failingRequired = pr.checks.filter((c) => c.required && c.state === 'failure');
  const pendingRequired = pr.checks.filter((c) => c.required && c.state === 'pending');
  const unresolved = pr.threads.filter((t) => !t.isResolved).length;

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ text: await fn(), error: false });
      await reload();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const merge = (admin: boolean) =>
    act(async () => {
      const r = await post<{ deletedBranch: boolean; note?: string }>(`${base}/merge`, { method, expectedHeadOid: pr.headOid, deleteBranch, admin });
      return ['Merged.', r.deletedBranch ? 'Branch deleted.' : '', r.note ?? ''].filter(Boolean).join(' ');
    });
  const markReady = () =>
    act(async () => {
      await post(`${base}/ready`, {});
      return 'Marked ready for review.';
    });
  const autoMerge = (enable: boolean) =>
    act(async () => {
      await post(`${base}/auto-merge`, { enable, method, expectedHeadOid: pr.headOid });
      return enable ? 'Auto-merge enabled: GitHub merges it once the requirements pass.' : 'Auto-merge turned off.';
    });

  return (
    <div className={`panel pad merge-box ms-${cls}`}>
      <div className={`merge-state ${cls}`}>
        <b>{label}</b>
      </div>
      <ul className="merge-reasons small-text">
        {pr.reviewDecision === 'APPROVED' && <li className="ok">✓ Approved</li>}
        {pr.reviewDecision === 'CHANGES_REQUESTED' && <li className="bad">✗ Changes requested</li>}
        {pr.reviewDecision === 'REVIEW_REQUIRED' && <li className="warn">● Review required</li>}
        {failingRequired.length > 0 && (
          <li className="bad">
            ✗ Required check{failingRequired.length > 1 ? 's' : ''} failing: {failingRequired.map((c) => c.name).join(', ')}{' '}
            <button className="linkish" onClick={onShowChecks}>
              see checks
            </button>
          </li>
        )}
        {pendingRequired.length > 0 && <li className="pending">● {pendingRequired.length} required check{pendingRequired.length > 1 ? 's' : ''} running</li>}
        {!failingRequired.length && !pendingRequired.length && pr.checks.length > 0 && <li className="ok">✓ Required checks passed</li>}
        {unresolved > 0 && <li className="warn">● {unresolved} unresolved thread{unresolved > 1 ? 's' : ''}</li>}
        {pr.mergeable === 'CONFLICTING' && <li className="bad">✗ Conflicts with {pr.base}</li>}
        {pr.autoMerge && (
          <li className="pending">
            ● Auto-merge ({pr.autoMerge.method.toLowerCase()}) enabled by {pr.autoMerge.enabledBy}
          </li>
        )}
        {pr.isInMergeQueue && <li className="pending">● In the merge queue</li>}
      </ul>

      {pr.isDraft && (
        <div className="merge-actions">
          <span className="grow" />
          <button className="primary" disabled={busy} onClick={() => void markReady()}>
            {busy ? 'Working…' : 'Ready for review'}
          </button>
        </div>
      )}
      {!pr.isDraft && (
        <div className="merge-actions">
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} disabled={busy}>
            {pr.mergeMethods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
          {pr.deleteBranchOnMerge ? (
            <span className="muted small-text">GitHub deletes the branch after merging</span>
          ) : (
            pr.headIsSameRepo && (
              <label className="small-text">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> Delete branch
              </label>
            )
          )}
          <span className="grow" />
          {canMerge && (
            <ConfirmPopover className="primary" message={`Merge this PR (${METHOD_LABEL[method].toLowerCase()}).`} confirmLabel={`Confirm: ${METHOD_LABEL[method].toLowerCase()}`} onConfirm={() => merge(false)} disabled={busy}>
              {busy ? 'Working…' : 'Merge'}
            </ConfirmPopover>
          )}
          {!canMerge && pr.autoMergeAllowed && pr.viewer.canEnableAutoMerge && !pr.autoMerge && (
            <button className="small" disabled={busy} onClick={() => void autoMerge(true)} title="GitHub merges it when reviews and required checks pass">
              Enable auto-merge
            </button>
          )}
          {pr.autoMerge && pr.viewer.canDisableAutoMerge && (
            <button className="small ghost" disabled={busy} onClick={() => void autoMerge(false)}>
              Turn off auto-merge
            </button>
          )}
          {!canMerge && pr.viewer.canMergeAsAdmin && pr.mergeStateStatus === 'BLOCKED' && (
            <ConfirmPopover className="danger small" confirmLabel="Bypass and merge" message="Skips branch protection." onConfirm={() => merge(true)} disabled={busy}>
              Merge as admin
            </ConfirmPopover>
          )}
        </div>
      )}
      {msg && <div className={`small-text ${msg.error ? 'bad' : 'ok'}`}>{msg.text}</div>}
    </div>
  );
}
