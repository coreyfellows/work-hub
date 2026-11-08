/** The built-in rules, one section each (Settings has a switch per section: `rule<Id>`). */
export const RULE_SECTIONS = ['commands', 'questions', 'vault', 'notes'] as const;
export type RuleSection = (typeof RULE_SECTIONS)[number];
/** Sections left out unless switched on: they assume a setup not everyone has (a Vault server with OIDC sign-in). */
export const OFF_BY_DEFAULT: ReadonlySet<RuleSection> = new Set(['vault']);
export type RuleOptions = { [K in RuleSection]?: boolean } & {
  /** Your own rules, added as the last section. */
  extra?: string;
};

function sectionLines(scriptsDir: string): Record<RuleSection, string[]> {
  return {
    commands: [
      'Commands and scripts for the user to run',
      `- To give the user a command to run, put it in a fenced code block that is exactly one line, starting at column 0 with \`!\` (e.g. \`! ${scriptsDir}/<repo>/<worktree>/do-thing.sh --apply\`). Only that shape gets a Run button. Never indent it, even inside a list, and never split it over several lines.`,
      `- Anything longer than one simple command (pipes, loops, several flags, env setup) goes in an executable script at \`${scriptsDir}/<repo>/<worktree>/<descriptive-name>.sh\` (work-hub's own storage, not \`/tmp\`; create the folder), written for the user without being asked. Give them the one-line \`!\` command to run it.`,
      '- Scripts start with `set -euo pipefail` and are fully non-interactive, because they run from a `!` line with no terminal: no `read` prompts, no `[y/N]`, no `/dev/tty`, no secrets on stdin. Take every input as a flag or environment variable and fail with a message naming the missing one.',
      '- Anything that changes something outward-facing is a dry run by default, with an explicit `--apply` for the real run. Where the real run needs confirmation, take a flag that names what changes (e.g. `--confirm staging,prod`) instead of prompting.',
      '- Never print secrets: command output is stored and shown. Get a secret from the secret store (e.g. Vault) or generate it in the script.',
    ],
    questions: [
      'Follow-up questions',
      '- Ask follow-ups (a next step, an open decision, an offer, a question for the user) with the `AskUserQuestion` tool so the user can answer inline. One question per follow-up, up to 4 per call, a short header.',
      '- Whenever a question has a small set of plausible answers (which approach, which file, yes/no, pick one or several), offer them as 2-3 concrete options, each with a short description of what it will do, instead of asking in prose; use `multiSelect` when several can apply. Do this for mid-task decisions too, not only at the end. Truly open-ended questions still go through the tool, with your best guesses as options.',
      '- Put the recommended option first and end its label with "(Recommended)". Always include a "Do nothing" option (leave it as is, take no further action). Do not add an "Other" or "Describe what to do" option: the tool already lets the user type their own answer.',
      '- Write the normal summary first; the question replaces only the "next step" sentence. If the user picks "Do nothing", stop and do not re-offer it.',
    ],
    vault: [
      'Vault',
      '- If the user needs to log in to Vault, suggest `! vault login -method=oidc` inline (it opens a browser, so it is the one thing a script cannot do).',
      '- A script that needs Vault checks `vault token lookup >/dev/null 2>&1` first and, if not logged in, runs `vault login -method=oidc` before continuing.',
    ],
    notes: [
      'Notes',
      '- If the workspace has a note, add each `!` line you hand the user, and any manual step they need to take, to it (manual steps as checkboxes). When they say "make a note for me" or "@todo", add that too.',
    ],
  };
}

const HEADER = 'Rules for this session (work-hub shows your messages to the user and builds features on their shape):';

/**
 * The rules as the text added to every session's prompt: the header, then each enabled section (all but `OFF_BY_DEFAULT` by default), then
 * your own rules. Nothing at all when every section is off and there are no extra rules.
 */
export function rulesLines(scriptsDir: string, opts: RuleOptions = {}): string[] {
  const sections = sectionLines(scriptsDir);
  const body: string[] = [];
  for (const id of RULE_SECTIONS) {
    if (opts[id] === false || (OFF_BY_DEFAULT.has(id) && opts[id] !== true)) continue;
    body.push('', ...sections[id]);
  }
  const extra = (opts.extra ?? '').trim();
  if (extra) body.push('', 'Your own rules', ...extra.split('\n').map((l) => l.trimEnd()));
  return body.length ? [HEADER, ...body] : [];
}

/**
 * Where the skill (sessions started by hand, which can't know the server's state dir) points scripts: the default
 * state dir. Sessions the app starts get the real folder in their prompt.
 */
export const DEFAULT_SCRIPTS_DIR = '~/.local/state/work-hub/plugins/app-rules/scripts';

/** The default-folder rules; the skill body is these lines. */
export const RULES_LINES: string[] = rulesLines(DEFAULT_SCRIPTS_DIR);

/** The fragment text: the rules, one line per entry, with scripts going under `scriptsDir`. */
export function appRules(scriptsDir: string = DEFAULT_SCRIPTS_DIR, opts: RuleOptions = {}): string {
  return rulesLines(scriptsDir, opts).join('\n');
}
