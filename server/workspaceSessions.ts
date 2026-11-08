import { config } from './config.ts';
import { fragments } from './lib/prompts.ts';
import { sessionMeta } from './lib/transcript.ts';
import { getProvider } from './lib/vcs/registry.ts';
import { getWorkspace, type Workspace } from './store/workspaces.ts';

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
  const kinds = vcsKinds(ws);
  const context = fragments('session-context', { workspaceId: ws.id, ticketKey: ws.ticketKey, kinds });
  return [
    `You're working in the work-hub workspace "${ws.id}" (${ws.title}). What it's about:`,
    '',
    ...(ws.ticketKey ? [`- Ticket: ${ws.ticketKey}${jira ? ` (${jira})` : ''}`] : []),
    ...(ws.epicKey ? [`- Epic: ${ws.epicKey}${ws.epicTitle ? ` (${ws.epicTitle})` : ''}`] : []),
    ...(ws.prompt ? ['- Original request:', indent(ws.prompt)] : []),
    ...(ws.notes ? ['- Plan and notes:', indent(ws.notes)] : []),
    ws.worktrees.length
      ? ['- Worktrees:', ...ws.worktrees.map((t) => `  - ${t.path} (${copyLabel(t)})`)].join('\n')
      : '- Worktrees: none recorded yet.',
    ...(ws.links.length ? ['- Links:', ...ws.links.map((l) => `  - ${l.label ? `${l.label}: ` : ''}${l.url}`)] : []),
    ...(past.length
      ? ["- Earlier sessions in this workspace (JSONL transcripts can be large: grep them, don't read them whole):", ...past]
      : []),
    ...(context ? [context] : []),
    '',
    ...rules(ws.id, ws.ticketKey, kinds),
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
 * (workspace-setup: the ticket-workflow worktree layout, branch names and trust script). A workspace with a non-git
 * source-control kind (its choice or a recorded copy) also gets that provider's `agentInstructions`, last.
 */
export function workspaceRules(wsId: string): string[] {
  const ws = getWorkspace(wsId);
  return rules(wsId, ws?.ticketKey ?? null, ws ? vcsKinds(ws) : ['git']);
}

/**
 * The source-control kinds in a workspace: its chosen vcs, then its working copies', deduped; `['git']` when it has
 * neither (a workspace before the first copy is recorded is git unless one was chosen).
 */
function vcsKinds(ws: Pick<Workspace, 'vcs' | 'worktrees'>): string[] {
  const kinds = [...new Set([ws.vcs, ...ws.worktrees.map((t) => t.vcs ?? 'git')].filter((k): k is string => !!k))];
  return kinds.length ? kinds : ['git'];
}

/** How the context prompt names a working copy: git as `repo @branch → base`, a folder as `folder`, others by kind. */
function copyLabel(t: Workspace['worktrees'][number]): string {
  const vcs = t.vcs ?? 'git';
  if (vcs === 'folder') return 'folder';
  const at = `@${t.branch ?? '?'}${t.baseBranch ? ` → ${t.baseBranch}` : ''}`;
  if (vcs === 'git') return `${t.repo ?? 'git'} ${at}`;
  return `${vcs}${t.repo ? ` ${t.repo}` : ''} ${at}`;
}

/** The rules for `kinds`: today's git text, plugins' fragments, then each other kind's own instructions. */
function rules(wsId: string, ticketKey: string | null, kinds: string[]): string[] {
  const extra = fragments('workspace-rules', { workspaceId: wsId, kinds });
  const opts = { workspaceId: wsId, ticketKey, whCommand: WH, worktreesDir: config.paths.worktrees };
  // A kind whose provider isn't in force (its plugin is off) adds nothing; one that throws is logged and skipped.
  const others = kinds
    .filter((k) => k !== 'git')
    .flatMap((k) => {
      try {
        return getProvider(k)?.agentInstructions(opts) ?? [];
      } catch (e) {
        console.error(`source-control provider "${k}" instructions:`, e);
        return [];
      }
    });
  return [
    "work-hub owns the sessions for this workspace. If part of the work needs its own session (e.g. a separate PR), you may start one: create the worktree (`git worktree add`), record it with `wh worktree add`, and run plain `claude --bg --name \"<name>\" --model <model> \"<self-contained prompt>\"` from inside it; work-hub adds it to this workspace by itself.",
    `Record what you create with \`${WH}\`: \`worktree add ${wsId} --path <path> --base <base>\`, \`link add ${wsId} --url <url>\` (every PR you open), \`note ${wsId} "<plan>"\`.`,
    ...(extra ? [extra] : []),
    ...others,
  ];
}

const indent = (s: string) =>
  s
    .trim()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
