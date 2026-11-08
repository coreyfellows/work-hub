import type { Context } from 'hono';
import { readJson, type ServerPluginContext } from '../../plugin-api/server.ts';
import { HTTPException } from 'hono/http-exception';
import { fetchBlob } from './blob.ts';
import { parseBlobUrl } from './blobUrl.ts';
import { hostResolver } from './ghHost.ts';
import { addPrComment, markReady, mergePr, parseRef, prDetail, prFiles, replyToThread, setAutoMerge, setThreadResolved, type MergeRequest } from './prDetail.ts';
import { linkPrsPass } from './prLinks.ts';
import { ensureBranchWorktree, startPrSession } from './prSession.ts';
import { setSettings } from './settings.ts';
import { githubSource } from './source.ts';
import type { GithubData, GithubService, PrRef } from './types.ts';

export default function register(ctx: ServerPluginContext): void {
  // Old env names are still honoured as defaults (WORK_HUB_GH_*, WORK_HUB_PR_MODEL_*, TW_JIRA_BASE_URL).
  const env = process.env;
  // A configured host is used as is; otherwise `gh auth status` is asked on first use (never during startup), and
  // asked again until it names one.
  const host = hostResolver(ctx.config.get<string>('host') ?? env.WORK_HUB_GH_HOST);
  setSettings({
    ctx,
    host,
    scratch: ctx.paths.cacheDir,
    mergedDays: ctx.config.get('mergedDays', Number(env.WORK_HUB_GH_MERGED_DAYS ?? 7)),
    // Getting my own PR merged is usually well-scoped; reviewing someone else's needs more judgment.
    modelMine: ctx.config.get('modelMine', env.WORK_HUB_PR_MODEL_MINE ?? 'sonnet'),
    modelReview: ctx.config.get('modelReview', env.WORK_HUB_PR_MODEL_REVIEW ?? 'opus'),
    get jiraBaseUrl() {
      return ctx.config.get('jiraBaseUrl', env.TW_JIRA_BASE_URL ?? '');
    },
  });

  let latest: GithubData | null = null;
  const openPrs = () => [...(latest?.mine ?? []), ...(latest?.reviewRequested ?? [])];

  const service: GithubService = { host, parseRef, prDetail, prFiles, ensureBranchWorktree, data: () => latest };
  ctx.services.expose('github', service);

  // Link PRs to workspaces after the core's reconcile steps; a change to the PR lists runs a pass too.
  ctx.reconcile.addPass(linkPrsPass(openPrs));

  // The PR page polls these: an unchanged poll is an empty 304.
  ctx.revalidate(['/api/prs/:owner/:repo/:number', '/api/prs/:owner/:repo/:number/files']);

  // --- PR "Start session" / "Review with Claude" (a pr-session job in the header tray) -------------------------
  ctx.app.post('/api/prs/session', async (c) => {
    const pr = await readJson<PrRef>(c);
    if (!pr?.repo || !pr.branch || !pr.number) return c.json({ error: 'repo, branch and number required' }, 400);
    const job = ctx.jobs.start({ kind: 'pr-session', title: `${pr.mine ? 'Starting session' : 'Starting review'}: ${pr.repo.split('/')[1] ?? pr.repo} #${pr.number}` }, async () => {
      const result = await startPrSession(pr);
      void ctx.registry.refresh('claude');
      void ctx.registry.refresh('workspaces');
      return {
        detail: `${result.created ? 'Created' : 'Reused'} ${result.worktree.replace(/^\/Users\/[^/]+/, '~')}`,
        link: { to: `/workspaces/${result.workspace}`, label: 'Open workspace' },
      };
    });
    return c.json({ ok: true, jobId: job.id }, 202);
  });

  // --- PR preview (/prs/:owner/:repo/:number) -------------------------------------------------------------------
  type Ref = NonNullable<ReturnType<typeof parseRef>>;
  const prRoute = (fn: (ref: Ref, c: Context) => Promise<unknown>) => async (c: Context) => {
    const ref = parseRef(c.req.param('owner') ?? '', c.req.param('repo') ?? '', c.req.param('number') ?? '');
    if (!ref) return c.json({ error: 'bad PR reference' }, 400);
    try {
      return c.json((await fn(ref, c)) ?? { ok: true });
    } catch (err) {
      if (err instanceof HTTPException) return err.getResponse(); // readJson's 400, not a GitHub failure
      return c.json({ error: (err as Error).message }, 502);
    }
  };
  const afterPrWrite = () => void ctx.registry.refresh('github').catch(() => {});

  ctx.app.get('/api/prs/:owner/:repo/:number', prRoute((r) => prDetail(r.owner, r.name, r.number)));
  ctx.app.get('/api/prs/:owner/:repo/:number/files', prRoute((r) => prFiles(r.owner, r.name, r.number)));
  ctx.app.post(
    '/api/prs/:owner/:repo/:number/comment',
    prRoute(async (_r, c) => {
      const b = await readJson<{ prId?: string; body?: string }>(c);
      return addPrComment(b.prId, b.body);
    }),
  );
  ctx.app.post(
    '/api/prs/:owner/:repo/:number/threads/reply',
    prRoute(async (_r, c) => {
      const b = await readJson<{ threadId?: string; body?: string }>(c);
      return replyToThread(b.threadId, b.body);
    }),
  );
  ctx.app.post(
    '/api/prs/:owner/:repo/:number/threads/resolve',
    prRoute(async (_r, c) => {
      const b = await readJson<{ threadId?: string; resolved?: boolean }>(c);
      await setThreadResolved(b.threadId, b.resolved !== false);
      afterPrWrite();
      return { ok: true };
    }),
  );
  ctx.app.post(
    '/api/prs/:owner/:repo/:number/merge',
    prRoute(async (r, c) => {
      const result = await mergePr(r.owner, r.name, r.number, await readJson<MergeRequest>(c));
      afterPrWrite();
      return result;
    }),
  );
  ctx.app.post(
    '/api/prs/:owner/:repo/:number/ready',
    prRoute(async (r) => {
      await markReady(r.owner, r.name, r.number);
      afterPrWrite();
      return { ok: true };
    }),
  );
  ctx.app.post(
    '/api/prs/:owner/:repo/:number/auto-merge',
    prRoute(async (r, c) => {
      const b = await readJson<{ enable?: boolean; method?: string; expectedHeadOid?: string }>(c);
      await setAutoMerge(r.owner, r.name, r.number, b.enable !== false, b.method, b.expectedHeadOid);
      afterPrWrite();
      return { ok: true };
    }),
  );

  // --- A file at a ref, for GitHub file links opened in the app (blob URLs in Markdown) ---------------------------
  ctx.app.get('/api/plugins/github/blob', async (c) => {
    const link = parseBlobUrl(c.req.query('url'));
    if (!link) return c.json({ error: 'not a GitHub file link' }, 400);
    try {
      return c.json(await fetchBlob(link));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // Sources and listeners can't be taken back if register() throws, so they go last.
  ctx.registry.on('change', (s) => {
    if (s.id !== 'github') return;
    latest = (s.data as GithubData | null) ?? latest;
    ctx.reconcile.run();
  });
  ctx.registry.add(githubSource(ctx.config.get('intervalMs', Number(env.WORK_HUB_GH_INTERVAL_MS ?? 120_000))));
}
