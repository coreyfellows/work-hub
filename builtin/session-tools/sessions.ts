import { SESSION_MODELS, sessionDirs, type SessionModel, type Workspace } from '../../plugin-api/server.ts';
import { fallbackName, planSession } from './sessionPlan.ts';
import { settings } from './settings.ts';

/**
 * Starting a workspace session by hand: your prompt, prefixed with what the workspace is about (the core's
 * `ctx.prompts.workspaceContext`) so the new session doesn't start cold. Closing one is the core's
 * `POST /api/workspaces/:id/sessions/:sid/close`.
 */

export interface NewSessionResult {
  sessionId: string;
  shortId: string;
  model: SessionModel;
  name: string;
  /** Set when the model or name was picked automatically. */
  auto: { difficulty: string | null; reason: string | null } | null;
}

/**
 * `model` "auto" (or empty) and an empty `name` are filled in by `planSession`, which rates the task's
 * difficulty; a model or name you give is kept as is.
 */
export async function newSession(
  ws: Workspace,
  input: { prompt: string; cwd?: string; model?: string; name?: string },
): Promise<NewSessionResult> {
  const { ctx, sessionModel } = settings();
  const task = input.prompt?.trim();
  if (!task) throw new Error('a prompt is required');
  const dirs = sessionDirs(ws);
  const cwd = input.cwd || ctx.paths.worktreesDir;
  if (!dirs.includes(cwd)) throw new Error(`not one of this workspace's folders: ${cwd}`);
  const wantModel = !input.model || input.model === 'auto' ? null : input.model;
  if (wantModel && !(SESSION_MODELS as readonly string[]).includes(wantModel)) throw new Error(`unknown model: ${wantModel}`);
  const wantName = input.name?.trim() || null;

  const plan = !wantModel || !wantName ? await planSession(ws, task, cwd) : null;
  const model = (wantModel ?? plan?.model ?? sessionModel) as SessionModel;
  const name = wantName ?? plan?.name ?? fallbackName(ws, task);
  const auto = plan ? { difficulty: plan.difficulty, reason: plan.reason } : null;

  const s = await ctx.sessions.startBackground({ cwd, name, model, prompt: await ctx.prompts.workspaceContext(ws, task), purpose: 'new-session' });
  ctx.store.addSession(ws.id, { claudeSessionId: s.sessionId, role: 'main', name, cwd });
  const why = plan && !wantModel ? ` [auto${plan.difficulty ? `, ${plan.difficulty}` : ''}${plan.reason ? `: ${plan.reason}` : ''}]` : '';
  ctx.store.logEvent(ws.id, 'session-started', `${s.shortId} (${model}) ${name}${why}`);
  return { sessionId: s.sessionId, shortId: s.shortId, model, name, auto };
}
