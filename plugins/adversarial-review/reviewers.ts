import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Reviewers for the adversarial review (review.ts): the models that each
 * attack a branch's diff independently. Configured in a JSON file so another provider is one more entry,
 * no code change:
 *
 *   { "reviewers": [
 *     { "id": "opus", "label": "Claude Opus", "model": "opus" },
 *     { "id": "other", "label": "Some CLI", "command": ["some-cli", "review", "-"], "timeoutMs": 900000 }
 *   ] }
 *
 * A Claude entry (`model`) runs a headless, read-only `claude -p` in the worktree that fetches the diff
 * itself. A command entry gets the prompt plus the diff on stdin (it may have no tools) and prints its
 * findings on stdout. Pure and free of server config.
 */

export interface Reviewer {
  id: string;
  label: string;
  /** Claude model alias or id. Exactly one of `model` and `command` is set. */
  model: string | null;
  command: string[] | null;
  timeoutMs: number;
}

/** Headless reviewer runs are named with this so the sessions source hides them (they run inside a workspace's worktree and would be adopted). */
export const REVIEWER_RUN_PREFIX = 'wh-review:';

export const DEFAULT_REVIEWERS: Reviewer[] = [
  { id: 'fable', label: 'Claude Fable', model: 'fable', command: null, timeoutMs: 30 * 60_000 },
  { id: 'opus', label: 'Claude Opus', model: 'opus', command: null, timeoutMs: 30 * 60_000 },
  { id: 'sonnet', label: 'Claude Sonnet', model: 'sonnet', command: null, timeoutMs: 30 * 60_000 },
];

const ID_RE = /^[A-Za-z0-9][\w-]{0,39}$/;
const DEFAULT_TIMEOUT = 30 * 60_000;

/** Validate the file's contents; throws a message naming the bad entry. Disabled entries (`enabled: false`) are dropped. */
export function parseReviewers(raw: unknown): Reviewer[] {
  const list = (raw as { reviewers?: unknown })?.reviewers;
  if (!Array.isArray(list)) throw new Error('expected {"reviewers": [...]}');
  const seen = new Set<string>();
  const out: Reviewer[] = [];
  list.forEach((e, i) => {
    const r = e as Record<string, unknown>;
    const where = `reviewers[${i}]`;
    if (typeof r?.id !== 'string' || !ID_RE.test(r.id)) throw new Error(`${where}: "id" must be letters, digits, - or _`);
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id "${r.id}"`);
    seen.add(r.id);
    if (r.enabled === false) return;
    const hasModel = typeof r.model === 'string' && r.model.trim() !== '';
    const hasCmd = Array.isArray(r.command) && r.command.length > 0 && r.command.every((a) => typeof a === 'string' && a !== '');
    if (hasModel === hasCmd) throw new Error(`${where} (${r.id}): give exactly one of "model" (a Claude model) or "command" (an argv array)`);
    const timeoutMs = r.timeoutMs === undefined ? DEFAULT_TIMEOUT : Number(r.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error(`${where} (${r.id}): "timeoutMs" must be at least 1000`);
    out.push({
      id: r.id,
      label: typeof r.label === 'string' && r.label ? r.label : r.id,
      model: hasModel ? String(r.model).trim() : null,
      command: hasCmd ? (r.command as string[]) : null,
      timeoutMs,
    });
  });
  if (out.length === 0) throw new Error('no enabled reviewers');
  return out;
}

/** The configured reviewers, or the Claude defaults when the file doesn't exist. A broken file is an error, not a silent fallback. */
export async function loadReviewers(file: string): Promise<Reviewer[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_REVIEWERS;
    throw e;
  }
  try {
    return parseReviewers(JSON.parse(text));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

/** What each reviewer is told. `diffCommand` is how it gets the diff itself; `inlineDiff` is set for command reviewers. */
export function reviewerPrompt(opts: { diffCommand: string; baseRef: string; inlineDiff?: string; guidance?: { path: string; section: string | null } | null }): string {
  return [
    'You are an adversarial code reviewer. Another engineer wrote the change below and believes it is done. Assume it contains bugs and find them.',
    'Your job is to break it, not to praise it: do not summarize the change, do not list style nits, and do not pad. Every finding must be real and specific.',
    '',
    opts.inlineDiff
      ? 'The change is the diff at the end of this message (the branch against its base).'
      : `The change is the branch against its base \`${opts.baseRef}\`. Get it with \`${opts.diffCommand}\`, then read the surrounding code, callers and tests with the tools you have. You are read-only: never edit, commit or push.`,
    '',
    ...(opts.guidance
      ? [
          `This repo has its own review guidance: \`${opts.guidance.path}\`${opts.guidance.section ? ` (the section "${opts.guidance.section}")` : ''}. Read it first and follow it: its criteria and severity scale take priority over the angles below.`,
          'Be adversarial in how you apply it.',
          '',
        ]
      : []),
    'Attack it from each of these angles:',
    '- Correctness: wrong logic, off-by-one, bad null/empty handling, error paths, races, resource leaks, broken invariants, behaviour changes the author may not have intended.',
    '- Security: injection, authz/authn gaps, unsafe input handling, secrets, path traversal, SSRF, trust boundaries.',
    '- Tests and edge cases: what is untested, what would a hostile or unusual input do, what fails at scale or under failure of a dependency.',
    '- Design: wrong abstraction, duplicated logic, coupling, anything that will hurt the next person, and anything the change forgot to update (docs, config, callers, migrations).',
    '',
    'Output Markdown only. For each finding:',
    '### [Critical|High|Medium|Low] Short title (`path/to/file:line`)',
    '- What is wrong, in one or two sentences.',
    '- How it breaks: a concrete input, state or sequence that triggers it.',
    '- Confidence: high, medium or low, and what you checked.',
    'Order findings most severe first. If you genuinely find nothing, say "No findings" and list what you checked.',
    ...(opts.inlineDiff ? ['', '<diff>', opts.inlineDiff, '</diff>'] : []),
  ].join('\n');
}

export const READ_ONLY_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*),Bash(git status:*),Bash(git merge-base:*),Bash(git ls-files:*)';

/** Run one command to completion with `input` on stdin; resolves stdout, rejects on non-zero exit, timeout or spawn failure. */
function runCapture(argv: string[], cwd: string, input: string | null, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 60_000)} min`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exited ${code}: ${(err || out).trim().split('\n').slice(-5).join(' | ').slice(0, 400)}`));
    });
    if (input !== null) child.stdin!.end(input);
  });
}

const MAX_INLINE_DIFF = 400_000;

/** Run one reviewer against a worktree; resolves its Markdown findings. */
export async function runReviewer(r: Reviewer, ctx: { worktree: string; baseRef: string; guidance?: { path: string; section: string | null } | null }): Promise<string> {
  const diffCommand = `git diff ${ctx.baseRef}...HEAD`;
  if (r.model) {
    const prompt = reviewerPrompt({ diffCommand, baseRef: ctx.baseRef, guidance: ctx.guidance });
    const args = ['-p', prompt, '--model', r.model, '--name', `${REVIEWER_RUN_PREFIX}${r.id}`, '--no-session-persistence', '--strict-mcp-config', '--allowedTools', READ_ONLY_TOOLS, '--max-turns', '80'];
    const out = await runCapture(['claude', ...args], ctx.worktree, null, r.timeoutMs);
    if (!out.trim()) throw new Error('empty answer');
    return out.trim();
  }
  const diff = await runCapture(['git', 'diff', `${ctx.baseRef}...HEAD`], ctx.worktree, null, 60_000);
  const clipped = diff.length > MAX_INLINE_DIFF ? `${diff.slice(0, MAX_INLINE_DIFF)}\n[diff truncated at ${MAX_INLINE_DIFF} characters]\n` : diff;
  const out = await runCapture(r.command!, ctx.worktree, reviewerPrompt({ diffCommand, baseRef: ctx.baseRef, inlineDiff: clipped, guidance: ctx.guidance }), r.timeoutMs);
  if (!out.trim()) throw new Error('empty answer');
  return out.trim();
}
