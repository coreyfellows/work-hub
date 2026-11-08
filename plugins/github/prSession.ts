import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run, worktreesByBranch } from '../../plugin-api/server.ts';
import { settings } from './settings.ts';
import type { PrRef } from './types.ts';

export type { PrRef } from './types.ts';

/**
 * Start a Claude session for a PR, following the ticket-workflow conventions: reuse the worktree
 * that already has the branch checked out (or create one under <worktrees root>/<repo>/<folder>), trust it,
 * and start Claude there as a background job, recorded in the workspace model.
 */

export interface PrSessionResult {
  name: string;
  worktree: string;
  created: boolean;
  launchedIn: 'background';
  workspace: string;
  output: string;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Only characters that are inert inside a double-quoted shell string. */
const safe = (s: string) => s.replace(/[^\p{L}\p{N} :#._/()[\]-]/gu, '').slice(0, 80).trim();

function ticketKey(pr: PrRef): string | null {
  return (pr.branch.match(/[A-Z][A-Z0-9]+-\d+/) ?? pr.title.match(/[A-Z][A-Z0-9]+-\d+/))?.[0] ?? null;
}

export function promptFor(pr: PrRef, wsId: string): string {
  const lines = [
    `You're working on pull request ${pr.url} ("${pr.title}") in ${pr.repo}, branch \`${pr.branch}\`. This worktree has that branch checked out.`,
    '',
  ];
  if (pr.mine) {
    lines.push(
      "This is my PR. Check where it stands: CI checks, unresolved review threads, merge conflicts with the base branch, and whether it's still a draft.",
      'Summarize what needs doing to get it merged, then wait for me before changing or pushing anything.',
    );
  } else {
    lines.push(
      "I've been asked to review this PR. Read the description and the full diff (`gh pr diff`), and any existing review comments.",
      'Give me a review: what it does, then issues ranked by severity with file:line references, then smaller nits.',
      "Don't post anything to GitHub; I'll decide what to submit.",
    );
  }
  // What plugins add to a workspace session's start (e.g. the sibling-session digest), then the rules.
  const { prompts, store } = settings().ctx;
  const context = prompts.fragments('session-context', { workspaceId: wsId, ticketKey: store.getWorkspace(wsId)?.ticketKey ?? null });
  if (context) lines.push('', context);
  lines.push('', ...prompts.workspaceRules(wsId));
  return lines.join('\n');
}

/**
 * The worktree that has `branch` checked out: reuse an existing one, else create `<worktrees>/<repo>/<folder>`
 * (fetching the branch first), and trust it for Claude. Shared by PR sessions and adversarial reviews.
 */
export async function ensureBranchWorktree(repoName: string, repo: string, branch: string, folder: string): Promise<{ worktree: string; created: boolean }> {
  const { paths } = settings().ctx;
  const repoDir = join(paths.reposDir, repoName);
  if (!(await exists(join(repoDir, '.git')))) throw new Error(`No local checkout at ${repoDir}; clone ${repo} there first.`);
  let worktree = (await worktreesByBranch(repoDir)).get(branch) ?? null;
  let created = false;
  if (!worktree) {
    worktree = join(paths.worktreesDir, repoName, folder);
    if (await exists(worktree)) throw new Error(`${worktree} exists but isn't on ${branch}; sort it out by hand.`);
    await run('git', ['-C', repoDir, 'fetch', 'origin', branch], { timeoutMs: 120_000 });
    const hasLocal = await run('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    await run(
      'git',
      hasLocal
        ? ['-C', repoDir, 'worktree', 'add', worktree, branch]
        : ['-C', repoDir, 'worktree', 'add', '--track', '-b', branch, worktree, `origin/${branch}`],
      { timeoutMs: 120_000 },
    );
    created = true;
  }
  // Trust it so `claude --bg` can start there: the ticket-workflow script when that plugin is on, else the core's own.
  if (paths.ticketWorkflowScripts) await run(join(paths.ticketWorkflowScripts, 'trust-worktree.sh'), [worktree]);
  else await settings().ctx.sessions.trustWorktree(worktree);
  return { worktree, created };
}

export async function startPrSession(pr: PrRef): Promise<PrSessionResult> {
  const { ctx, modelMine, modelReview } = settings();
  const jiraBaseUrl = settings().jiraBaseUrl.trim();
  const { addLink, addSession, addWorktree, createWorkspace, findWorkspaceByLink, findWorkspaceByWorktree, setStatus } = ctx.store;
  const repoName = pr.repo.split('/')[1];
  const key = ticketKey(pr);
  const name = safe(pr.mine ? `${key ?? `${repoName}#${pr.number}`}: ${pr.title}` : `Review ${repoName}#${pr.number}: ${pr.title}`);

  const folder = pr.mine ? (key ?? pr.branch.replace(/[^\w.-]+/g, '-')) : `review-${pr.number}`;
  const { worktree, created } = await ensureBranchWorktree(repoName, pr.repo, pr.branch, folder);

  // Record it in the workspace model: your PR joins the workspace that owns its worktree (or gets one);
  // a review gets its own workspace. Either way, a workspace that already links the PR keeps it. Decided before
  // starting, so the prompt can name the workspace.
  const prLabel = `${repoName}#${pr.number}`;
  let wsId = findWorkspaceByLink(pr.url) ?? (pr.mine ? findWorkspaceByWorktree({ path: worktree, repo: pr.repo, branch: pr.branch }) : null);
  const newWorkspace = !wsId;
  if (!wsId) {
    wsId = createWorkspace({
      title: name,
      origin: pr.mine ? 'pr' : 'review',
      ticketKey: pr.mine ? key : null,
      prompt: `${pr.mine ? 'Drive' : 'Review'} ${pr.url}`,
    });
  }

  // Start Claude as a background job: work-hub shows it via `claude logs` (exact colours) and types
  // into it via a pty attach; `claude attach <id>` opens it in any terminal.
  const model = pr.mine ? modelMine : modelReview;
  let started: { shortId: string; sessionId: string };
  try {
    started = await ctx.sessions.startBackground({ cwd: worktree, name, model, prompt: promptFor(pr, wsId), purpose: 'pr-session' });
  } catch (err) {
    if (newWorkspace) setStatus(wsId, 'done'); // don't leave an empty workspace on the board
    throw err;
  }
  const { shortId, sessionId } = started;

  addWorktree(wsId, { repo: pr.repo, path: worktree, branch: pr.branch });
  addSession(wsId, { claudeSessionId: sessionId, role: pr.mine ? 'main' : 'review', name, cwd: worktree });
  addLink(wsId, { kind: 'pr', url: pr.url, label: prLabel });
  if (key && pr.mine && jiraBaseUrl) addLink(wsId, { kind: 'jira', url: `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${key}`, label: key });
  // A new workspace's note: the notes plugin makes it when the workspace's `created` event fires.

  return { name, worktree, created, launchedIn: 'background', workspace: wsId, output: shortId };
}
