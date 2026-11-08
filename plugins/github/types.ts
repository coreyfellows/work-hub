/**
 * Types shared by the github plugin's server and web halves (type-only imports across them are fine). Other plugins
 * get them from here too, e.g. the `github` service's `PrDetail`.
 */

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  isDraft: boolean;
  /** When it merged (only on PRs in `merged`). */
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  branch: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  additions: number;
  deletions: number;
  comments: number;
  unresolvedThreads: number;
}

export interface GithubData {
  host: string;
  mine: PullRequest[];
  reviewRequested: PullRequest[];
  /** My PRs merged in the last `mergedDays` days (setting), newest first. */
  merged: PullRequest[];
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrThread {
  id: string;
  path: string;
  /** Line in the current diff (null when outdated) and the line it was originally left on. */
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  isResolved: boolean;
  isOutdated: boolean;
  diffHunk: string;
  comments: PrComment[];
}

export interface PrReview {
  id: string;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  submittedAt: string | null;
  url: string;
}

export interface PrCheck {
  name: string;
  /** Workflow (Actions) or status context group, when there is one. */
  group: string | null;
  /** Normalised: success, failure, pending, skipped, neutral, cancelled. */
  state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | 'cancelled';
  detail: string | null;
  url: string | null;
  /** Branch protection requires it to pass. */
  required: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PrFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunks; null for binary or too-large files. */
  patch: string | null;
}

export interface PrDetail {
  id: string;
  host: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  base: string;
  head: string;
  headOid: string;
  headIsSameRepo: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** GitHub's verdict on merging now: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeStateStatus: string;
  checksState: string | null;
  isInMergeQueue: boolean;
  autoMerge: { method: string; enabledBy: string } | null;
  viewer: { login: string; canMergeAsAdmin: boolean; canEnableAutoMerge: boolean; canDisableAutoMerge: boolean; canDeleteHeadRef: boolean };
  mergeMethods: Array<'MERGE' | 'SQUASH' | 'REBASE'>;
  defaultMergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
  deleteBranchOnMerge: boolean;
  autoMergeAllowed: boolean;
  comments: PrComment[];
  reviews: PrReview[];
  threads: PrThread[];
  checks: PrCheck[];
}

/** What the PR list's "Start session" / "Review with Claude" button posts to `POST /api/prs/session`. */
export interface PrRef {
  url: string;
  repo: string; // owner/name
  number: number;
  branch: string;
  title: string;
  mine: boolean;
}

/**
 * `ctx.services.get<GithubService>('github')`: what other plugins (and the core's adversarial review, until it is a
 * plugin) use. Absent while the github plugin is off.
 */
export interface GithubService {
  /** The GitHub host every `gh` call goes to (resolved on first use; see ghHost.ts). */
  host(): Promise<string>;
  /** Validated `owner`/`repo`/`number` route params, else null. */
  parseRef(owner: string, name: string, number: string): { owner: string; name: string; number: number } | null;
  prDetail(owner: string, name: string, number: number): Promise<PrDetail>;
  prFiles(owner: string, name: string, number: number): Promise<PrFile[]>;
  /** The worktree that has `branch` checked out: reused, else created under the worktrees root, and trusted for Claude. */
  ensureBranchWorktree(repoName: string, repo: string, branch: string, folder: string): Promise<{ worktree: string; created: boolean }>;
  /** The latest pull request lists (the `github` source's data), or null before the first fetch. */
  data(): GithubData | null;
}
