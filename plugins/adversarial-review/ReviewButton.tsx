import { useState } from 'react';
import { post, useToast } from '../../plugin-api/web.ts';

/**
 * The PR page's "Adversarial review" button (a `pr-action` slot item): starts a review of this PR in its workspace
 * (found or created); the jobs tray follows it.
 */
export function ReviewButton({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const { show: toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="small"
      disabled={busy}
      title="Review this PR's diff in the background (the repo's review guidance if it has any, else every configured model in parallel), then start one session to address the findings"
      onClick={() => {
        setBusy(true);
        post('/api/prs/review', { owner, repo, number })
          .then(() => toast({ text: 'Reviewing in the background. One session starts to address the findings when it finishes (jobs tray, top right).' }))
          .catch((e: Error) => toast({ kind: 'error', text: e.message }))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Starting…' : 'Adversarial review'}
    </button>
  );
}
