import type { ServerPluginContext } from '../../../plugin-api/server.ts';
import { ansiToHtml, readJson } from '../../../plugin-api/server.ts';
import { answerKeys, screenShowsQuestion, type AnswerInput } from './answer.ts';

export default function register(ctx: ServerPluginContext): void {
  /**
   * Answer a pending AskUserQuestion form by typing the menu keystrokes (see answerKeys). Refuses unless that
   * exact question is still unanswered and visible on screen, so a stale form can't misfire.
   */
  ctx.app.post('/api/sessions/:id/answer', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    if (s.kind !== 'background') return c.json({ error: 'only background sessions can be answered from here' }, 409);
    const body = await readJson<{ toolUseId: string; answers: AnswerInput[] }>(c);
    const ask = await ctx.sessions.pendingQuestion(s.sessionId, body.toolUseId);
    if (!ask?.questions) return c.json({ error: 'that question has already been answered' }, 409);
    const qs = ask.questions;
    if (!Array.isArray(body.answers) || body.answers.length !== qs.length) return c.json({ error: 'answer every question' }, 400);

    const raw = await ctx.exec.run('claude', ['logs', s.shortId], { timeoutMs: 10_000 }).catch(() => '');
    const screen = (await ansiToHtml(raw, 80)).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!screenShowsQuestion(screen, qs)) {
      return c.json({ error: "the question isn't on Claude's screen right now; answer it from the terminal keys instead" }, 409);
    }

    const plan = answerKeys(qs, body.answers, ctx.sessions.KEY_BYTES.Enter, ctx.sessions.KEY_BYTES.Tab);
    if (!plan.ok) return c.json({ error: plan.error }, plan.status);
    try {
      await ctx.sessions.typeSequence(s.shortId, plan.chunks);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    void ctx.registry.refresh('claude');
    return c.json({ ok: true });
  });
}
