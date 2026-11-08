import { useState } from 'react';
import { Link, ago, post, type Session } from '../../plugin-api/web.ts';
import { linked } from './linked.ts';
import type { PullRequest } from './types.ts';

const CHECKS: Record<string, [glyph: string, cls: string, label: string]> = {
  SUCCESS: ['✓', 'ok', 'checks passing'],
  FAILURE: ['✗', 'bad', 'checks failing'],
  ERROR: ['✗', 'bad', 'checks errored'],
  PENDING: ['●', 'pending', 'checks running'],
  EXPECTED: ['●', 'pending', 'checks expected'],
};

const REVIEW: Record<string, [string, string]> = {
  APPROVED: ['approved', 'ok'],
  CHANGES_REQUESTED: ['changes requested', 'bad'],
  REVIEW_REQUIRED: ['review required', 'muted'],
};

export function PrPanel({
  prs,
  sessions,
  onOpenSession,
  mine,
  showAuthor,
  emptyText,
  grouped,
}: {
  prs: PullRequest[];
  sessions: Session[];
  onOpenSession: (id: string) => void;
  mine?: boolean;
  showAuthor?: boolean;
  emptyText: string;
  /** Group rows under Draft / Open / Merged headings (a workspace's Pull requests section). */
  grouped?: boolean;
}) {
  if (!prs.length) return <div className="muted pad">{emptyText}</div>;
  if (!grouped) return <PrRows prs={prs} sessions={sessions} onOpenSession={onOpenSession} mine={mine} showAuthor={showAuthor} />;
  // Grouped Draft, Open, Merged (each keeps the order it was given); empty groups are skipped.
  const groups: Array<[label: string, items: PullRequest[]]> = [
    ['Draft', prs.filter((p) => !p.mergedAt && p.isDraft)],
    ['Open', prs.filter((p) => !p.mergedAt && !p.isDraft)],
    ['Merged', prs.filter((p) => p.mergedAt)],
  ];
  return (
    <div className="pr-groups">
      {groups.filter(([, items]) => items.length).map(([label, items]) => (
        <div key={label} className={`pr-group pr-group-${label.toLowerCase()}`}>
          <div className="pr-group-head">
            {label} <span className="muted">{items.length}</span>
          </div>
          <PrRows prs={items} sessions={sessions} onOpenSession={onOpenSession} mine={mine} showAuthor={showAuthor} />
        </div>
      ))}
    </div>
  );
}

function PrRows({
  prs,
  sessions,
  onOpenSession,
  mine,
  showAuthor,
}: {
  prs: PullRequest[];
  sessions: Session[];
  onOpenSession: (id: string) => void;
  mine?: boolean;
  showAuthor?: boolean;
}) {
  return (
    <ul className="list">
      {prs.map((p) => {
        const merged = !!p.mergedAt;
        const checks = merged ? null : p.checks ? CHECKS[p.checks] : null;
        const review = !merged && p.reviewDecision ? REVIEW[p.reviewDecision] : null;
        const session = sessions.find((s) => linked(s, p) && !['done', 'failed', 'stopped'].includes(s.status));
        return (
          <li key={p.url} className={`row pr ${p.isDraft ? 'draft' : ''} ${merged ? 'merged' : ''}`}>
            <span className={`checks ${merged ? 'merged' : (checks?.[1] ?? 'muted')}`} title={merged ? 'merged' : (checks?.[2] ?? 'no checks')}>
              {merged ? '⇣' : (checks?.[0] ?? '·')}
            </span>
            <div className="grow">
              <Link className="title" to={`/prs/${p.repo}/${p.number}`} title="Open the PR preview">
                {p.title}
              </Link>{' '}
              <a className="muted small-text" href={p.url} target="_blank" rel="noreferrer" title="Open on GitHub">
                ↗
              </a>
              <div className="sub">
                <span>
                  {p.repo.split('/')[1]}#{p.number}
                </span>
                {showAuthor && <span>{p.author}</span>}
                {review && <span className={`tag ${review[1]}`}>{review[0]}</span>}
                {!merged && p.mergeable === 'CONFLICTING' && <span className="tag bad">conflicts</span>}
                {!merged && p.unresolvedThreads > 0 && <span className="tag warn">{p.unresolvedThreads} unresolved</span>}
                <span className="diffstat">
                  <span className="ok">+{p.additions}</span> <span className="bad">−{p.deletions}</span>
                </span>
                {merged ? (
                  <span title={`merged ${p.mergedAt}`}>merged {ago(p.mergedAt!)} ago</span>
                ) : (
                  <span title={`updated ${p.updatedAt}`}>{ago(p.updatedAt)}</span>
                )}
              </div>
            </div>
            {(!merged || session) && <SessionButton pr={p} session={session} mine={!!mine} onOpenSession={onOpenSession} />}
          </li>
        );
      })}
    </ul>
  );
}

function SessionButton({
  pr,
  session,
  mine,
  onOpenSession,
}: {
  pr: PullRequest;
  session: Session | undefined;
  mine: boolean;
  onOpenSession: (id: string) => void;
}) {
  const [state, setState] = useState<{ busy: boolean; msg: string | null; error: boolean }>({ busy: false, msg: null, error: false });

  if (session) {
    return (
      <button className={`small st-${session.status}`} onClick={() => onOpenSession(session.sessionId)} title={session.name}>
        {session.needsInput ? 'Session ⚠' : 'Session ▸'}
      </button>
    );
  }

  const start = async () => {
    setState({ busy: true, msg: null, error: false });
    try {
      await post('/api/prs/session', {
        url: pr.url,
        repo: pr.repo,
        number: pr.number,
        branch: pr.branch,
        title: pr.title,
        mine,
      });
      setState({
        busy: false,
        error: false,
        msg: 'Starting: follow it in the jobs tray (top right).',
      });
    } catch (e) {
      setState({ busy: false, msg: (e as Error).message, error: true });
    }
  };

  return (
    <div className="pr-action">
      <button className="small" onClick={start} disabled={state.busy} title={mine ? 'Start a Claude session to drive this PR' : 'Start a Claude session to review this PR'}>
        {state.busy ? 'Starting…' : mine ? 'Start session' : 'Review with Claude'}
      </button>
      {state.msg && <div className={`action-msg ${state.error ? 'bad' : 'muted'}`}>{state.msg}</div>}
    </div>
  );
}
