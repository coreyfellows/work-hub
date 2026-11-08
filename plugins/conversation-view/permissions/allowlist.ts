import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The tool-permission allowlist for sessions work-hub starts: Claude Code permission rules (`Read`, `Bash(git log:*)`,
 * `mcp__server__tool`…) passed as `--settings {"permissions":{"allow":[…]}}`, so those calls never stop at a prompt.
 * Edited in Settings → Session permissions; saved as JSON in the plugin's state folder. Pure parts are tested.
 */

/** What sessions get until you change it: the routine steps work-hub's own rules ask sessions to take, and read-only checks. */
export function defaultRules(paths: { whBin: string; ticketWorkflowScripts?: string }): string[] {
  return [
    `Bash(${paths.whBin}:*)`,
    ...(paths.ticketWorkflowScripts ? [`Bash(${paths.ticketWorkflowScripts.replace(/\/+$/, '')}/trust-worktree.sh:*)`] : []),
    'Bash(git worktree add:*)',
    'Bash(git worktree list:*)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git branch:*)',
    'Bash(git fetch:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(claude --bg:*)',
    'Bash(claude agents:*)',
    'Bash(claude logs:*)',
    'Bash(gh pr view:*)',
    'Bash(gh pr list:*)',
    'Bash(gh pr checks:*)',
    'Bash(gh pr diff:*)',
    'Bash(pnpm test:*)',
    'Bash(pnpm typecheck:*)',
    'Bash(npm test:*)',
  ];
}

export const MAX_RULES = 200;
const MAX_RULE_LENGTH = 500;
/** A tool name (`Read`, `mcp__server__tool`), optionally with a specifier in parentheses (`Bash(npm run test:*)`). */
const RULE = /^[A-Za-z][\w.-]*(\(.+\))?$/s;

export type RulesCheck = { ok: true; rules: string[] } | { ok: false; error: string };

/** Trims, drops blanks and duplicates, and refuses anything that isn't a single permission rule. */
export function checkRules(input: unknown): RulesCheck {
  if (!Array.isArray(input)) return { ok: false, error: 'rules must be a list' };
  const rules: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'every rule must be text' };
    const r = raw.trim();
    if (!r) continue;
    if (/[\r\n]/.test(r)) return { ok: false, error: 'one rule per line' };
    if (r.length > MAX_RULE_LENGTH) return { ok: false, error: `rule too long: ${r.slice(0, 40)}…` };
    if (!RULE.test(r)) return { ok: false, error: `not a permission rule: ${r} (e.g. Read, Bash(git log:*), mcp__server__tool)` };
    if (!rules.includes(r)) rules.push(r);
  }
  if (rules.length > MAX_RULES) return { ok: false, error: `at most ${MAX_RULES} rules` };
  return { ok: true, rules };
}

/** The `claude` arguments for a start; none when the list is empty. */
export function allowArgs(rules: string[]): string[] {
  return rules.length ? ['--settings', JSON.stringify({ permissions: { allow: rules } })] : [];
}

interface Saved {
  rules: string[];
}

/** The saved list, or null when it was never changed (or the file is unreadable: defaults then apply). */
export async function loadRules(file: string): Promise<string[] | null> {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Saved;
    const r = checkRules(saved.rules);
    return r.ok ? r.rules : null;
  } catch {
    return null;
  }
}

/** Saves the list (temp file + rename), or with null goes back to the defaults. */
export async function saveRules(file: string, rules: string[] | null): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  if (rules === null) {
    await writeFile(tmp, '{}\n', { mode: 0o600 });
  } else {
    await writeFile(tmp, `${JSON.stringify({ rules } satisfies Saved, null, 2)}\n`, { mode: 0o600 });
  }
  await rename(tmp, file);
}
