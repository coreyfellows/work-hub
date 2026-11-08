import { run, runJson } from '../../plugin-api/server.ts';
import { settings } from './settings.ts';
import type { PrCheck, PrComment, PrDetail, PrFile, PrReview } from './types.ts';

export type { PrCheck, PrComment, PrDetail, PrFile, PrReview, PrThread } from './types.ts';

/**
 * One PR in detail, for the in-app preview (/prs/:owner/:repo/:number): conversation, review threads with
 * the diff hunk they sit on, the full file diffs, checks, and what merging would do. Plus the write actions
 * (reply, resolve, comment, merge, auto-merge). Everything goes through `gh` on this Mac, no tokens stored.
 * Fetched on demand when the page is open, not through the registry: it spends no model tokens.
 */

const DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    deleteBranchOnMerge autoMergeAllowed
    pullRequest(number: $number) {
      id number url title body state isDraft createdAt updatedAt
      baseRefName headRefName headRefOid isCrossRepository
      additions deletions changedFiles reviewDecision mergeable mergeStateStatus isInMergeQueue
      viewerCanMergeAsAdmin viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanDeleteHeadRef
      author { login }
      autoMergeRequest { mergeMethod enabledBy { login } }
      comments(first: 100) { nodes { id url body createdAt author { login } } }
      reviews(first: 100) { nodes { id url state body submittedAt author { login } } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide
          comments(first: 100) { nodes { id url body createdAt diffHunk author { login } } }
        }
      }
      commits(last: 1) {
        nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl startedAt completedAt title isRequired(pullRequestNumber: $number)
            checkSuite { workflowRun { workflow { name } } } }
          ... on StatusContext { context state targetUrl description createdAt isRequired(pullRequestNumber: $number) }
        } } } } }
      }
    }
  }
}`;

interface Login { login: string }
interface RawComment { id: string; url: string; body: string; createdAt: string; author: Login | null; diffHunk?: string }
interface RawCheck {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null; startedAt?: string | null;
  completedAt?: string | null; title?: string | null; checkSuite?: { workflowRun: { workflow: { name: string } } | null } | null;
  context?: string; state?: string; targetUrl?: string | null; description?: string | null; createdAt?: string;
  isRequired?: boolean;
}

const ghost = (a: Login | null) => a?.login ?? 'ghost';

function comment(c: RawComment): PrComment {
  return { id: c.id, author: ghost(c.author), body: c.body, createdAt: c.createdAt, url: c.url };
}

function checkState(c: RawCheck): PrCheck['state'] {
  if (c.__typename === 'StatusContext') {
    return c.state === 'SUCCESS' ? 'success' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending' : 'failure';
  }
  if (c.status !== 'COMPLETED') return 'pending';
  switch (c.conclusion) {
    case 'SUCCESS': return 'success';
    case 'SKIPPED': return 'skipped';
    case 'NEUTRAL': return 'neutral';
    case 'CANCELLED': return 'cancelled';
    default: return 'failure'; // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
}

function check(c: RawCheck): PrCheck {
  if (c.__typename === 'StatusContext') {
    return {
      name: c.context ?? '?', group: null, state: checkState(c), detail: c.description ?? null,
      url: c.targetUrl ?? null, required: !!c.isRequired, startedAt: c.createdAt ?? null, completedAt: null,
    };
  }
  return {
    name: c.name ?? '?', group: c.checkSuite?.workflowRun?.workflow.name ?? null, state: checkState(c),
    detail: c.title ?? (c.conclusion ? c.conclusion.toLowerCase() : c.status?.toLowerCase() ?? null),
    url: c.detailsUrl ?? null, required: !!c.isRequired, startedAt: c.startedAt ?? null, completedAt: c.completedAt ?? null,
  };
}

const OWNER_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Validate route params before they reach gh (they're args, never a shell, but keep them sane). */
export function parseRef(owner: string, name: string, number: string): { owner: string; name: string; number: number } | null {
  const n = Number(number);
  if (!OWNER_RE.test(owner) || !OWNER_RE.test(name) || !Number.isInteger(n) || n <= 0) return null;
  return { owner, name, number: n };
}

async function graphql<T>(query: string, vars: Record<string, string | number | boolean>): Promise<T> {
  const args = ['api', 'graphql', '--hostname', (await settings().host()), '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
  const res = await runJson<{ data?: T; errors?: Array<{ message: string }> }>('gh', args, { timeoutMs: 30_000, cwd: settings().scratch });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
  return res.data as T;
}

export async function prDetail(owner: string, name: string, number: number): Promise<PrDetail> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await graphql<any>(DETAIL_QUERY, { owner, name, number });
  const r = data.repository;
  const p = r?.pullRequest;
  if (!p) throw new Error(`no PR ${owner}/${name}#${number}`);
  const methods: PrDetail['mergeMethods'] = [];
  if (r.squashMergeAllowed) methods.push('SQUASH');
  if (r.mergeCommitAllowed) methods.push('MERGE');
  if (r.rebaseMergeAllowed) methods.push('REBASE');
  const rollup = p.commits.nodes[0]?.commit.statusCheckRollup;
  return {
    id: p.id,
    host: (await settings().host()),
    repo: r.nameWithOwner,
    number: p.number,
    url: p.url,
    title: p.title,
    body: p.body,
    author: ghost(p.author),
    state: p.state,
    isDraft: p.isDraft,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    base: p.baseRefName,
    head: p.headRefName,
    headOid: p.headRefOid,
    headIsSameRepo: !p.isCrossRepository,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    reviewDecision: p.reviewDecision,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    checksState: rollup?.state ?? null,
    isInMergeQueue: p.isInMergeQueue,
    autoMerge: p.autoMergeRequest ? { method: p.autoMergeRequest.mergeMethod, enabledBy: ghost(p.autoMergeRequest.enabledBy) } : null,
    viewer: {
      login: data.viewer.login,
      canMergeAsAdmin: p.viewerCanMergeAsAdmin,
      canEnableAutoMerge: p.viewerCanEnableAutoMerge,
      canDisableAutoMerge: p.viewerCanDisableAutoMerge,
      canDeleteHeadRef: p.viewerCanDeleteHeadRef,
    },
    mergeMethods: methods,
    defaultMergeMethod: methods.includes(r.viewerDefaultMergeMethod) ? r.viewerDefaultMergeMethod : methods[0] ?? 'MERGE',
    deleteBranchOnMerge: r.deleteBranchOnMerge,
    autoMergeAllowed: r.autoMergeAllowed,
    comments: p.comments.nodes.map(comment),
    reviews: p.reviews.nodes
      .filter((v: { state: string; body: string }) => v.body.trim() || v.state === 'APPROVED' || v.state === 'CHANGES_REQUESTED')
      .map((v: { id: string; url: string; state: PrReview['state']; body: string; submittedAt: string | null; author: Login | null }) => ({
        id: v.id, author: ghost(v.author), state: v.state, body: v.body, submittedAt: v.submittedAt, url: v.url,
      })),
    threads: p.reviewThreads.nodes.map(
      (t: { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; startLine: number | null; originalLine: number | null; diffSide: 'LEFT' | 'RIGHT'; comments: { nodes: RawComment[] } }) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        startLine: t.startLine,
        originalLine: t.originalLine,
        side: t.diffSide,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        diffHunk: t.comments.nodes[0]?.diffHunk ?? '',
        comments: t.comments.nodes.map(comment),
      }),
    ),
    checks: ((rollup?.contexts.nodes ?? []) as RawCheck[]).map(check),
  };
}

export async function prFiles(owner: string, name: string, number: number): Promise<PrFile[]> {
  // --jq prints one compact JSON object per line across all pages.
  const out = await run(
    'gh',
    [
      'api', '--hostname', (await settings().host()), '--paginate',
      `repos/${owner}/${name}/pulls/${number}/files?per_page=100`,
      '--jq', '.[] | {path: .filename, previousPath: .previous_filename, status, additions, deletions, patch}',
    ],
    { timeoutMs: 60_000, cwd: settings().scratch },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = JSON.parse(l) as PrFile;
      return { ...f, previousPath: f.previousPath ?? null, patch: f.patch ?? null };
    });
}

// --- Actions --------------------------------------------------------------------------------

const BODY_MAX = 65_000;

function body(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) throw new Error('comment is empty');
  if (text.length > BODY_MAX) throw new Error('comment is too long');
  return text;
}

const NODE_ID = /^[A-Za-z0-9_=+/-]{4,200}$/;
function nodeId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !NODE_ID.test(id)) throw new Error(`bad ${what}`);
  return id;
}

export async function replyToThread(threadId: unknown, text: unknown): Promise<PrComment> {
  const d = await graphql<{ addPullRequestReviewThreadReply: { comment: RawComment } }>(
    `mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
       comment { id url body createdAt author { login } } } }`,
    { id: nodeId(threadId, 'thread id'), body: body(text) },
  );
  return comment(d.addPullRequestReviewThreadReply.comment);
}

export async function setThreadResolved(threadId: unknown, resolved: boolean): Promise<void> {
  const op = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  await graphql(`mutation($id: ID!) { ${op}(input: { threadId: $id }) { thread { id isResolved } } }`, {
    id: nodeId(threadId, 'thread id'),
  });
}

export async function addPrComment(prId: unknown, text: unknown): Promise<PrComment> {
  const d = await graphql<{ addComment: { commentEdge: { node: RawComment } } }>(
    `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) {
       commentEdge { node { id url body createdAt author { login } } } } }`,
    { id: nodeId(prId, 'PR id'), body: body(text) },
  );
  return comment(d.addComment.commentEdge.node);
}

const METHODS = new Set(['MERGE', 'SQUASH', 'REBASE']);

export interface MergeRequest {
  method: 'MERGE' | 'SQUASH' | 'REBASE';
  /** The head commit the page showed; GitHub refuses the merge if the branch has moved since. */
  expectedHeadOid: string;
  deleteBranch?: boolean;
  /** Merge now even though branch protection blocks it (only when GitHub says you're allowed to). */
  admin?: boolean;
}

/**
 * Merge with GitHub's own API, pinned to the head commit that was on screen. Branch deletion uses
 * `gh pr merge`-style semantics: only for same-repo branches and only when GitHub doesn't already do it.
 */
export async function mergePr(owner: string, name: string, number: number, req: MergeRequest): Promise<{ merged: boolean; deletedBranch: boolean; note?: string }> {
  if (!METHODS.has(req.method)) throw new Error('bad merge method');
  if (!/^[0-9a-f]{40}$/.test(req.expectedHeadOid ?? '')) throw new Error('bad head commit');
  const pr = await prDetail(owner, name, number);
  if (pr.state !== 'OPEN') throw new Error(`PR is ${pr.state.toLowerCase()}`);
  if (pr.headOid !== req.expectedHeadOid) throw new Error('the branch has new commits since you loaded the page; reload and check again');
  if (!pr.mergeMethods.includes(req.method)) throw new Error(`${req.method.toLowerCase()} merges are disabled in this repo`);
  if (req.admin && !pr.viewer.canMergeAsAdmin) throw new Error("GitHub doesn't let you bypass branch protection here");

  if (req.admin) {
    // The GraphQL merge has no bypass flag; gh pr merge --admin uses the REST endpoint, which honours it.
    await run(
      'gh',
      ['pr', 'merge', String(number), '--repo', `${(await settings().host())}/${owner}/${name}`, `--${req.method.toLowerCase()}`, '--admin', '--match-head-commit', req.expectedHeadOid],
      { timeoutMs: 60_000, cwd: settings().scratch },
    );
  } else {
    await graphql(
      `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID!) {
         mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { pullRequest { state } } }`,
      { id: pr.id, method: req.method, oid: req.expectedHeadOid },
    );
  }

  let deletedBranch = false;
  let note: string | undefined;
  if (req.deleteBranch && !pr.deleteBranchOnMerge) {
    if (!pr.headIsSameRepo) note = 'branch is in a fork, not deleted';
    else {
      try {
        await run('gh', ['api', '--hostname', (await settings().host()), '-X', 'DELETE', `repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(pr.head)}`], {
          timeoutMs: 30_000,
          cwd: settings().scratch,
        });
        deletedBranch = true;
      } catch (err) {
        note = `merged, but deleting the branch failed: ${(err as Error).message}`;
      }
    }
  } else if (pr.deleteBranchOnMerge) deletedBranch = true;
  return { merged: true, deletedBranch, note };
}

/** Draft → ready for review (`markPullRequestReadyForReview`). A no-op error if it already is. */
export async function markReady(owner: string, name: string, number: number): Promise<void> {
  const pr = await prDetail(owner, name, number);
  if (pr.state !== 'OPEN') throw new Error('this PR is not open');
  if (!pr.isDraft) throw new Error('this PR is already ready for review');
  await graphql(`mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`, { id: pr.id });
}

export async function setAutoMerge(owner: string, name: string, number: number, enable: boolean, method?: string, expectedHeadOid?: string): Promise<void> {
  const pr = await prDetail(owner, name, number);
  if (!enable) {
    await graphql(`mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`, { id: pr.id });
    return;
  }
  if (!method || !METHODS.has(method)) throw new Error('bad merge method');
  if (!/^[0-9a-f]{40}$/.test(expectedHeadOid ?? '')) throw new Error('bad head commit');
  if (pr.headOid !== expectedHeadOid) throw new Error('the branch has new commits since you loaded the page; reload and check again');
  await graphql(
    `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID!) {
       enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { clientMutationId } }`,
    { id: pr.id, method, oid: expectedHeadOid! },
  );
}
