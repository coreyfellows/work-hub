import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { expandFolder, folderTrustError, type ServerPluginContext, type SourceControlProvider, type Workspace } from '../../plugin-api/server.ts';

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
  /** The workspace's source control when it isn't git: step 3 becomes its own instructions. Absent: today's git steps. */
  provider?: Pick<SourceControlProvider, 'title' | 'agentInstructions'>;
  /** The worktrees root, for the provider's instructions. */
  worktreesDir?: string;
}

export interface DispatchSettings extends Omit<ExplorerPromptOpts, 'fragment' | 'provider' | 'worktreesDir'> {
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

/** Step 3 for git (and Detect): one worktree per repo, the ticket-workflow way. */
function gitSteps(ws: Workspace, opts: ExplorerPromptOpts): string[] {
  return [
    '3. For each repo, create a worktree following the ticket-workflow conventions:',
    '   - `git -C ~/repos/<repo> fetch origin` (one fetch at a time), then',
    `   - \`git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<${ws.ticketKey ? ws.ticketKey : 'short-kebab-desc'}> -b <branch> origin/<base>\``,
    `   - branch: ${ws.ticketKey ? `\`f-${ws.ticketKey}-<short-desc>\`` : 'a short kebab-case description'}; base: the branch this work should merge into (check for a Jira-named integration branch and make sure it is not stale).`,
    // Without the ticket-workflow scripts (that plugin off, no WORK_HUB_TW_SCRIPTS) the core's `wh trust` does the same.
    `   - then run \`${trustCommand(opts)} <path>\`.`,
    '   Reuse an existing worktree for this work instead of creating a duplicate.',
  ];
}

/** Step 3 for another provider: its own instructions, as sub-bullets. */
function providerSteps(ws: Workspace, opts: ExplorerPromptOpts, provider: NonNullable<ExplorerPromptOpts['provider']>): string[] {
  const lines = provider.agentInstructions({ workspaceId: ws.id, ticketKey: ws.ticketKey, whCommand: opts.whCommand, worktreesDir: opts.worktreesDir ?? '' });
  return [`3. Create its working copies with ${provider.title}:`, ...lines.map((l) => `   - ${l}`)];
}

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
    ...(opts.provider ? providerSteps(ws, opts, opts.provider) : gitSteps(ws, opts)),
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
export function ticketWorkflowRules(opts: { ticketKey: string | null; worktreesDir: string; ticketWorkflowScripts: string; whCommand: string; kinds?: string[] }): string {
  // Git conventions: a workspace with no git in it (a plain folder, only jj…) doesn't get them.
  if (opts.kinds && !opts.kinds.includes('git')) return '';
  const folder = opts.ticketKey ?? '<short-kebab-desc>';
  const branch = opts.ticketKey ? `\`f-${opts.ticketKey}-<short-desc>\`` : 'a short kebab-case description';
  const trust = `, then run \`${trustCommand(opts)} <path>\` on it`;
  return [
    `New worktrees follow the ticket-workflow conventions: \`${opts.worktreesDir}/<repo>/${folder}\`, branch ${branch}${trust}.`,
    "Don't use `spawn-ticket-session`, cmux or other terminal workspaces, or `EnterWorktree`.",
  ].join(' ');
}

/** The provider whose steps the explorer gets: none for git or no choice (today's text); throws if it isn't registered. */
export function explorerProvider(ctx: Pick<ServerPluginContext, 'vcs'>, vcs: string | null): SourceControlProvider | undefined {
  if (!vcs || vcs === 'git') return undefined;
  const p = ctx.vcs.get(vcs);
  if (!p) throw new Error(unavailable(vcs));
  return p;
}
const unavailable = (id: string) => `${id} isn't available (switch its plugin on in Settings → Plugins)`;

/** Start the explorer session for a workspace that is still setting up. */
async function startExplorer(s: DispatchSettings, ws: Workspace): Promise<void> {
  const { ctx } = s;
  const name = `${ws.title}: setup`;
  const cwd = ctx.paths.worktreesDir; // trusted, and not inside any one repo
  const provider = explorerProvider(ctx, ws.vcs);
  const fragment = ctx.prompts.fragments('explorer', { workspaceId: ws.id, ticketKey: ws.ticketKey });
  const { shortId, sessionId } = await ctx.sessions.startBackground({
    cwd,
    name,
    model: s.explorerModel,
    prompt: explorerPrompt(ws, { whCommand: s.whCommand, ticketWorkflowScripts: s.ticketWorkflowScripts, fragment, provider, worktreesDir: cwd }),
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

export interface DispatchInput {
  ticket?: string;
  prompt?: string;
  /** A provider id, or '' / 'detect' for Detect. */
  vcs?: string;
  /** A plain folder: a name (under the plain workspaces root) or an absolute / `~` path. */
  folder?: string;
  /** The user confirmed letting sessions work in a folder outside the roots (after a `NeedsConfirm`). */
  confirmFolder?: boolean;
}

/** A folder outside the worktrees and plain roots that the user hasn't confirmed yet: the route answers 409 `{ needsConfirm }`. */
export class NeedsConfirm extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`confirm letting Claude sessions work in ${path}`);
    this.path = path;
  }
}

/** A body field as trimmed text ('' for anything that isn't a string). */
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function dispatchWorkspace(s: DispatchSettings, input: DispatchInput): Promise<Workspace> {
  const { ctx } = s;
  const { store } = ctx;
  const ticket = text(input.ticket).toUpperCase() || null;
  const prompt = text(input.prompt) || null;
  const folder = text(input.folder) || null;
  const vcsIn = text(input.vcs);
  const chosen = vcsIn && vcsIn !== 'detect' ? vcsIn : null;
  if (!ticket && !prompt && !folder) throw new Error('give a ticket key or a prompt');
  if (ticket && !TICKET_RE.test(ticket)) throw new Error(`"${ticket}" doesn't look like a ticket key (e.g. TKT-1234)`);
  if (folder) {
    if (chosen && chosen !== 'folder') throw new Error('a folder workspace has no source control: leave Source control on Detect or Plain folder');
    return dispatchFolder(s, { ticket, prompt, folder, confirm: input.confirmFolder === true });
  }
  if (chosen === 'folder') throw new Error('a plain-folder workspace needs a Folder (a name or a path)');
  if (chosen && !ctx.vcs.get(chosen)) throw new Error(unavailable(chosen));
  const title = ticket ?? prompt!.split('\n')[0].slice(0, 60);
  // Detect: Settings' default, unless that is git (or Detect), which leaves the workspace exactly as before.
  const fallback = chosen ? null : ctx.vcs.effectiveDefault();
  if (fallback === 'folder') {
    // A plain folder by default: the workspace's own folder under the plain root, named after its id.
    const id = store.uniqueId(store.suggestId({ title, ticketKey: ticket, prompt }));
    return dispatchFolder(s, { ticket, prompt, folder: id, confirm: false, id });
  }
  const vcs = chosen ?? (fallback && fallback !== 'git' ? fallback : null);

  const id = store.createWorkspace({ title, origin: ticket ? 'ticket' : 'prompt', ticketKey: ticket, prompt, status: 'setting-up', ...(vcs ? { vcs } : {}) });
  addJiraLink(s, id, ticket);
  const ws = store.getWorkspace(id)!;
  // Its note (if the notes plugin is on) comes from the `created` workspace event.

  await startExplorer(s, ws);
  return store.getWorkspace(id)!;
}

function addJiraLink(s: DispatchSettings, id: string, ticket: string | null): void {
  const jira = s.jiraBaseUrl.trim().replace(/\/+$/, '');
  if (ticket && jira) s.ctx.store.addLink(id, { kind: 'jira', url: `${jira}/browse/${ticket}`, label: ticket });
}

const inside = (path: string, root: string) => path.startsWith(root + sep);
/** A root as a real path when it exists (so a symlinked root still contains its folders), else as given. */
const realRoot = (root: string) => realpath(root).catch(() => resolve(root));

/**
 * A plain-folder workspace: no explorer. The folder (a name under the plain root, or a path) is created if missing,
 * trusted (one outside the worktrees and plain roots only once the user confirmed it), recorded with vcs `folder`, and
 * a `main` session starts in it with the prompt (or "get oriented") as its task.
 */
async function dispatchFolder(
  s: DispatchSettings,
  input: { ticket: string | null; prompt: string | null; folder: string; confirm: boolean; id?: string },
): Promise<Workspace> {
  const { ctx } = s;
  const { store } = ctx;
  const raw = input.folder;
  const typed = raw === '~' || raw.startsWith('~/') || isAbsolute(raw) ? expandFolder(raw) : join(ctx.paths.plainDir, raw);
  const path = resolve(typed);
  const bad = folderTrustError(path);
  if (bad) throw new Error(bad);
  const st = await stat(path).catch(() => null);
  if (st && !st.isDirectory()) throw new Error(`${path} is a file`);
  // An existing folder is judged by where it really is (a symlink in the plain root may lead anywhere); a new one by its path.
  const where = st ? await realpath(path) : path;
  // A recorded folder adopts every unrecorded session beneath it: never a root (worktrees, repos, plain) or a folder containing one.
  const allRoots: Array<[string, string]> = [['worktrees', ctx.paths.worktreesDir], ['repos', ctx.paths.reposDir], ['plain workspaces', ctx.paths.plainDir]];
  for (const [name, root] of allRoots) {
    for (const r of new Set([resolve(root), await realRoot(root)])) {
      if (where === r || inside(r, where)) throw new Error(`${path} is (or contains) the ${name} folder: pick a folder inside it`);
    }
  }
  const roots = st ? await Promise.all([realRoot(ctx.paths.plainDir), realRoot(ctx.paths.worktreesDir)]) : [resolve(ctx.paths.plainDir), resolve(ctx.paths.worktreesDir)];
  const outside = !roots.some((r) => inside(where, r));
  if (outside && !input.confirm && !store.isTrustedFolder(where)) throw new NeedsConfirm(path);

  await mkdir(path, { recursive: true });
  const dir = await realpath(path);
  if (outside) {
    const bad2 = folderTrustError(dir); // a symlink must not lead somewhere refused
    if (bad2) throw new Error(bad2);
    store.trustFolder(dir);
  }
  await ctx.sessions.trustWorktree(dir);

  const title = input.ticket ?? input.prompt?.split('\n')[0].slice(0, 60) ?? basename(dir);
  const id = store.createWorkspace({ ...(input.id ? { id: input.id } : {}), title, origin: input.ticket ? 'ticket' : 'prompt', ticketKey: input.ticket, prompt: input.prompt, status: 'active', vcs: 'folder' });
  addJiraLink(s, id, input.ticket);
  // The prompt is already in the context as "Original request": don't repeat it as the task.
  const task = input.prompt ? 'Start on the original request above.' : 'Get oriented in this folder and wait for me.';
  let started: { shortId: string; sessionId: string };
  try {
    store.addWorktree(id, { path: dir, repo: null, vcs: 'folder' });
    const ws = store.getWorkspace(id)!;
    started = await ctx.sessions.startBackground({ cwd: dir, name: title, prompt: await ctx.prompts.workspaceContext(ws, task), purpose: 'new-session' });
  } catch (e) {
    // No session, no workspace: an active workspace with nothing working in it would just sit there. The folder stays.
    store.deleteWorkspace(id);
    throw e;
  }
  const { shortId, sessionId } = started;
  store.addSession(id, { claudeSessionId: sessionId, role: 'main', name: title, cwd: dir });
  store.logEvent(id, 'dispatched', `main ${shortId} in ${dir}`);
  return store.getWorkspace(id)!;
}
