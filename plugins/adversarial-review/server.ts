import { join } from 'node:path';
import type { JobCtx, ServerPluginContext } from '../../plugin-api/server.ts';
import { githubService, newReviewState, startPrReview, startReview, type ReviewResult, type ReviewState } from './review.ts';
import { REVIEWER_RUN_PREFIX } from './reviewers.ts';
import { setSettings } from './settings.ts';

export default function register(ctx: ServerPluginContext): void {
  // Old env names are still honoured as defaults (WORK_HUB_REVIEW_MODEL, WORK_HUB_REVIEW_DIR, WORK_HUB_REVIEWERS_FILE).
  const env = process.env;
  const dir = ctx.config.get('dir', env.WORK_HUB_REVIEW_DIR ?? join(ctx.paths.stateDir, 'reviews'));
  setSettings({
    ctx,
    model: ctx.config.get('model', env.WORK_HUB_REVIEW_MODEL ?? 'opus'),
    dir,
    reviewersFile: ctx.config.get('reviewersFile', env.WORK_HUB_REVIEWERS_FILE ?? join(ctx.paths.configDir, 'reviewers.json')),
  });

  // Reviewers run headless inside a recorded worktree: listed, reconcile would adopt them into the workspace.
  ctx.sessions.hide((s) => !!s.name?.startsWith(REVIEWER_RUN_PREFIX));
  // The addressing session is pointed at its report: let the file viewer open it.
  ctx.files.addRoot(dir);

  /** Run or resume a review job from its saved state (a PR review whose workspace isn't settled yet redoes that part). */
  async function runReviewJob(progress: (detail: string) => void, job: JobCtx) {
    const state = job.payload as ReviewState;
    const save = (st: ReviewState) => job.setPayload(structuredClone(st));
    let result: ReviewResult;
    const ws = state.workspaceId ? ctx.store.getWorkspace(state.workspaceId) : null;
    if (state.pr && !ws) result = await startPrReview(state, progress, save);
    else if (ws) result = await startReview(ws, state, progress, save);
    else throw new Error('the workspace is gone');
    void ctx.registry.refresh('claude');
    void ctx.registry.refresh('workspaces');
    const how = result.mode === 'guidance' ? "followed the repo's review guidance" : `reviewers: ${result.reviewers.join(', ')}`;
    return {
      detail: `${how}${result.failed.length ? `; failed: ${result.failed.join(', ')}` : ''}; report: ${result.reportPath.replace(/^\/Users\/[^/]+/, '~')}`,
      link: { to: `/sessions/${result.sessionId}`, label: 'Open session' },
    };
  }
  ctx.jobs.registerResumer('review', (progress, job) => runReviewJob(progress, job));

  /** Adversarial review of one of the workspace's worktrees: a new session in the workspace (see review.ts). */
  ctx.app.post('/api/workspaces/:id/reviews', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    const body = await c.req.json<{ path?: string; prUrl?: string }>().catch(() => ({}) as Record<string, unknown>);
    const path = typeof body.path === 'string' ? body.path : '';
    const wt = ws.worktrees.find((t) => t.path === path);
    if (!wt) return c.json({ error: "that isn't one of this workspace's worktrees" }, 400);
    const state = newReviewState({ workspaceId: ws.id, path, prUrl: typeof body.prUrl === 'string' ? body.prUrl : null });
    const job = ctx.jobs.start({ kind: 'review', title: `Adversarial review: ${wt.branch ?? wt.repo}`, workspaceId: ws.id, payload: state }, (progress, j) => runReviewJob(progress, j));
    return c.json({ ok: true, jobId: job.id }, 202);
  });

  /** Adversarial review of a PR from its page: finds or creates its worktree and workspace, then starts the review session. */
  ctx.app.post('/api/prs/review', async (c) => {
    const body = await c.req.json<{ owner?: string; repo?: string; number?: number }>().catch(() => ({}) as Record<string, unknown>);
    // Resolved per request: the github plugin may be off (or loaded after this one).
    const gh = githubService();
    if (!gh) return c.json({ error: 'the github plugin is off' }, 503);
    const ref = gh.parseRef(String(body.owner ?? ''), String(body.repo ?? ''), String(body.number ?? ''));
    if (!ref) return c.json({ error: 'bad PR reference' }, 400);
    const state = newReviewState({ workspaceId: null, path: null, pr: { owner: ref.owner, name: ref.name, number: ref.number } });
    const job = ctx.jobs.start({ kind: 'review', title: `Adversarial review: ${ref.name}#${ref.number}`, payload: state }, (progress, j) => runReviewJob(progress, j));
    return c.json({ ok: true, jobId: job.id }, 202);
  });
}
