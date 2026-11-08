import type { PermissionPrompt } from './prompt.ts';

/**
 * The allowlist rule a permission prompt could be remembered as, for the "Always allow" button. Only Bash commands that
 * are one plain command get one: anything compound or redirected can't be generalised safely from the screen, and
 * other tools' prompts aren't shown in a form that maps reliably to a rule (Claude's own "don't ask again" choice
 * stays available for those).
 */

/** Programs whose first argument is the real verb, so the rule covers `git log`, not every `git`. */
const SUBCOMMAND_TOOLS = new Set(['git', 'gh', 'pnpm', 'npm', 'yarn', 'npx', 'claude', 'docker', 'kubectl', 'cargo', 'go', 'make', 'terraform', 'helm', 'aws', 'vault']);
/** Too broad as a prefix: the rule is that exact command instead. */
const EXACT_ONLY = new Set(['rm', 'sudo', 'sh', 'bash', 'zsh', 'eval', 'exec', 'curl', 'wget', 'ssh', 'scp', 'dd', 'chmod', 'chown', 'mv', 'cp', 'kill', 'pkill', 'killall', 'python', 'python3', 'node', 'perl', 'ruby', 'xargs', 'env', 'find', 'source', 'open', 'osascript', 'tee', 'truncate', 'shred', 'ln']);
const SHELL_SYNTAX = /&&|\|\||[;|<>`\n\\]|\$\(|\$\{/;

export function allowRuleFor(prompt: Pick<PermissionPrompt, 'title' | 'body'>): string | null {
  if (!/^bash\b/i.test(prompt.title)) return null;
  // The body is the command, then (when Claude gave one) its description on the next line: the command is the first line.
  const command = prompt.body.find((l) => l.trim())?.trim();
  if (!command || SHELL_SYNTAX.test(command)) return null;
  if ((command.match(/["']/g) ?? []).length % 2 === 1) return null;
  const words = command.split(/\s+/);
  if (/^[A-Za-z_]\w*=/.test(words[0])) return null; // env-prefixed
  if (words[0].includes('(') || words[0].includes(')')) return null;
  if (EXACT_ONLY.has(words[0].replace(/^.*\//, ''))) return `Bash(${command})`;
  if (SUBCOMMAND_TOOLS.has(words[0])) {
    if (words.length < 2) return `Bash(${command})`;
    if (words[1].startsWith('-')) return null; // `git -C dir …`: the verb isn't second
    return `Bash(${words[0]} ${words[1]}:*)`;
  }
  return `Bash(${words[0]}:*)`;
}

/** The choice that makes Claude itself remember this for the running session ("Yes, and don't ask again for …"), if offered. */
export function rememberOption(prompt: Pick<PermissionPrompt, 'options'>): PermissionPrompt['options'][number] | undefined {
  return prompt.options.find((o) => o.n > 1 && /^yes\b.*(don'?t|do not|never)\s+ask\s+again|^yes,?\s+and\s+always\b|^yes,?\s+allow\s+all\b/i.test(o.label));
}
