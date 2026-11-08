import { useState } from 'react';
import { post, useToast, type Sources, type WebPluginContext, type Worktree } from '../../plugin-api/web.ts';
import { ReviewButton } from './ReviewButton.tsx';

interface PrLite {
  url: string;
  branch: string;
  repo: string;
}

/** The PR (if any) open for a worktree's branch, from the github plugin's source when it's on (passed to the review). */
function prUrlFor(sources: Sources, t: Worktree): string | undefined {
  const github = sources.github?.data as { mine?: PrLite[]; reviewRequested?: PrLite[]; merged?: PrLite[] } | null | undefined;
  const all = [...(github?.mine ?? []), ...(github?.reviewRequested ?? []), ...(github?.merged ?? [])];
  return all.find((p) => p.branch === t.branch && p.repo.toLowerCase() === t.repo.toLowerCase())?.url;
}

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('job-kind', { kind: 'review', icon: '⚔' });

  // Details → Worktrees: after the github plugin's PR link (order 50), as before.
  ctx.contribute('worktree-action', {
    id: 'review',
    component: function ReviewWorktree({ workspace, worktree: t, sources }) {
      const { show: toast } = useToast();
      const [reviewing, setReviewing] = useState(false);
      const start = () => {
        setReviewing(true);
        post(`/api/workspaces/${workspace.id}/reviews`, { path: t.path, prUrl: prUrlFor(sources, t) })
          .then(() => toast({ text: 'Reviewing in the background. One session starts to address the findings when it finishes (jobs tray, top right).' }))
          .catch((e: Error) => toast({ kind: 'error', text: e.message }))
          .finally(() => setReviewing(false));
      };
      return (
        <button
          className="linkish small-text wt-pr"
          disabled={reviewing}
          title="Review this branch's diff in the background (the repo's review guidance if it has any, else every configured model in parallel), then start one session to address the findings"
          onClick={start}
        >
          {reviewing ? 'Starting…' : 'Adversarial review'}
        </button>
      );
    },
  });

  // The PR page (only there while the github plugin is on).
  ctx.contribute('pr-action', {
    id: 'review',
    component: ({ owner, repo, number }) => <ReviewButton owner={owner} repo={repo} number={number} />,
  });
}
