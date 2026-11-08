import { join } from 'node:path';

/** Quote a path for a shell command line only when it needs it. */
const q = (p: string) => (/[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p);

/** The on-demand command a session runs for the current digest: the plugin's team.sh, pointed at the plugin's state folder. */
export function teamCommand(stateDir: string, pluginDir: string): string {
  return `WORK_HUB_SESSION_AWARENESS_DIR=${q(stateDir)} ${q(join(pluginDir, 'claude', 'scripts', 'team.sh'))}`;
}

/** The two sentences every workspace session's rules end with (a `workspace-rules` fragment). */
export function rulesText(whCommand: string, teamCommand: string): string {
  return [
    `Tell your sibling sessions what you own: \`${whCommand} claim <ws> "<what you're responsible for>"\` when you take something on (latest wins) and \`${whCommand} done <ws> "<what you finished>"\` when you finish a piece.`,
    `The "Other sessions in this workspace" block in your context is kept by work-hub from these and from your worktrees, PRs, commits and edits; you'll get a short note when a sibling's changes. For the current picture run \`${teamCommand} <ws>\`.`,
  ].join(' ');
}
