import type { Context } from 'hono';
import { join } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { readJson, type ServerPluginContext } from '../../plugin-api/server.ts';
import { createScrutinizer, RUN_PREFIX, UserError, type GithubLike, type PrRef } from './scrutinize.ts';
import { watchRequests, type Respond } from './requests.ts';
import { SummaryStore } from './store.ts';

const BASE = '/api/plugins/scrutinize-pr/prs/:owner/:repo/:number';

export default function register(ctx: ServerPluginContext): void {
  const root = join(ctx.paths.pluginState, 'prs');
  const github = (): GithubLike | undefined => {
    try {
      return ctx.services.get<GithubLike>('github');
    } catch {
      return undefined;
    }
  };
  const s = createScrutinizer({
    store: new SummaryStore(root),
    github,
    run: (cmd, args, opts) => ctx.exec.run(cmd, args, opts),
    reposDir: ctx.paths.reposDir,
    scratchDir: join(ctx.paths.pluginCache, 'scratch'),
    model: () => ctx.config.get('model', 'opus'),
  });

  // The runs sit in the repo's clone, which may be a recorded worktree: listed, reconcile could adopt them.
  ctx.sessions.hide((x) => !!x.name?.startsWith(RUN_PREFIX));
  // A session can be pointed at a summary (file links open it in the viewer).
  ctx.files.addRoot(root);

  const label = (r: PrRef) => `${r.repo}#${r.number}`;
  const link = (r: PrRef) => ({ to: `/prs/${r.owner}/${r.repo}/${r.number}#summary`, label: 'Open summary' });

  async function runGenerate(r: PrRef, progress: (d: string) => void) {
    const { path } = await s.generate(r, progress);
    return { detail: `saved to ${path.replace(/^\/Users\/[^/]+/, '~')}`, link: link(r) };
  }
  async function runUpdate(r: PrRef, progress: (d: string) => void) {
    const out = await s.update(r, progress);
    const detail = out.upToDate
      ? 'already up to date'
      : `${out.edits ? `${out.edits} ${out.edits === 1 ? 'section' : 'sections'} changed` : 'nothing in the guide changed'}${out.skipped.length ? ` (skipped edits to unknown sections: ${out.skipped.join(', ')})` : ''}`;
    return { detail, link: link(r) };
  }
  async function runAnswer(r: PrRef, threadId: string, progress: (d: string) => void) {
    const out = await s.answer(r, threadId, progress);
    const how = out?.kind === 'addendum' ? 'added to the section' : out?.kind === 'rewrite' ? 'rewrote the section' : 'replied';
    return { detail: out ? how : 'nothing left to answer', link: link(r) };
  }
  // The /work-hub:scrutinize-pr skill is `skills/` in the manifest: the core offers it while this plugin is active.

  /** A request from the skill (requests.ts): start the same job as the tab's button, answer as it goes. */
  async function handleRequest(raw: unknown, respond: Respond): Promise<void> {
    const gh = github();
    if (!gh) return respond({ status: 'failed', error: 'the github plugin is off' });
    const q = raw as { host?: unknown; owner?: unknown; repo?: unknown; number?: unknown };
    const ref = gh.parseRef(String(q.owner ?? ''), String(q.repo ?? ''), String(q.number ?? ''));
    if (!ref) return respond({ status: 'failed', error: 'bad PR reference' });
    const host = await gh.host();
    if (typeof q.host === 'string' && q.host && q.host.toLowerCase() !== host.toLowerCase()) {
      return respond({ status: 'failed', error: `that PR is on ${q.host}, but work-hub's github plugin uses ${host}` });
    }
    const r: PrRef = { owner: ref.owner, repo: ref.name, number: ref.number };
    const where = { url: `${ctx.publicOrigin}${link(r).to}`, path: await s.pathFor(r) };
    if (s.isGenerating(r)) return respond({ status: 'running', ...where });
    // The final answer waits for "started" to be written, so a quick failure can't be overwritten by it.
    let started!: () => void;
    const startedWritten = new Promise<void>((ok) => (started = ok));
    const job = ctx.jobs.start({ kind: 'scrutinize', title: `Summarize ${label(r)}`, payload: r }, async (progress) => {
      try {
        const out = await runGenerate(r, progress);
        await startedWritten;
        await respond({ status: 'done', ...where });
        return out;
      } catch (e) {
        await startedWritten;
        await respond({ status: 'failed', error: (e as Error).message, ...where });
        throw e;
      }
    });
    await respond({ status: 'started', jobId: job.id, ...where }).finally(started);
  }
  ctx.onStart(async () => {
    await watchRequests(join(ctx.paths.pluginState, 'requests'), handleRequest, (e) => ctx.log.warn('requests:', (e as Error).message));
  });

  ctx.jobs.registerResumer('scrutinize', (progress, job) => runGenerate(job.payload as PrRef, progress));
  ctx.jobs.registerResumer('scrutinize-update', (progress, job) => runUpdate(job.payload as PrRef, progress));
  ctx.jobs.registerResumer('scrutinize-ask', (progress, job) => {
    const p = job.payload as PrRef & { threadId: string };
    return runAnswer(p, p.threadId, progress);
  });

  /** Validated `:owner/:repo/:number`, or a 4xx/5xx answer. */
  const route = (fn: (r: PrRef, c: Context) => Promise<Response>) => async (c: Context) => {
    const gh = github();
    if (!gh) return c.json({ error: 'the github plugin is off' }, 503);
    const ref = gh.parseRef(c.req.param('owner') ?? '', c.req.param('repo') ?? '', c.req.param('number') ?? '');
    if (!ref) return c.json({ error: 'bad PR reference' }, 400);
    try {
      return await fn({ owner: ref.owner, repo: ref.name, number: ref.number }, c);
    } catch (e) {
      if (e instanceof HTTPException) return e.getResponse();
      if (e instanceof UserError) return c.json({ error: e.message }, 400);
      return c.json({ error: (e as Error).message }, 502);
    }
  };

  // The tab polls this while something is being written: an unchanged answer is an empty 304.
  ctx.revalidate([BASE]);
  ctx.app.get(
    BASE,
    route(async (r, c) => {
      const head = c.req.query('head') ?? '';
      return c.json(await s.view(r, /^[0-9a-f]{40}$/.test(head) ? head : null));
    }),
  );

  ctx.app.post(
    `${BASE}/generate`,
    route(async (r, c) => {
      await readJson(c);
      if (s.isGenerating(r)) return c.json({ error: 'this summary is already being written or updated' }, 409);
      const job = ctx.jobs.start({ kind: 'scrutinize', title: `Summarize ${label(r)}`, payload: r }, (progress) => runGenerate(r, progress));
      return c.json({ ok: true, jobId: job.id }, 202);
    }),
  );

  ctx.app.post(
    `${BASE}/update`,
    route(async (r, c) => {
      await readJson(c);
      if (s.isGenerating(r)) return c.json({ error: 'this summary is already being written or updated' }, 409);
      const job = ctx.jobs.start({ kind: 'scrutinize-update', title: `Update summary of ${label(r)}`, payload: r }, (progress) => runUpdate(r, progress));
      return c.json({ ok: true, jobId: job.id }, 202);
    }),
  );

  ctx.app.post(
    `${BASE}/ask`,
    route(async (r, c) => {
      const b = await readJson<{ threadId?: unknown; sectionId?: unknown; quote?: unknown; question?: unknown }>(c);
      const t = await s.ask(r, b);
      const job = ctx.jobs.start({ kind: 'scrutinize-ask', title: `Question on ${label(r)}`, payload: { ...r, threadId: t.id } }, (progress) => runAnswer(r, t.id, progress));
      return c.json({ ok: true, jobId: job.id, threadId: t.id }, 202);
    }),
  );

  ctx.app.post(
    `${BASE}/threads/remove`,
    route(async (r, c) => {
      const b = await readJson<{ threadId?: unknown }>(c);
      if (typeof b.threadId !== 'string' || !b.threadId) return c.json({ error: 'threadId required' }, 400);
      await s.removeThread(r, b.threadId);
      return c.json({ ok: true });
    }),
  );
}
