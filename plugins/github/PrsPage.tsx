import { Panel, navigate, type Session, type SourceState } from '../../plugin-api/web.ts';
import { PrPanel } from './PrPanel.tsx';
import type { GithubData } from './types.ts';

/** Pull requests: waiting on my review, and my own. Same rows and actions as before. */
export function PrsPage({ state, sessions }: { state: SourceState | undefined; sessions: Session[] }) {
  const open = (id: string) => navigate(`/sessions/${id}`);
  return (
    <div className="page">
      <Panel state={state} title="Needs my review">
        {(data: GithubData) => <PrPanel prs={data.reviewRequested} sessions={sessions} onOpenSession={open} showAuthor emptyText="Nothing waiting on you 🎉" />}
      </Panel>
      <Panel state={state} title="My PRs" hideMeta>
        {(data: GithubData) => <PrPanel prs={data.mine} sessions={sessions} onOpenSession={open} mine emptyText="No open PRs" />}
      </Panel>
    </div>
  );
}
