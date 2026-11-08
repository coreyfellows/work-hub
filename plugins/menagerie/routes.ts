// The cast's routes (all behind the core's guard). Slow work (generation) answers 202 { jobId } and runs as a job;
// the rest acts on the cast file at once.
import type { Hono } from 'hono';
import { readJson } from '../../plugin-api/server.ts';
import { LIMITS } from './cast.ts';
import type { CastStore } from './castStore.ts';
import type { Generator, Part } from './generate.ts';

export const BASE = '/api/plugins/menagerie';
const PARTS: Part[] = ['all', 'portrait', 'lines', 'motion'];
const FEEDBACK_MAX = 300;

const bad = (error: string) => ({ error });
const feedbackOk = (f: unknown): f is string | undefined => f === undefined || (typeof f === 'string' && f.length <= FEEDBACK_MAX);
const feedbackOf = (f: string | undefined) => (f?.trim() ? f.trim() : undefined);

export function registerRoutes(app: Hono, deps: { gen: Generator; store: CastStore }): void {
  const { gen, store } = deps;

  app.post(`${BASE}/characters`, async (c) => {
    const b = await readJson(c);
    if (typeof b.named !== 'string' || !b.named.trim() || b.named.length > LIMITS.named) return c.json(bad(`named: 1–${LIMITS.named} characters`), 400);
    if (b.kind !== 'play' && b.kind !== 'inspired') return c.json(bad('kind: play or inspired'), 400);
    if (!feedbackOk(b.feedback)) return c.json(bad(`feedback: at most ${FEEDBACK_MAX} characters`), 400);
    return c.json(gen.add(b.named.trim(), b.kind, feedbackOf(b.feedback)), 202);
  });

  app.post(`${BASE}/characters/:id/regenerate`, async (c) => {
    const b = await readJson(c);
    if (!PARTS.includes(b.part as Part)) return c.json(bad(`part: one of ${PARTS.join(', ')}`), 400);
    if (!feedbackOk(b.feedback)) return c.json(bad(`feedback: at most ${FEEDBACK_MAX} characters`), 400);
    const r = await gen.regenerate(c.req.param('id'), b.part as Part, feedbackOf(b.feedback));
    if ('error' in r) return r.error === 'busy' ? c.json(bad('already being regenerated'), 409) : c.json(bad('unknown character'), 404);
    return c.json(r, 202);
  });

  app.post(`${BASE}/characters/:id/undo`, async (c) => {
    const restored = await store.undo(c.req.param('id'));
    return restored ? c.json({ ok: true }) : c.json(bad('nothing to undo'), 404);
  });

  app.delete(`${BASE}/characters/:id`, async (c) => {
    // Removing a character mid-reroll would leave the job to fail; wait for it instead.
    if (gen.isBusy(c.req.param('id'))) return c.json(bad('a reroll is running for this character; remove it when it finishes'), 409);
    return (await store.remove(c.req.param('id'))) ? c.json({ ok: true }) : c.json(bad('unknown character'), 404);
  });

  app.get(`${BASE}/export`, async (c) => {
    c.header('content-disposition', 'attachment; filename="menagerie-cast.json"');
    return c.json(await store.read());
  });

  app.post(`${BASE}/import`, async (c) => {
    const b = await readJson(c);
    if (b.mode !== 'replace' && b.mode !== 'merge') return c.json(bad('mode: replace or merge'), 400);
    try {
      return c.json(await store.importCast(b.cast, b.mode));
    } catch (err) {
      return c.json(bad((err as Error).message), 400);
    }
  });

  app.get(`${BASE}/pending`, (c) => c.json(gen.pending()));
}
