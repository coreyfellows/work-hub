import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workspace } from '../../plugin-api/server.ts';
import { loadReviewers, runReviewer, type Reviewer } from './reviewers.ts';
import { findReviewGuidance, type ReviewGuidance } from './reviewGuidance.ts';
import { settings } from './settings.ts';

/**
 * Adversarial review of a branch, in the background. The reviewers (reviewers.ts: Claude fable/opus/sonnet
 * unless the reviewers file says otherwise) attack the diff in parallel as headless runs owned by the
 * server job, not as sessions. If the repo has review guidance, one reviewer follows it instead. When they finish, their
 * findings are saved as a report and ONE new session starts in the workspace with them, to verify and address them.
 */

const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'branch';
const running = new Set<string>();

export interface ReviewerOutcome {
  id: string;
  label: string;
  ok: boolean;
  /** Findings (Markdown) when ok, else why it failed. */
  text: string;
  secs: number;
}

/** The saved report: every reviewer's findings, or why it failed. */
export function reportMarkdown(i: { branch: string; baseRef: string; guidance: ReviewGuidance | null; outcomes: ReviewerOutcome[] }): string {
  return [
    `# Adversarial review of \`${i.branch}\` against \`${i.baseRef}\``,
    '',
    i.guidance ? `Reviewed following the repo's guidance in \`${i.guidance.path}\`.` : `Reviewers: ${i.outcomes.map((o) => `${o.label}${o.ok ? '' : ' (failed)'}`).join(', ')}.`,
    '',
    ...i.outcomes.flatMap((o) => [`## ${o.label}`, '', o.ok ? o.text : `**Failed after ${o.secs}s:** ${o.text}`, '']),
  ].join('\n');
}

/** The task for the one session that addresses the findings (before the workspace context is prefixed). */
export function addressTask(i: { branch: string; baseRef: string; worktree: string; reportPath: string; prUrl?: string | null; prHeadOid?: string | null; outcomes: ReviewerOutcome[] }): string {
  const ok = i.outcomes.filter((o) => o.ok);
  const failed = i.outcomes.filter((o) => !o.ok);
  return [
    `An adversarial review of the branch \`${i.branch}\` (this worktree, ${i.worktree}) against \`${i.baseRef}\` has finished${i.prUrl ? `; the branch is ${i.prUrl}` : ''}. Your job is to address its findings.`,
    '',
    `The reviews, from ${ok.map((o) => o.label).join(', ')}, are combined in ${i.reportPath}. Read all of it first.${failed.length ? ` These reviewers failed and are not in it: ${failed.map((o) => `${o.label} (${o.text.slice(0, 120)})`).join('; ')}.` : ''}`,
    ...(i.prHeadOid ? [`The PR's head is ${i.prHeadOid}; if \`git rev-parse HEAD\` differs, say so before you change anything.`] : []),
    '',
    'Then:',
    '1. Merge duplicates across reviewers (a finding several models agree on is more likely real).',
    '2. Verify every finding against the code: open what it points at, check the callers and tests. Reviewers are adversarial and some findings will be wrong; drop those, with a one-line reason each.',
    '3. For each finding that holds, work out the change you would make (the files, the approach, any test), and note any real alternative or trade-off. Do NOT edit anything yet: no file changes, no commits, no pushes, nothing posted to a PR.',
    '4. Ask me which changes to make with the AskUserQuestion tool, so I can answer inline. One question per finding (up to 4 per call; batch the rest in further calls, most severe first). Each question must stand on its own: the finding, `file:line`, why it matters, and the change you propose. Put your recommended option first, marked "(Recommended)", and always include a "Do nothing" option (skip this finding). Offer an alternative approach as another option where there is one.',
    '5. Only after I have answered, make exactly the changes I approved, nothing more. Add or update tests where it fits and run the repo’s own checks. Still do not push or touch the PR.',
    '',
    'Finish by telling me what you changed, what you skipped, and the check results.',
  ].join('\n');
}

export interface ReviewResult {
  sessionId: string;
  shortId: string;
  name: string;
  reportPath: string;
  mode: 'guidance' | 'exhaustive';
  reviewers: string[];
  failed: string[];
}

/**
 * Where a review has got to, saved with its job after every step so a server restart resumes it (the job's payload).
 * What was asked comes first; `run` appears once the reviewers are decided and holds everything needed to carry on:
 * reviewers already finished are kept, the rest are run again from scratch, and the session is only started once
 * (its id is saved the moment it exists).
 */
export interface ReviewState {
  /** Null until a PR review has found or made its workspace. */
  workspaceId: string | null;
  path: string | null;
  prUrl?: string | null;
  prHeadOid?: string | null;
  base?: string | null;
  /** Set for a review started from a PR page: the part before `workspaceId` is known is redone on resume. */
  pr?: { owner: string; name: string; number: number };
  run?: {
    branch: string;
    baseRef: string;
    guidance: ReviewGuidance | null;
    reviewers: Reviewer[];
    reportPath: string;
    outcomes: ReviewerOutcome[];
    newSessionId?: string;
    newShortId?: string;
    sessionName?: string;
  };
}

export const newReviewState = (init: Pick<ReviewState, 'workspaceId' | 'path' | 'prUrl' | 'pr'>): ReviewState => ({ ...init });

/** Reviewers that haven't produced an outcome yet. */
export const pendingReviewers = (run: NonNullable<ReviewState['run']>): Reviewer[] => run.reviewers.filter((r) => !run.outcomes.some((o) => o.id === r.id));

/**
 * Review one of the workspace's worktrees (`state.path`), or resume `state`. Resolves when the reviewers are done and the
 * addressing session has started (a long wait: run it as a job). `save` is called whenever `state` changes.
 */
export async function startReview(
  ws: Workspace,
  state: ReviewState,
  progress: (detail: string) => void = () => {},
  save: (st: ReviewState) => void = () => {},
): Promise<ReviewResult> {
  const { ctx, model, dir, reviewersFile } = settings();
  const { run } = ctx.exec;
  const { logEvent, addSession } = ctx.store;
  const wt = ws.worktrees.find((t) => t.path === state.path);
  if (!wt) throw new Error("that isn't one of this workspace's worktrees");
  if (running.has(wt.path)) throw new Error('a review of this worktree is already running');
  running.add(wt.path);
  try {
    if (!state.run) {
      const baseName = (state.base ?? wt.baseBranch ?? '').replace(/^origin\//, '');
      // Best effort: a stale origin/<base> would make the diff include other people's merged work.
      if (baseName) await run('git', ['-C', wt.path, 'fetch', 'origin', baseName], { timeoutMs: 120_000 }).catch(() => {});
      const base = await ctx.git.baseRef(wt.path, baseName || null);
      if (!base) throw new Error("couldn't find this branch's base (none recorded, and no origin/HEAD, main or master)");
      const branch = wt.branch ?? (await run('git', ['-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim(), () => 'HEAD'));
      const guidance = await findReviewGuidance(wt.path);
      const reviewers: Reviewer[] = guidance
        ? [{ id: 'guided', label: `Claude ${model} (repo guidance)`, model, command: null, timeoutMs: 30 * 60_000 }]
        : await loadReviewers(reviewersFile);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = join(dir, `${ws.id}-${slug(branch)}-${stamp}.md`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      state.run = { branch, baseRef: base, guidance, reviewers, reportPath, outcomes: [] };
      save(state);
      logEvent(ws.id, 'review-started', `${branch} → ${base} (${guidance ? `guidance: ${guidance.path}` : reviewers.map((r) => r.id).join(', ')})`);
    }
    const r = state.run;

    if (!r.newSessionId) {
      const pending = pendingReviewers(r);
      const tick = () => progress(`${r.outcomes.length} of ${r.reviewers.length} reviewers finished (${r.reviewers.map((x) => x.id).join(', ')})`);
      tick();
      await Promise.all(
        pending.map(async (rv) => {
          const started = Date.now();
          let o: ReviewerOutcome;
          try {
            o = { id: rv.id, label: rv.label, ok: true, text: await runReviewer(rv, { worktree: wt.path, baseRef: r.baseRef, guidance: r.guidance }), secs: 0 };
          } catch (e) {
            o = { id: rv.id, label: rv.label, ok: false, text: (e as Error).message, secs: 0 };
          }
          o.secs = Math.round((Date.now() - started) / 1000);
          r.outcomes.push(o);
          save(state);
          tick();
        }),
      );
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(r.reportPath, reportMarkdown({ branch: r.branch, baseRef: r.baseRef, guidance: r.guidance, outcomes: r.outcomes }), { mode: 0o600 });
      if (!r.outcomes.some((o) => o.ok)) throw new Error(`every reviewer failed (${r.outcomes.map((o) => `${o.id}: ${o.text.slice(0, 100)}`).join('; ')}); see ${r.reportPath}`);

      progress('reviewers finished; starting the session to address the findings');
      const name = `Address review: ${r.branch}`.slice(0, 80);
      const task = addressTask({ branch: r.branch, baseRef: r.baseRef, worktree: wt.path, reportPath: r.reportPath, prUrl: state.prUrl, prHeadOid: state.prHeadOid, outcomes: r.outcomes });
      const s = await ctx.sessions.startBackground({ cwd: wt.path, name, model, prompt: await ctx.prompts.workspaceContext(ws, task), purpose: 'review' });
      // Saved before anything else, so a restart from here can't start a second session.
      Object.assign(r, { newSessionId: s.sessionId, newShortId: s.shortId, sessionName: name });
      save(state);
    }

    // The session is running: recording it is idempotent, so a resume just repeats it.
    addSession(ws.id, { claudeSessionId: r.newSessionId!, role: 'main', name: r.sessionName, cwd: wt.path });
    logEvent(ws.id, 'review-done', `${r.newShortId} addresses it; report ${r.reportPath}`);
    return {
      sessionId: r.newSessionId!,
      shortId: r.newShortId!,
      name: r.sessionName ?? '',
      reportPath: r.reportPath,
      mode: r.guidance ? 'guidance' : 'exhaustive',
      reviewers: r.outcomes.filter((o) => o.ok).map((o) => o.id),
      failed: r.outcomes.filter((o) => !o.ok).map((o) => o.id),
    };
  } finally {
    running.delete(wt.path);
  }
}

/** What adversarial review uses of the github plugin's `github` service (its `GithubService` type; not imported: plugins don't import each other). */
export interface GithubForReview {
  parseRef(owner: string, name: string, number: string): { owner: string; name: string; number: number } | null;
  prDetail(owner: string, name: string, number: number): Promise<{ url: string; title: string; head: string; base: string; headOid: string; headIsSameRepo: boolean }>;
  ensureBranchWorktree(repoName: string, repo: string, branch: string, folder: string): Promise<{ worktree: string; created: boolean }>;
}

/** The github plugin's service, or undefined while it is off (PR reviews then can't start). Looked up on each use. */
export function githubService(): GithubForReview | undefined {
  try {
    return settings().ctx.services.get<GithubForReview>('github');
  } catch {
    return undefined;
  }
}

/**
 * Review a PR from its page: the worktree that has its branch (or a new `review-<n>` one), in the workspace that
 * already links the PR or owns that worktree, else a new "review" workspace. Once that is settled it is saved in
 * `state` and the rest is `startReview`.
 */
export async function startPrReview(
  state: ReviewState,
  progress: (detail: string) => void = () => {},
  save: (st: ReviewState) => void = () => {},
): Promise<ReviewResult & { workspace: string }> {
  const { owner, name, number } = state.pr!;
  const { findWorkspaceByLink, findWorkspaceByWorktree, createWorkspace, addWorktree, addLink, getWorkspace, setStatus } = settings().ctx.store;
  const gh = githubService();
  if (!gh) throw new Error('the github plugin is off');
  const d = await gh.prDetail(owner, name, number);
  if (!d.headIsSameRepo) throw new Error("this PR is from a fork; check its branch out by hand and use the worktree's review button");
  const repo = `${owner}/${name}`;
  const { worktree } = await gh.ensureBranchWorktree(name, repo, d.head, `review-${number}`);

  let wsId = findWorkspaceByLink(d.url) ?? findWorkspaceByWorktree({ path: worktree, repo, branch: d.head });
  const created = !wsId;
  if (!wsId) wsId = createWorkspace({ title: `Review ${name}#${number}: ${d.title}`.slice(0, 100), origin: 'review', prompt: `Adversarial review of ${d.url}` });
  addWorktree(wsId, { repo, path: worktree, branch: d.head, baseBranch: d.base });
  addLink(wsId, { kind: 'pr', url: d.url, label: `${name}#${number}` });
  Object.assign(state, { workspaceId: wsId, path: worktree, prUrl: d.url, prHeadOid: d.headOid, base: d.base });
  save(state);
  try {
    return { ...(await startReview(getWorkspace(wsId)!, state, progress, save)), workspace: wsId };
  } catch (err) {
    if (created) setStatus(wsId, 'done'); // don't leave an empty workspace on the board
    throw err;
  }
}
