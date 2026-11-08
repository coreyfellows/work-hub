import { SESSION_MODELS, type Workspace } from '../../plugin-api/server.ts';
import { settings } from './settings.ts';

/**
 * Picking a model and a name for a new session from what it's asked to do, so "+ New session" can be
 * left on auto. A quick headless run (no tools, no MCP) rates the task against the ticket-workflow model
 * policy and suggests a short name. Any failure falls back to the default model and a name cut from the
 * prompt: starting the session matters more than the suggestion.
 */

export const PLANNED_MODELS = SESSION_MODELS;
export type PlannedModel = (typeof PLANNED_MODELS)[number];

export interface SessionPlan {
  model: PlannedModel;
  name: string;
  difficulty: string | null;
  reason: string | null;
}

const NAME_MAX = 60;

export function plannerPrompt(ws: Workspace, task: string, cwd: string): string {
  return [
    'A new Claude Code session is about to start on the task below. Estimate how hard it is, pick the model, and name the session.',
    '',
    'Models (when unsure between two, pick the stronger one):',
    '- haiku: trivial, mechanical work (typos, version bumps, one-line config, running a known command).',
    '- sonnet: well-scoped work with an obvious approach (a contained feature or fix, docs, a PR with clear feedback).',
    '- opus: complex or ambiguous work (multi-file or cross-service changes, unknown root causes, debugging, security-sensitive code, design, vague requirements).',
    '- fable: only the hardest, longest-horizon work where opus is likely to struggle (large multi-step builds or investigations across many systems).',
    '',
    `Name: 3 to 6 words, at most ${NAME_MAX} characters, saying what the session does (e.g. "Fix flaky checkout test", "Review PR 412 auth changes"). Lead with the ticket key if there is one. No quotes, no trailing period.`,
    '',
    'Context:',
    `- Workspace: ${ws.title}${ws.ticketKey ? ` (ticket ${ws.ticketKey})` : ''}`,
    ...(ws.prompt ? [`- Workspace request: ${ws.prompt.slice(0, 600)}`] : []),
    `- Working folder: ${cwd}`,
    '',
    'Task:',
    '<task>',
    task.slice(0, 4000),
    '</task>',
    '',
    'Reply with only this JSON, nothing else:',
    '{"difficulty": "trivial|moderate|hard|very hard", "model": "haiku|sonnet|opus|fable", "name": "...", "reason": "one short line on why this model"}',
  ].join('\n');
}

/** Name used when there's nothing better: the workspace title and the start of the prompt. */
export function fallbackName(ws: Workspace, task: string): string {
  return `${ws.title}: ${task.split('\n')[0].slice(0, 40)}`;
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\r\n]+/g, ' ').replace(/^["'\s]+|["'.\s]+$/g, '').trim();
  return name ? name.slice(0, NAME_MAX) : null;
}

export async function planSession(ws: Workspace, task: string, cwd: string): Promise<SessionPlan & { planned: boolean }> {
  const { ctx, sessionModel, plannerModel, plannerTimeoutMs } = settings();
  const fallback: SessionPlan = {
    model: (PLANNED_MODELS as readonly string[]).includes(sessionModel) ? (sessionModel as PlannedModel) : 'opus',
    name: fallbackName(ws, task),
    difficulty: null,
    reason: null,
  };
  try {
    const { value } = await ctx.headless.askClaudeJson<{ model?: string; name?: string; difficulty?: string; reason?: string }>(
      'session-plan',
      plannerPrompt(ws, task, cwd),
      { model: plannerModel, maxTurns: 1, timeoutMs: plannerTimeoutMs, tools: 'none' },
    );
    const model = (PLANNED_MODELS as readonly string[]).includes(value.model ?? '') ? (value.model as PlannedModel) : fallback.model;
    return {
      model,
      name: cleanName(value.name) ?? fallback.name,
      difficulty: typeof value.difficulty === 'string' ? value.difficulty.slice(0, 20) : null,
      reason: typeof value.reason === 'string' ? value.reason.replace(/\s+/g, ' ').slice(0, 200) : null,
      planned: true,
    };
  } catch (err) {
    return { ...fallback, reason: `auto-pick failed (${(err as Error).message.slice(0, 120)}); used the default`, planned: false };
  }
}
