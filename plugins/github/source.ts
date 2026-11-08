import { runJson, type Source } from '../../plugin-api/server.ts';
import { settings } from './settings.ts';
import type { GithubData, PullRequest } from './types.ts';

export type { GithubData, PullRequest } from './types.ts';

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft mergedAt createdAt updatedAt headRefName
    reviewDecision mergeable additions deletions
    repository { nameWithOwner }
    author { login }
    comments { totalCount }
    reviewThreads(first: 100) { nodes { isResolved } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;

const QUERY = `
query($mine: String!, $review: String!, $merged: String!) {
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } }
  merged: search(query: $merged, type: ISSUE, first: 20) { nodes { ${PR_FIELDS} } }
}`;

interface RawPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  reviewDecision: PullRequest['reviewDecision'];
  mergeable: PullRequest['mergeable'];
  additions: number;
  deletions: number;
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  comments: { totalCount: number };
  reviewThreads: { nodes: Array<{ isResolved: boolean }> };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: PullRequest['checks'] } | null } }> };
}

function shape(p: RawPr): PullRequest {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    repo: p.repository.nameWithOwner,
    author: p.author?.login ?? 'ghost',
    isDraft: p.isDraft,
    mergedAt: p.mergedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    branch: p.headRefName,
    reviewDecision: p.reviewDecision,
    checks: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    mergeable: p.mergeable,
    additions: p.additions,
    deletions: p.deletions,
    comments: p.comments.totalCount,
    unresolvedThreads: p.reviewThreads.nodes.filter((t) => !t.isResolved).length,
  };
}

async function fetchPrs(): Promise<GithubData> {
  const { mergedDays } = settings();
  const host = await settings().host();
  const since = new Date(Date.now() - mergedDays * 86_400_000).toISOString().slice(0, 10);
  const res = await runJson<{ data: { mine: { nodes: RawPr[] }; review: { nodes: RawPr[] }; merged: { nodes: RawPr[] } } }>(
    'gh',
    [
      'api', 'graphql',
      '--hostname', host,
      '-f', `query=${QUERY}`,
      '-f', 'mine=is:pr is:open author:@me archived:false sort:updated-desc',
      '-f', 'review=is:pr is:open review-requested:@me archived:false sort:updated-desc',
      '-f', `merged=is:pr is:merged author:@me archived:false merged:>=${since} sort:updated-desc`,
    ],
    { timeoutMs: 30_000 },
  );
  // search can return non-PR nodes as {} when the fragment doesn't apply
  const prs = (nodes: RawPr[]) => nodes.filter((n) => n && n.number).map(shape);
  const merged = prs(res.data.merged.nodes).sort((a, b) => Date.parse(b.mergedAt ?? '') - Date.parse(a.mergedAt ?? ''));
  return { host, mine: prs(res.data.mine.nodes), reviewRequested: prs(res.data.review.nodes), merged };
}

/** My open PRs, PRs waiting on my review and my recently merged ones, polled through the registry. */
export function githubSource(intervalMs: number): Source<GithubData> {
  return { id: 'github', title: 'Pull requests', intervalMs, fetch: fetchPrs };
}
