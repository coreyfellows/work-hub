import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_MODELS, type Session, type Workspace } from '../../plugin-api/server.ts';
import { planSession } from './sessionPlan.ts';
import { settings } from './settings.ts';

/**
 * Hand a workspace session off to a fresh one: a headless fork of the session (full context, no tools,
 * nothing persisted) writes a handoff brief, a new background session starts in the same cwd with the
 * same model and role and the brief as its prompt, and the old session is stopped. The old one stays
 * in the workspace's records (and `claude attach <id>` / `claude --resume` still reopen it).
 */

const BRIEF_PROMPT = [
  "We're handing this work off to a fresh Claude session that won't see this conversation.",
  'Write the handoff brief it needs to carry on, in Markdown, with these sections:',
  '- Goal: what we are trying to achieve, and for whom.',
  "- Where things stand: what's done (and how it was verified), what's in progress, what isn't verified.",
  '- Key decisions and why, including approaches that were tried and rejected.',
  '- Code and artifacts: repos, worktrees, branches, files, PRs, tickets, commands (absolute paths, exact ids).',
  '- Gotchas learned the hard way.',
  '- Open questions, including anything I was asked and have not answered yet.',
  '- Next steps, in order.',
  'Be specific and complete but concise; leave out anything the new session can trivially rediscover.',
  "Leave out environment noise it will see for itself (hook output, MCP connection status, setup reminders) unless it mattered to the work.",
  'Output only the brief, no preamble.',
].join('\n');

const inFlight = new Set<string>();

/**
 * The new session's prompt; `rules` are the workspace's (`ctx.prompts.workspaceRules`), `context` the plugins'
 * `session-context` fragments (e.g. the sibling-session digest), between the brief and the rules when non-empty.
 */
export function continuePrompt(ws: Workspace, old: Pick<Session, 'shortId' | 'name'>, brief: string, transcript: string | null, note: string, rules: string[], context: string | null = null): string {
  return [
    `You're taking over from an earlier Claude session (${old.shortId}, "${old.name}") in the work-hub workspace "${ws.id}" (${ws.title}). It wrote this handoff brief:`,
    '',
    brief.trim(),
    '',
    transcript
      ? `Its full transcript is at ${transcript} if you need a detail the brief leaves out (it's JSONL and can be large: grep it, don't read it whole).`
      : "Its transcript couldn't be found, so the brief is all there is.",
    '',
    ...(context?.trim() ? [context.trim(), ''] : []),
    ...rules,
    '',
    ...(note
      ? ['My instructions for you:', '', note, '', 'Start by replying with a few lines on where things stand, then follow those instructions.']
      : ['Start by replying with a few lines on where things stand and the next step, then wait for me before changing anything.']),
  ].join('\n');
}

async function writeBrief(s: Session, model: string | null): Promise<string> {
  const args = ['-p', BRIEF_PROMPT, '--resume', s.sessionId, '--fork-session', '--no-session-persistence', '--tools', '', '--max-turns', '1', '--output-format', 'json'];
  if (model) args.push('--model', model);
  // --resume looks the session up by project, so the fork has to run in the session's own directory.
  const out = await settings().ctx.exec.run('claude', args, { cwd: s.cwd, timeoutMs: settings().summaryTimeoutMs });
  const env = JSON.parse(out) as { result?: string; is_error?: boolean };
  if (env.is_error || !env.result?.trim()) throw new Error(`couldn't write the handoff brief: ${env.result ?? 'no result'}`);
  return env.result.trim();
}

export interface HandoffResult {
  sessionId: string;
  shortId: string;
  briefPath: string;
  /** What the new session runs on, and (for "auto") why it was picked. */
  model: string;
  auto: { difficulty: string | null; reason: string | null } | null;
}

/**
 * Where a handoff has got to, saved with its job after every step so a server restart picks it up again
 * (`handOff` resumes from `stage`): brief = writing the brief (re-done from scratch, nothing outside has changed yet),
 * start = the brief is saved, the new session isn't started, stop = the new session is running and recorded,
 * the old one still has to be stopped.
 */
export interface HandoffState {
  workspaceId: string;
  /** The session being handed off. */
  sessionId: string;
  note: string;
  /** "same" (the old session's model), "auto" (picked from the instructions, else the brief) or a model name. */
  model: string;
  stage: 'brief' | 'start' | 'stop';
  oldModel?: string | null;
  transcript?: string | null;
  briefPath?: string;
  newSessionId?: string;
  newShortId?: string;
  newModel?: string;
  auto?: HandoffResult['auto'];
}

export const newHandoffState = (workspaceId: string, sessionId: string, note: string, model: string): HandoffState => ({
  workspaceId,
  sessionId,
  note: note.trim(),
  model: model || 'same',
  stage: 'brief',
});

export function validHandoffModel(model: string): boolean {
  return !model || model === 'same' || model === 'auto' || (SESSION_MODELS as readonly string[]).includes(model);
}

/** The brief text out of a saved handoff file (it starts with a "# Handoff from …" line). */
export function stripBriefHeader(file: string): string {
  return file.replace(/^# Handoff from [^\n]*\n\n/, '').trim();
}

/**
 * Run (or resume) a handoff. `save` is called whenever `state` changes, so it can be persisted.
 * The old session is only stopped once the new one is recorded, so a failure before that loses nothing.
 */
export async function handOff(ws: Workspace, s: Session, state: HandoffState, save: (st: HandoffState) => void = () => {}): Promise<HandoffResult> {
  if (!validHandoffModel(state.model)) throw new Error(`unknown model: ${state.model}`);
  const rec = ws.sessions.find((r) => r.claudeSessionId === s.sessionId);
  if (!rec) throw new Error("this session isn't in the workspace");
  if (inFlight.has(s.sessionId)) throw new Error('a handoff for this session is already running');
  inFlight.add(s.sessionId);
  const { ctx, handoffDir, sessionModel } = settings();
  try {
    const name = s.name || rec.name || ws.title;
    const wanted = state.model === 'same' ? null : state.model;

    if (state.stage === 'brief') {
      const meta = await ctx.sessions.sessionMeta(s.sessionId);
      const brief = await writeBrief(s, meta.model);
      await mkdir(handoffDir, { recursive: true, mode: 0o700 });
      const briefPath = join(handoffDir, `${ws.id}-${s.shortId}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      await writeFile(briefPath, `# Handoff from ${s.shortId} (${s.name})\n\n${brief}\n`, { mode: 0o600 });
      Object.assign(state, { stage: 'start', oldModel: meta.model, transcript: meta.path, briefPath });
      save(state);
    }

    if (state.stage === 'start') {
      const brief = stripBriefHeader(await readFile(state.briefPath!, 'utf8'));
      let newModel = wanted && wanted !== 'auto' ? wanted : (state.oldModel ?? sessionModel);
      let auto: HandoffResult['auto'] = null;
      if (wanted === 'auto') {
        const plan = await planSession(ws, state.note || brief, s.cwd);
        newModel = plan.model;
        auto = { difficulty: plan.difficulty, reason: plan.reason };
      }
      const next = await ctx.sessions.startBackground({
        cwd: s.cwd,
        name,
        model: newModel,
        prompt: continuePrompt(ws, s, brief, state.transcript ?? null, state.note, ctx.prompts.workspaceRules(ws.id), ctx.prompts.fragments('session-context', { workspaceId: ws.id, ticketKey: ws.ticketKey, excludeSessionId: s.sessionId })),
        purpose: 'handoff',
      });
      // Saved before anything else, so a restart from here can't start a second new session.
      Object.assign(state, { stage: 'stop', newSessionId: next.sessionId, newShortId: next.shortId, newModel, auto });
      save(state);
    }

    // stage 'stop': the new session is running. Recording it is idempotent, so a resume just repeats it.
    ctx.store.addSession(ws.id, { claudeSessionId: state.newSessionId!, role: rec.role, name, cwd: s.cwd });
    ctx.store.logEvent(ws.id, 'handoff', `${s.shortId} → ${state.newShortId} (${state.newModel}${state.auto ? ', auto' : ''}) (${state.briefPath})`);
    await ctx.sessions.stop(s).catch((e) => ctx.store.logEvent(ws.id, 'handoff-stop-failed', `${s.shortId}: ${(e as Error).message}`));
    return { sessionId: state.newSessionId!, shortId: state.newShortId!, briefPath: state.briefPath!, model: state.newModel!, auto: state.auto ?? null };
  } finally {
    inFlight.delete(s.sessionId);
  }
}
