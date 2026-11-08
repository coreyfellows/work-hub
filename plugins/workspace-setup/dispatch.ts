import type { ServerPluginContext, Workspace } from '../../plugin-api/server.ts';

/**
 * Starting work: create a workspace, then dispatch an exploratory Claude session that works out which
 * repos are involved, creates and records worktrees (via bin/wh), writes a plan and waits. The session
 * runs as a background job; work-hub shows it (exact colours) and types into it via a pty attach.
 */

/** What the explorer prompt needs besides the workspace (all from the plugin context and settings). */
export interface ExplorerPromptOpts {
  /** The `wh` command line the explorer records things with (`ctx.paths.whCommand`). */
  whCommand: string;
  /** The ticket-workflow scripts folder (`trust-worktree.sh`); empty: the trust step is `wh trust` (the core's). */
  ticketWorkflowScripts: string;
  /** The joined `explorer` prompt fragments other plugins add (empty for none). */
  fragment: string;
}

export interface DispatchSettings extends Omit<ExplorerPromptOpts, 'fragment'> {
  ctx: ServerPluginContext;
  explorerModel: string;
  jiraBaseUrl: string;
}

const TICKET_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** The command that trusts a new worktree for Claude: ticket-workflow's script when it's there, else the core's `wh trust`. */
const trustCommand = (opts: { ticketWorkflowScripts: string; whCommand: string }): string =>
  opts.ticketWorkflowScripts ? `${opts.ticketWorkflowScripts}/trust-worktree.sh` : `${opts.whCommand} trust`;

/** A plugin fragment as extra prompt lines (a blank line, then the text), or nothing. */
const withFragment = (text: string): string[] => (text ? ['', text] : []);

export function explorerPrompt(ws: Workspace, opts: ExplorerPromptOpts): string {
  const id = ws.id;
  const WH = opts.whCommand;
  const subject = ws.ticketKey
    ? `Jira ticket ${ws.ticketKey}${ws.prompt ? `, with this extra context from me:\n\n${ws.prompt}` : '.'}`
    : `this task:\n\n${ws.prompt}`;
  return [
    `You're setting up the work-hub workspace "${id}" for ${subject}`,
    '',
    "This session is setup and reconnaissance only. Don't implement anything yet.",
    '',
    ws.ticketKey
      ? `1. Load the \`ticket-workflow:ticket-defaults\` skill and run its "Starting work on a ticket" steps for ${ws.ticketKey}, then read the ticket (and its parent/epic) to understand the scope.`
      : '1. Make sure you understand the task. If it is too vague to pick repos, ask me.',
    '2. Work out which repositories need changes. Local checkouts live in ~/repos/<repo>. Confirm by reading code, not just repo names.',
    '3. For each repo, create a worktree following the ticket-workflow conventions:',
    '   - `git -C ~/repos/<repo> fetch origin` (one fetch at a time), then',
    `   - \`git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<${ws.ticketKey ? ws.ticketKey : 'short-kebab-desc'}> -b <branch> origin/<base>\``,
    `   - branch: ${ws.ticketKey ? `\`f-${ws.ticketKey}-<short-desc>\`` : 'a short kebab-case description'}; base: the branch this work should merge into (check for a Jira-named integration branch and make sure it is not stale).`,
    // Without the ticket-workflow scripts (that plugin off, no WORK_HUB_TW_SCRIPTS) the core's `wh trust` does the same.
    `   - then run \`${trustCommand(opts)} <path>\`.`,
    '   Reuse an existing worktree for this work instead of creating a duplicate.',
    '4. Record everything in work-hub as you go:',
    `   - \`${WH} worktree add ${id} --path <worktree> --base <base>\` for each worktree`,
    `   - \`${WH} title ${id} "<${ws.ticketKey ?? 'Short'}: short title>"\``,
    ...(ws.ticketKey ? [`   - \`${WH} epic ${id} <EPIC-KEY> "<epic title>"\` (the ticket's parent epic; \`${WH} epic ${id} none\` if it has none)`] : []),
    `   - \`${WH} link add ${id} --url <url>\` for the ticket, related PRs or docs`,
    '5. work-hub owns sessions for this workspace. Do NOT start other Claude sessions or terminal workspaces, use `spawn-ticket-session` or `EnterWorktree`, even if other instructions say a new worktree needs its own session.',
    `6. When done: \`${WH} note ${id} "<one-paragraph plan>"\`, then \`${WH} status ${id} active\`, then reply with the plan (worktrees, approach, risks, open questions) and wait for me.`,
    '',
    'If something is ambiguous (which repo, which base branch), ask me rather than guessing.',
    ...withFragment(opts.fragment),
  ].join('\n');
}

/**
 * The ticket-workflow part of the rules every workspace session gets: a `workspace-rules` fragment that follows the
 * core's generic ones ("sibling sessions only as plain `claude --bg` in a recorded worktree; record with `wh`").
 */
export function ticketWorkflowRules(opts: { ticketKey: string | null; worktreesDir: string; ticketWorkflowScripts: string; whCommand: string }): string {
  const folder = opts.ticketKey ?? '<short-kebab-desc>';
  const branch = opts.ticketKey ? `\`f-${opts.ticketKey}-<short-desc>\`` : 'a short kebab-case description';
  const trust = `, then run \`${trustCommand(opts)} <path>\` on it`;
  return [
    `New worktrees follow the ticket-workflow conventions: \`${opts.worktreesDir}/<repo>/${folder}\`, branch ${branch}${trust}.`,
    "Don't use `spawn-ticket-session`, cmux or other terminal workspaces, or `EnterWorktree`.",
  ].join(' ');
}

/** Start the explorer session for a workspace that is still setting up. */
async function startExplorer(s: DispatchSettings, ws: Workspace): Promise<void> {
  const { ctx } = s;
  const name = `${ws.title}: setup`;
  const cwd = ctx.paths.worktreesDir; // trusted, and not inside any one repo
  const fragment = ctx.prompts.fragments('explorer', { workspaceId: ws.id, ticketKey: ws.ticketKey });
  const { shortId, sessionId } = await ctx.sessions.startBackground({
    cwd,
    name,
    model: s.explorerModel,
    prompt: explorerPrompt(ws, { whCommand: s.whCommand, ticketWorkflowScripts: s.ticketWorkflowScripts, fragment }),
    purpose: 'explorer',
  });
  ctx.store.addSession(ws.id, { claudeSessionId: sessionId, role: 'explorer', name, cwd });
  ctx.store.logEvent(ws.id, 'dispatched', `explorer ${shortId} (${s.explorerModel})`);
}

/** A workspace that was created and then never got its explorer: setting up, no sessions, made a moment ago. */
export function needsExplorer(ws: Workspace, now = Date.now()): boolean {
  return ws.status === 'setting-up' && ws.sessions.length === 0 && now - Date.parse(ws.createdAt) < RESUME_WINDOW_MS;
}
const RESUME_WINDOW_MS = 15 * 60_000;

/**
 * At startup: a restart between creating a workspace and starting its explorer left it "setting-up" with nothing working
 * on it. Start the explorer now (only for ones made in the last 15 minutes, so an old failed start isn't resurrected).
 */
export async function resumeDispatch(s: DispatchSettings): Promise<void> {
  const { store } = s.ctx;
  for (const ws of store.listWorkspaces()) {
    if (!needsExplorer(ws)) continue;
    await startExplorer(s, ws).then(
      () => store.logEvent(ws.id, 'dispatch-resumed', 'the server restarted before the explorer started; started it now'),
      (e) => store.logEvent(ws.id, 'dispatch-resume-failed', (e as Error).message),
    );
  }
}

export async function dispatchWorkspace(s: DispatchSettings, input: { ticket?: string; prompt?: string }): Promise<Workspace> {
  const { store } = s.ctx;
  const ticket = input.ticket?.trim().toUpperCase() || null;
  const prompt = input.prompt?.trim() || null;
  if (!ticket && !prompt) throw new Error('give a ticket key or a prompt');
  if (ticket && !TICKET_RE.test(ticket)) throw new Error(`"${ticket}" doesn't look like a ticket key (e.g. TKT-1234)`);

  const title = ticket ?? prompt!.split('\n')[0].slice(0, 60);
  const id = store.createWorkspace({ title, origin: ticket ? 'ticket' : 'prompt', ticketKey: ticket, prompt, status: 'setting-up' });
  const jira = s.jiraBaseUrl.trim().replace(/\/+$/, '');
  if (ticket && jira) store.addLink(id, { kind: 'jira', url: `${jira}/browse/${ticket}`, label: ticket });
  const ws = store.getWorkspace(id)!;
  // Its note (if the notes plugin is on) comes from the `created` workspace event.

  await startExplorer(s, ws);
  return store.getWorkspace(id)!;
}
