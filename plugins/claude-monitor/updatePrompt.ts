/** The worktree names and first prompt of a session that updates one plugin for a Claude Code version. Pure, unit-tested. */
import type { PluginSuggestion } from './suggest.ts';

/** `claude-2-1-320-<plugin>`: the worktree folder and branch of an update session. */
export function updateSlug(version: string, pluginId: string): string {
  return `claude-${version.replace(/[^0-9a-z]+/gi, '-')}-${pluginId}`.toLowerCase();
}

export interface UpdatePromptOpts {
  workspaceId: string;
  version: string;
  suggestion: PluginSuggestion;
  /** The plugin's folder: in `worktree` for an official plugin, its own folder for a local one. */
  pluginDir: string;
  worktree: string;
  branch: string;
  base: string;
  /** The checkout the app runs from. */
  appRepo: string;
  whCommand: string;
  rules: string[];
}

export function updatePrompt(o: UpdatePromptOpts): string {
  const s = o.suggestion;
  const official = s.kind === 'official';
  const WH = o.whCommand;
  return [
    `Claude Code ${o.version} is installed, and work-hub's claude-monitor found release-note items that the ${official ? 'official' : 'local'} work-hub plugin \`${s.plugin}\` (${s.title}) could react to (changes since ${s.since ?? 'its last update'}). You are in workspace "${o.workspaceId}"; the user picked this plugin to update.`,
    '',
    'Suggested changes (each is the release-note item, then the idea):',
    ...s.items.flatMap((i) => [`- **${i.version}**: ${i.change}`, `  - Idea: ${i.idea}`]),
    '',
    official
      ? `The plugin is \`${o.pluginDir}\`, in this work-hub worktree (\`${o.worktree}\`, branch \`${o.branch}\` from \`${o.base}\`).`
      : `The plugin is the local plugin at \`${o.pluginDir}\` (you can write there without prompts; follow that folder's repo rules). This work-hub worktree (\`${o.worktree}\`, branch \`${o.branch}\` from \`${o.base}\`) is only for a work-hub core change the plugin needs; leave it clean otherwise.`,
    `The app itself runs from \`${o.appRepo}\`: never edit files there.`,
    '',
    'What to do:',
    '- Read `CLAUDE.md`, `docs/plugins.md`, the plugin\'s README and code, and the Claude Code docs for each feature (check what the release note means before building on it). An idea that turns out not to fit is fine to drop: say why in your report.',
    '- If what to build leaves a real choice open (what it shows, where, whether it costs tokens), ask me with AskUserQuestion before building.',
    `- Make the changes, update the plugin's README and tests, and set \`"claudeVersion": "${o.version}"\` in its \`plugin.json\` (the Claude Code version it is now up to date with; claude-monitor reads it so these suggestions are not offered again).`,
    '- Plugin-API rules from `CLAUDE.md` apply: additive changes go under "Additions" in `CHANGELOG.md`; a breaking one only after asking me in a question plainly labelled a **significant plugin-API change**.',
    `- Run \`pnpm typecheck\` and \`pnpm test\` (and \`pnpm build\` for web code) ${official ? 'in this worktree' : `in this worktree, and \`pnpm check-plugin ${o.pluginDir}\``} until they pass.`,
    '- Commit and push by each repo\'s own rules (its CLAUDE.md, or CONTRIBUTING). A repo with no rules: commit on a branch, push if it has a remote, and ask me before merging.',
    `- Going live: once the checks pass, ask me with AskUserQuestion whether to rebuild and restart now, unless the repo's rules say to deploy (then follow them). Restart with \`scripts/update.sh --no-pull\` run from \`${o.appRepo}\`.`,
    `- Record as you go: \`${WH} link add ${o.workspaceId} --url <url>\` for a PR, and \`${WH} note ${o.workspaceId} "<one-paragraph plan>"\` once you have a plan.`,
    '- Final report: what changed, which ideas you dropped and why, and whether the plugin API changed.',
    '',
    ...o.rules,
  ].join('\n');
}
