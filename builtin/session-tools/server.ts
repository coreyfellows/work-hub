import { join } from 'node:path';
import type { JobCtx, ServerPluginContext } from '../../plugin-api/server.ts';
import { handOff, newHandoffState, validHandoffModel, type HandoffState } from './handoff.ts';
import { newSession } from './sessions.ts';
import { setSettings } from './settings.ts';

export default function register(ctx: ServerPluginContext): void {
  // Read per use, so a change in Settings applies to the next session or handoff with no restart.
  setSettings({
    ctx,
    // Default for sessions started by hand from a workspace (the form lets you pick another).
    get sessionModel() {
      return ctx.config.get('sessionModel', 'opus') as string;
    },
    // "Auto" on + New session: a quick headless run rates the task and picks the model and name (sessionPlan.ts).
    get plannerModel() {
      return ctx.config.get('plannerModel', 'haiku') as string;
    },
    get plannerTimeoutMs() {
      return ctx.config.get('plannerTimeoutMs', 60_000) as number;
    },
    get handoffDir() {
      return ctx.config.get('handoffDir', '') || join(ctx.paths.stateDir, 'handoffs');
    },
    // The brief is written by a headless fork of the session (full context, no tools); this caps how long that may take.
    get summaryTimeoutMs() {
      return ctx.config.get('summaryTimeoutMs', 5 * 60_000) as number;
    },
  });

  const refreshModel = () => void ctx.registry.refresh('workspaces').catch(() => {});

  /** Run or resume a handoff job from its saved state. */
  async function runHandoff(job: JobCtx) {
    const state = job.payload as HandoffState;
    const ws = ctx.store.getWorkspace(state.workspaceId);
    const s = await ctx.sessions.find(state.sessionId);
    if (!ws || !s) throw new Error(`the ${!ws ? 'workspace' : 'session'} is gone`);
    const result = await handOff(ws, s, state, (st) => job.setPayload({ ...st }));
    refreshModel();
    await ctx.registry.refresh('claude').catch(() => {});
    const why = result.auto ? [result.auto.difficulty, result.auto.reason].filter(Boolean).join(': ') : '';
    return { detail: `Fresh session on ${result.model}${why ? ` (${why})` : ''}; the old one is stopped.`, link: { to: `/sessions/${result.sessionId}`, label: 'Open new session' } };
  }
  // Registered while plugins load, before the core reopens the jobs store, so a handoff a restart cut short carries on.
  ctx.jobs.registerResumer('handoff', (_progress, job) => runHandoff(job));

  /** Summarize a workspace session into a brief, start a fresh session with it, and stop the old one. */
  ctx.app.post('/api/workspaces/:id/sessions/:sid/handoff', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    const s = await ctx.sessions.find(c.req.param('sid'));
    if (!ws || !s) return c.json({ error: 'unknown workspace or session' }, 404);
    const { note, model } = await c.req.json<{ note?: string; model?: string }>().catch(() => ({ note: undefined, model: undefined }));
    if (typeof model === 'string' && !validHandoffModel(model)) return c.json({ error: `unknown model: ${model}` }, 400);
    const state = newHandoffState(ws.id, s.sessionId, typeof note === 'string' ? note : '', typeof model === 'string' ? model : 'same');
    // A minute or two: runs as a job (the header tray follows it) so the page isn't held up. Its state is saved as it
    // goes, so a server restart resumes it (registerResumer above).
    const job = ctx.jobs.start({ kind: 'handoff', title: `Handing off ${s.name}`, workspaceId: ws.id, payload: state }, (_progress, job) => runHandoff(job));
    return c.json({ ok: true, jobId: job.id }, 202);
  });

  /** Start a new background session in the workspace, its prompt prefixed with what the workspace is about. */
  ctx.app.post('/api/workspaces/:id/sessions/new', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    const body = await c.req.json<{ prompt?: string; cwd?: string; model?: string; name?: string }>().catch(() => ({}) as Record<string, unknown>);
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const input = { prompt: str(body.prompt) ?? '', cwd: str(body.cwd), model: str(body.model), name: str(body.name) };
    if (!input.prompt.trim()) return c.json({ error: 'a prompt is required' }, 400);
    // Picking a model and name takes ~10s, then the session starts: a job, so the form closes at once.
    const label = input.name || input.prompt.trim().replace(/\s+/g, ' ').slice(0, 40);
    const job = ctx.jobs.start({ kind: 'new-session', title: `Starting session: ${label}`, workspaceId: ws.id }, async () => {
      const result = await newSession(ws, input);
      refreshModel();
      await ctx.registry.refresh('claude').catch(() => {});
      const why = result.auto ? [result.auto.difficulty, result.auto.reason].filter(Boolean).join(': ') : '';
      return { detail: `${result.name} on ${result.model}${why ? ` (${why})` : ''}`, link: { to: `/sessions/${result.sessionId}`, label: 'Open session' } };
    });
    return c.json({ ok: true, jobId: job.id }, 202);
  });
}
