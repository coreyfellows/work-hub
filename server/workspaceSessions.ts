import { config } from './config.ts';
import { fragments } from './lib/prompts.ts';
import { sessionMeta } from './lib/transcript.ts';
import type { Workspace } from './store/workspaces.ts';

/**
 * What the core tells the sessions it (and plugins) start in a workspace: the folders they may start in, the rules
 * they end with, and the context prompt (what the workspace is about, then the task) a new or review session starts
 * with, so it doesn't start cold. Plugins reach it as `sessionDirs` and `ctx.prompts.workspaceRules/workspaceContext`.
 */

// With the server's dir settings in front when they aren't the defaults (config.ts `whCommand`).
const WH = config.whCommand;

/** Folders a new session may start in: the workspace's worktrees, or the worktrees root. */
export function sessionDirs(ws: Workspace): string[] {
  return [...new Set([...ws.worktrees.map((t) => t.path), config.paths.worktrees])];
}

/** A session's full prompt: what the workspace is about (ticket, plan, worktrees, links, earlier sessions), its rules, then `task`. */
export async function contextPrompt(ws: Workspace, task: string): Promise<string> {
  const past = await Promise.all(
    ws.sessions.slice(-5).map(async (r) => {
      const t = await sessionMeta(r.claudeSessionId).then((m) => m.path, () => null);
      return `  - ${r.shortId} "${r.name ?? r.role}"${t ? `: transcript ${t}` : ''}`;
    }),
  );
  const jira = ws.links.find((l) => l.kind === 'jira')?.url;
  const context = fragments('session-context', { workspaceId: ws.id, ticketKey: ws.ticketKey });
  return [
    `You're working in the work-hub workspace "${ws.id}" (${ws.title}). What it's about:`,
    '',
    ...(ws.ticketKey ? [`- Ticket: ${ws.ticketKey}${jira ? ` (${jira})` : ''}`] : []),
    ...(ws.epicKey ? [`- Epic: ${ws.epicKey}${ws.epicTitle ? ` (${ws.epicTitle})` : ''}`] : []),
    ...(ws.prompt ? ['- Original request:', indent(ws.prompt)] : []),
    ...(ws.notes ? ['- Plan and notes:', indent(ws.notes)] : []),
    ws.worktrees.length
      ? ['- Worktrees:', ...ws.worktrees.map((t) => `  - ${t.path} (${t.repo} @${t.branch ?? '?'}${t.baseBranch ? ` → ${t.baseBranch}` : ''})`)].join('\n')
      : '- Worktrees: none recorded yet.',
    ...(ws.links.length ? ['- Links:', ...ws.links.map((l) => `  - ${l.label ? `${l.label}: ` : ''}${l.url}`)] : []),
    ...(past.length
      ? ["- Earlier sessions in this workspace (JSONL transcripts can be large: grep them, don't read them whole):", ...past]
      : []),
    ...(context ? [context] : []),
    '',
    ...workspaceRules(ws.id),
    '',
    'Your task:',
    '',
    task,
  ].join('\n');
}

/**
 * What every session work-hub starts in a workspace is told (new, handoff, PR sessions): it may start sibling
 * sessions only as plain `claude --bg` jobs in a recorded worktree (server/reconcile.ts adopts them), and records what
 * it creates with `wh` (reconcile.ts backs that up too). Plugins add their conventions as `workspace-rules` fragments
 * (workspace-setup: the ticket-workflow worktree layout, branch names and trust script).
 */
export function workspaceRules(wsId: string): string[] {
  const extra = fragments('workspace-rules', { workspaceId: wsId });
  return [
    "work-hub owns the sessions for this workspace. If part of the work needs its own session (e.g. a separate PR), you may start one: create the worktree (`git worktree add`), record it with `wh worktree add`, and run plain `claude --bg --name \"<name>\" --model <model> \"<self-contained prompt>\"` from inside it; work-hub adds it to this workspace by itself.",
    `Record what you create with \`${WH}\`: \`worktree add ${wsId} --path <path> --base <base>\`, \`link add ${wsId} --url <url>\` (every PR you open), \`note ${wsId} "<plan>"\`.`,
    ...(extra ? [extra] : []),
  ];
}

const indent = (s: string) =>
  s
    .trim()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
