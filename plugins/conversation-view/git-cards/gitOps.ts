import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseDiff, run, type FileEdit } from '../../../plugin-api/server.ts';

/**
 * Git commands a session ran through Bash, pulled out so the log can show them (commits, files staged/removed,
 * pushes, merges…) instead of folding them into "⋯ N steps". The command line is parsed statically (following
 * `cd X &&` and `git -C X`); once the call has a result, commits and other HEAD moves are read from that repo's
 * reflog within the call's time window, so quiet commits (`git commit -q`) show too, with their files.
 */

export interface GitCommit {
  sha: string;
  subject: string;
  files: Array<{ path: string; status: string; add: number | null; del: number | null }>;
}

export interface GitOp {
  /** The git subcommand (commit, add, push…). */
  sub: string;
  /** What happened, e.g. "Committed", "Staged", "Pushed". */
  verb: string;
  /** A short object for the verb: branch, remote, "all changes"… */
  detail?: string;
  /** Paths named on the command line (add / rm / mv / restore). */
  files?: string[];
  /** The repo directory the command ran in. */
  dir: string;
  /** Commits it made (commit, merge, pull, cherry-pick, revert, rebase, am), from the reflog. */
  commits?: GitCommit[];
  /** Other HEAD moves from the reflog ("checkout: moving from a to b", "reset: moving to HEAD~1"). */
  moves?: string[];
  /** Ref updates a push reported ("main -> main", "[new branch] x -> x"). */
  refs?: string[];
}

// `add` is left out on purpose: staging is noise in the log (the commit that follows lists the files).
const WRITE_SUBS = new Set([
  'commit', 'rm', 'mv', 'restore', 'push', 'pull', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'stash',
  'cherry-pick', 'revert', 'tag', 'branch', 'worktree', 'apply', 'am', 'clone', 'init',
]);
/** Subcommands whose result is best described by the reflog (they move HEAD). */
const MOVES_HEAD = new Set(['commit', 'pull', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'cherry-pick', 'revert', 'am']);

/** Shell-ish split into segments of words (quotes, escapes, &&/||/;/|/newline; heredoc bodies skipped). */
function segments(cmd: string): string[][] {
  const out: string[][] = [];
  let seg: string[] = [];
  let word = '';
  let inWord = false;
  const heredocs: string[] = [];
  const endWord = () => {
    if (inWord) seg.push(word);
    word = '';
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (seg.length) out.push(seg);
    seg = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === '\\' && i + 1 < cmd.length) {
      word += cmd[++i];
      inWord = true;
    } else if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, j < 0 ? cmd.length : j);
      inWord = true;
      i = j < 0 ? cmd.length : j;
    } else if (ch === '"') {
      let j = i + 1;
      let depth = 0;
      while (j < cmd.length && (cmd[j] !== '"' || depth > 0)) {
        if (cmd[j] === '\\') j++;
        else if (cmd.startsWith('$(', j)) depth++;
        else if (cmd[j] === ')' && depth > 0) depth--;
        j++;
      }
      word += cmd.slice(i + 1, j);
      inWord = true;
      i = j;
    } else if (ch === '<' && cmd[i + 1] === '<') {
      endWord();
      const m = /^<<-?\s*(['"]?)([\w-]+)\1/.exec(cmd.slice(i));
      if (m) {
        heredocs.push(m[2]!);
        i += m[0].length - 1;
      } else i++;
    } else if (ch === '\n') {
      endSeg();
      // Skip heredoc bodies that start after this line.
      while (heredocs.length) {
        const delim = heredocs.shift()!;
        const re = new RegExp(`\\n\\s*${delim}\\s*(?=\\n|$)`, 'g');
        re.lastIndex = i;
        const m = re.exec(cmd);
        i = m ? m.index + m[0].length - 1 : cmd.length;
      }
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      endSeg();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endSeg();
  return out;
}

const expand = (p: string, cwd: string) => {
  const q = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(q) ? q : resolve(cwd, q);
};

/** The git operations in a Bash command line (without reflog details yet). */
export function parseGitOps(command: string, cwd: string): GitOp[] {
  const ops: GitOp[] = [];
  let dir = cwd;
  for (let words of segments(command)) {
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0]!)) words = words.slice(1);
    if (words[0] === 'cd' && words[1]) {
      dir = expand(words[1], dir);
      continue;
    }
    if (words[0] !== 'git') continue;
    let i = 1;
    let gdir = dir;
    for (; i < words.length && words[i]!.startsWith('-'); i++) {
      if (words[i] === '-C' && words[i + 1]) gdir = expand(words[++i]!, gdir);
      else if (words[i] === '-c') i++;
    }
    const sub = words[i];
    if (!sub || !WRITE_SUBS.has(sub)) continue;
    // Drop redirections (`2>&1`, `> out`, `2>/dev/null`); a bare operator takes the next word with it.
    const args: string[] = [];
    for (let k = i + 1; k < words.length; k++) {
      const w = words[k]!;
      if (/^(\d*|&)(>>?|<)(&\d*-?)?$/.test(w)) k++;
      else if (!/^(\d*|&)(>>?|<)/.test(w)) args.push(w);
    }
    const op = describe(sub, args, gdir);
    if (op) ops.push(op);
  }
  return ops;
}

const positional = (args: string[], valueFlags: string[] = []) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
};

function describe(sub: string, args: string[], dir: string): GitOp | null {
  const has = (...f: string[]) => args.some((a) => f.includes(a));
  const op = (verb: string, extra: Partial<GitOp> = {}): GitOp => ({ sub, verb, dir, ...extra });
  switch (sub) {
    case 'commit':
      return op(has('--amend') ? 'Amended commit' : 'Committed');
    case 'add': {
      const files = positional(args);
      if (has('-A', '--all', '-u', '--update') || files.includes('.') || !files.length) return op('Staged', { detail: 'all changes' });
      return op('Staged', { files });
    }
    case 'rm':
      return op(has('--cached') ? 'Untracked' : 'Removed', { files: positional(args) });
    case 'mv': {
      const p = positional(args);
      return op('Moved', { files: p, detail: p.length === 2 ? `${p[0]} → ${p[1]}` : undefined });
    }
    case 'restore':
      return op(has('--staged', '-S') && !has('--worktree', '-W') ? 'Unstaged' : 'Discarded changes to', { files: positional(args, ['-s', '--source']) });
    case 'push': {
      const p = positional(args, ['-o', '--push-option', '--repo']);
      const del = has('-d', '--delete');
      return op(del ? 'Deleted remote branch' : has('-f', '--force', '--force-with-lease') ? 'Force-pushed' : 'Pushed', {
        detail: p.length ? p.join(' ') : undefined,
      });
    }
    case 'pull':
      return op('Pulled', { detail: positional(args).join(' ') || undefined });
    case 'merge':
      return has('--abort') ? op('Aborted merge') : op('Merged', { detail: positional(args, ['-m', '-s', '-X', '-F']).join(' ') || undefined });
    case 'rebase':
      return op(has('--abort') ? 'Aborted rebase' : has('--continue') ? 'Continued rebase' : 'Rebased', { detail: positional(args, ['--onto']).join(' ') || undefined });
    case 'reset': {
      const p = positional(args);
      if (!has('--hard', '--soft', '--mixed', '--keep', '--merge') && p.length && !/^(HEAD|[0-9a-f]{7,}|@)/.test(p[0]!)) return op('Unstaged', { files: p });
      return op(`Reset${has('--hard') ? ' (hard)' : has('--soft') ? ' (soft)' : ''}`, { detail: p[0] ?? 'HEAD' });
    }
    case 'checkout':
    case 'switch': {
      const dash = args.indexOf('--');
      if (dash >= 0) return op('Discarded changes to', { files: args.slice(dash + 1) });
      const create = args.find((a) => a === '-b' || a === '-B' || a === '-c' || a === '-C');
      const p = positional(args, ['-b', '-B', '-c', '-C']);
      const name = create ? args[args.indexOf(create) + 1] : p[0];
      return op(create ? 'Created branch' : 'Switched to', { detail: name });
    }
    case 'stash': {
      const action = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
      const verbs: Record<string, string> = { push: 'Stashed changes', save: 'Stashed changes', pop: 'Popped stash', apply: 'Applied stash', drop: 'Dropped stash', clear: 'Cleared stashes' };
      return verbs[action] ? op(verbs[action]!) : null;
    }
    case 'cherry-pick':
      return op('Cherry-picked', { detail: positional(args).join(' ') || undefined });
    case 'revert':
      return op('Reverted', { detail: positional(args).join(' ') || undefined });
    case 'tag': {
      if (has('-l', '--list') || !positional(args, ['-m', '-F', '-u']).length) return null;
      return op(has('-d', '--delete') ? 'Deleted tag' : 'Tagged', { detail: positional(args, ['-m', '-F', '-u'])[0] });
    }
    case 'branch': {
      const p = positional(args, ['-u', '--set-upstream-to']);
      if (has('-d', '-D', '--delete')) return op('Deleted branch', { detail: p.join(', ') });
      if (has('-m', '-M', '--move')) return op('Renamed branch', { detail: p.join(' → ') });
      if (has('-u', '--set-upstream-to')) return op('Set upstream', { detail: args[args.findIndex((a) => a === '-u' || a === '--set-upstream-to') + 1] });
      if (has('--list', '-l', '-a', '-r', '-v', '-vv', '--show-current', '--contains', '--merged', '--no-merged', '--format') || !p.length) return null;
      return op('Created branch', { detail: p[0] });
    }
    case 'worktree': {
      const action = args[0];
      const p = positional(args.slice(1), ['-b', '-B']);
      if (action === 'add') return op('Added worktree', { detail: p[0] });
      if (action === 'remove') return op('Removed worktree', { detail: p[0] });
      return null;
    }
    case 'apply':
      return has('--check', '--stat', '--numstat') ? null : op('Applied patch', { detail: positional(args).join(' ') || undefined });
    case 'am':
      return op('Applied mailbox patches');
    case 'clone':
      return op('Cloned', { detail: positional(args, ['-b', '--branch', '--depth', '-o', '--origin'])[0] });
    case 'init':
      return op('Initialised repo', { detail: positional(args)[0] });
  }
  return null;
}

const SHA = /^[0-9a-f]{40,64}$/;

/** Reflog entries of `dir`'s HEAD between two times (inclusive, with a little slack), oldest first. */
const reflogCache = new Map<string, { at: number; out: Promise<string> }>();

/** `dir`'s HEAD reflog (newest first), cached a few seconds so a transcript's first load reads each repo once. */
function readReflog(dir: string): Promise<string> {
  const hit = reflogCache.get(dir);
  if (hit && Date.now() - hit.at < 5000) return hit.out;
  const out = run('git', ['-C', dir, 'reflog', '-n', '3000', '--date=iso-strict', '--format=%H%x09%gd%x09%gs'], { timeoutMs: 5000 }).catch(() => '');
  reflogCache.set(dir, { at: Date.now(), out });
  if (reflogCache.size > 50) reflogCache.delete(reflogCache.keys().next().value!);
  return out;
}

async function reflogBetween(dir: string, from: number, to: number): Promise<Array<{ sha: string; subject: string }>> {
  const out = await readReflog(dir);
  const rows: Array<{ sha: string; subject: string }> = [];
  for (const line of out.split('\n')) {
    const [sha, gd, subject] = line.split('\t');
    const m = /@\{(.+)\}$/.exec(gd ?? '');
    const t = m ? Date.parse(m[1]!) : NaN;
    if (!sha || !SHA.test(sha) || !subject || Number.isNaN(t)) continue;
    if (t >= from - 1500 && t <= to + 1500) rows.push({ sha, subject });
  }
  return rows.reverse();
}

async function commitInfo(dir: string, sha: string, subjectHint: string): Promise<GitCommit> {
  const info: GitCommit = { sha: sha.slice(0, 7), subject: subjectHint, files: [] };
  try {
    const head = await run('git', ['-C', dir, 'show', '-s', '--format=%h%x09%s', sha], { timeoutMs: 5000 });
    const [h, s] = head.trim().split('\t');
    if (h) info.sha = h;
    if (s) info.subject = s;
    // Against the first parent (so merges list what they brought in); a root commit has none.
    const base = (await run('git', ['-C', dir, 'rev-parse', '-q', '--verify', `${sha}^1`], { timeoutMs: 5000 }).catch(() => '')).trim();
    const range = base ? [base, sha] : ['--root', sha];
    const cmd = base ? 'diff' : 'diff-tree';
    const extra = base ? [] : ['-r'];
    const [ns, num] = await Promise.all([
      run('git', ['-C', dir, cmd, ...extra, '--no-renames', '--name-status', ...range], { timeoutMs: 5000 }),
      run('git', ['-C', dir, cmd, ...extra, '--no-renames', '--numstat', ...range], { timeoutMs: 5000 }),
    ]);
    const counts = new Map<string, [number | null, number | null]>();
    for (const l of num.split('\n')) {
      const [a, d, p] = l.split('\t');
      if (p) counts.set(p, [a === '-' ? null : Number(a), d === '-' ? null : Number(d)]);
    }
    for (const l of ns.split('\n')) {
      const [st, p] = l.split('\t');
      if (!st || !p || SHA.test(st)) continue;
      const [add, del] = counts.get(p) ?? [null, null];
      info.files.push({ path: p, status: st[0]!, add, del });
    }
    info.files = info.files.slice(0, 200);
  } catch {
    /* keep what we have */
  }
  return info;
}

/** What `git push` reported: lines like "   abc..def  main -> main" or " * [new branch]  x -> x". */
export function pushRefs(result: string): string[] {
  const refs: string[] = [];
  for (const l of result.split('\n')) {
    const m = /^\s*[*+!=\s-]?\s*(\[[^\]]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+)\s+(\S+\s+->\s+\S+)/.exec(l);
    if (m) refs.push(m[1]!.startsWith('[') ? `${m[1]} ${m[2]}` : m[2]!);
  }
  return refs;
}

/** Fills in commits / HEAD moves (from the reflog) and push refs (from the output) once the call has finished. */
export async function resolveGitOps(ops: GitOp[], result: string, startedAt: string | null, doneAt: string | null): Promise<GitOp[]> {
  const from = Date.parse(startedAt ?? '');
  const to = Date.parse(doneAt ?? '') || from;
  const byDir = new Map<string, Promise<Array<{ sha: string; subject: string }>>>();
  const reflog = (dir: string) => {
    if (!byDir.has(dir)) byDir.set(dir, Number.isNaN(from) ? Promise.resolve([]) : reflogBetween(dir, from, to));
    return byDir.get(dir)!;
  };
  const claimed = new Set<string>();
  const out: GitOp[] = [];
  for (const op of ops) {
    const o = { ...op };
    if (o.sub === 'push') o.refs = pushRefs(result);
    if (MOVES_HEAD.has(o.sub)) {
      const rows = (await reflog(o.dir)).filter((r) => !claimed.has(`${o.dir}|${r.sha}|${r.subject}`));
      const mine = rows.filter((r) => reflogMatches(o.sub, r.subject));
      for (const r of mine) claimed.add(`${o.dir}|${r.sha}|${r.subject}`);
      const commitRows = mine.filter((r) => /^(commit|merge|pull|cherry-pick|revert|rebase \(finish\)|am)\b/.test(r.subject) && !/Fast-forward$/.test(r.subject));
      const ffRows = mine.filter((r) => /Fast-forward$/.test(r.subject));
      o.commits = await Promise.all(commitRows.map((r) => commitInfo(o.dir, r.sha, r.subject.replace(/^[^:]+:\s*/, ''))));
      const moves = mine.filter((r) => !commitRows.includes(r) && !ffRows.includes(r)).map((r) => r.subject);
      if (moves.length) o.moves = moves;
      if (ffRows.length) o.detail = [o.detail, 'fast-forward'].filter(Boolean).join(' · ');
    }
    out.push(o);
  }
  return out;
}

/** Whether a reflog subject ("commit (amend): x", "merge foo: Fast-forward", "checkout: moving…") belongs to `sub`. */
function reflogMatches(sub: string, subject: string): boolean {
  const kind = subject.split(/[:(]/)[0]!.trim();
  if (sub === 'commit') return kind === 'commit';
  if (sub === 'switch' || sub === 'checkout') return kind === 'checkout' || kind === 'switch';
  if (sub === 'rebase') return kind.startsWith('rebase');
  if (sub === 'pull') return kind.startsWith('pull') || kind.startsWith('rebase');
  return kind === sub || kind.startsWith(`${sub} `);
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A commit's changes (vs its first parent; a root commit vs the empty tree) as FileEdits, for the log's diff view. */
export async function commitDiff(dir: string, sha: string): Promise<FileEdit[]> {
  if (!/^[0-9a-f]{7,64}$/.test(sha) || !isAbsolute(dir)) return [];
  const top = (await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })).trim();
  const base = (await run('git', ['-C', top, 'rev-parse', '-q', '--verify', `${sha}^1`], { timeoutMs: 5000 }).catch(() => '')).trim() || EMPTY_TREE;
  const diff = await run('git', ['-C', top, 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U2', base, sha], { timeoutMs: 10_000 });
  if (diff.length > 2_000_000) return [];
  return parseDiff(diff, top, null);
}
